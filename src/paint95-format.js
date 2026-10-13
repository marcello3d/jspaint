// @ts-check
/* global pako, UPNG */
// JSPaint.exe animation files (.p95): container encoding/decoding and canvas hashing.
// See docs/2draw-animation-format.md

import { decode_events, encode_events } from "./paint95-events.js";

export const MAGIC = "P95A";
/** 2: binary event streams (paint95-events.js); 1 (JSON events) is still read */
export const CONTAINER_VERSION = 2;
export const FORMAT_VERSION = 1;

/**
 * @typedef {any[]} P95Event
 * @typedef {{
 *   seed: number,
 *   engine: { sha: string, behavior: number },
 *   width: number,
 *   height: number,
 *   start: { type: "blank" } | { type: "image", blob: number } | { type: "continue", hash: number },
 *   events: P95Event[],
 *   duration: number,
 *   truncated?: boolean,
 *   end?: { hash: number, width: number, height: number, blob: number | null },
 * }} P95Segment
 * @typedef {{
 *   format: number,
 *   engine: { sha: string, behavior: number },
 *   width: number,
 *   height: number,
 *   truncated: boolean,
 *   segments: P95Segment[],
 * }} P95Header
 * @typedef {{ header: P95Header, blobs: Uint8Array[] }} P95File
 */

/**
 * FNV-1a over the RGBA pixel data as 32-bit little-endian words, mixed with the dimensions.
 * @param {ImageData | {data: Uint8ClampedArray, width: number, height: number}} image_data
 * @returns {number} unsigned 32-bit
 */
export function hash_image_data(image_data) {
	const { data, width, height } = image_data;
	const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
	let h = 0x811c9dc5;
	h = Math.imul(h ^ width, 0x01000193);
	h = Math.imul(h ^ height, 0x01000193);
	for (let i = 0; i < words.length; i++) {
		h = Math.imul(h ^ words[i], 0x01000193);
	}
	return h >>> 0;
}

/**
 * Writes the container: magic, version, u32 LE header length, deflated JSON header,
 * [v2: per segment u32 LE length + event payload,] u32 LE blob count, (u32 LE length, bytes)*.
 * @param {P95File} file
 * @param {number} [version] - 2 (default); 1 only for tests/tools
 * @returns {Uint8Array}
 */
export function encode_p95(file, version = CONTAINER_VERSION) {
	let header = file.header;
	/** @type {Uint8Array[]} */
	const event_payloads = [];
	if (version >= 2) {
		header = {
			...file.header,
			segments: file.header.segments.map((segment) => {
				event_payloads.push(encode_event_payload(segment.events));
				return { ...segment, events: null, event_count: segment.events.length };
			}),
		};
	}
	const json_bytes = new TextEncoder().encode(JSON.stringify(header));
	const deflated = pako.deflate(json_bytes);
	let total = 8 + 4 + deflated.length + 4;
	for (const payload of event_payloads) {
		total += 4 + payload.length;
	}
	for (const blob of file.blobs) {
		total += 4 + blob.length;
	}
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	for (let i = 0; i < 4; i++) {
		out[i] = MAGIC.charCodeAt(i);
	}
	out[4] = version;
	let offset = 8;
	const put = (bytes) => {
		view.setUint32(offset, bytes.length, true);
		offset += 4;
		out.set(bytes, offset);
		offset += bytes.length;
	};
	put(deflated);
	for (const payload of event_payloads) {
		put(payload);
	}
	view.setUint32(offset, file.blobs.length, true);
	offset += 4;
	for (const blob of file.blobs) {
		put(blob);
	}
	return out;
}

/**
 * [u8 compression: 0 none, 1 zlib][event streams, possibly deflated]
 * @param {any[][]} events
 */
function encode_event_payload(events) {
	const raw = encode_events(events);
	const deflated = pako.deflate(raw);
	const compress = deflated.length < raw.length;
	const data = compress ? deflated : raw;
	const out = new Uint8Array(1 + data.length);
	out[0] = compress ? 1 : 0;
	out.set(data, 1);
	return out;
}

/** @param {Uint8Array} payload */
function decode_event_payload(payload) {
	const data = payload.subarray(1);
	return decode_events(payload[0] === 1 ? pako.inflate(data) : data);
}

/**
 * Sizes of the parts of an encoded file (for measuring).
 * @param {Uint8Array} bytes
 */
export function p95_section_sizes(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 8;
	const header_length = view.getUint32(offset, true);
	offset += 4 + header_length;
	let events = 0;
	if (bytes[4] >= 2) {
		const header = JSON.parse(new TextDecoder().decode(pako.inflate(bytes.subarray(12, 12 + header_length))));
		for (let i = 0; i < header.segments.length; i++) {
			const length = view.getUint32(offset, true);
			events += 4 + length;
			offset += 4 + length;
		}
	}
	const blob_start = offset;
	return { total: bytes.length, header: 12 + header_length, events, blobs: bytes.length - blob_start };
}

/**
 * @param {ArrayBuffer | Uint8Array} buffer
 * @returns {P95File}
 */
export function decode_p95(buffer) {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const magic = String.fromCharCode(...bytes.subarray(0, 4));
	if (magic !== MAGIC) {
		throw new Error("Not a JSPaint.exe animation (bad magic)");
	}
	const version = bytes[4];
	if (version !== 1 && version !== 2) {
		throw new Error(`Unsupported animation container version ${version}`);
	}
	let offset = 8;
	const take = () => {
		const length = view.getUint32(offset, true);
		offset += 4;
		const out = bytes.subarray(offset, offset + length);
		offset += length;
		return out;
	};
	const header = JSON.parse(new TextDecoder().decode(pako.inflate(take())));
	if (header.format !== FORMAT_VERSION) {
		throw new Error(`Unsupported animation format version ${header.format}`);
	}
	if (version >= 2) {
		for (const segment of header.segments) {
			segment.events = decode_event_payload(take());
			delete segment.event_count;
		}
	}
	const blob_count = view.getUint32(offset, true);
	offset += 4;
	const blobs = [];
	for (let i = 0; i < blob_count; i++) {
		blobs.push(take().slice());
	}
	return { header, blobs, version };
}

/**
 * Decodes a PNG synchronously (with UPNG.js) to ImageData, exactly as stored (no color management or premultiplication).
 * @param {Uint8Array} png
 * @returns {ImageData}
 */
export function decode_png(png) {
	const image = UPNG.decode(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
	const rgba = new Uint8ClampedArray(UPNG.toRGBA8(image)[0]);
	return new ImageData(rgba, image.width, image.height);
}

/**
 * Encodes ImageData losslessly as PNG (with UPNG.js), byte-exact (no premultiplied alpha round trip).
 * @param {ImageData} image_data
 * @returns {Uint8Array}
 */
export function encode_png(image_data) {
	const { data, width, height } = image_data;
	const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
	return new Uint8Array(UPNG.encode([copy], width, height, 0));
}
