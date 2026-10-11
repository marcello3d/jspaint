// @ts-check
/* global pako, UPNG */
// JSPaint.exe animation files (.p95): container encoding/decoding and canvas hashing.
// See docs/2draw-animation-format.md

export const MAGIC = "P95A";
export const CONTAINER_VERSION = 1;
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
 * @param {P95File} file
 * @returns {Uint8Array}
 */
export function encode_p95(file) {
	const json_bytes = new TextEncoder().encode(JSON.stringify(file.header));
	const deflated = pako.deflate(json_bytes);
	let total = 8 + 4 + deflated.length + 4;
	for (const blob of file.blobs) {
		total += 4 + blob.length;
	}
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	for (let i = 0; i < 4; i++) {
		out[i] = MAGIC.charCodeAt(i);
	}
	out[4] = CONTAINER_VERSION;
	let offset = 8;
	view.setUint32(offset, deflated.length, true);
	offset += 4;
	out.set(deflated, offset);
	offset += deflated.length;
	view.setUint32(offset, file.blobs.length, true);
	offset += 4;
	for (const blob of file.blobs) {
		view.setUint32(offset, blob.length, true);
		offset += 4;
		out.set(blob, offset);
		offset += blob.length;
	}
	return out;
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
	if (bytes[4] !== CONTAINER_VERSION) {
		throw new Error(`Unsupported animation container version ${bytes[4]}`);
	}
	let offset = 8;
	const json_length = view.getUint32(offset, true);
	offset += 4;
	const header = JSON.parse(new TextDecoder().decode(pako.inflate(bytes.subarray(offset, offset + json_length))));
	offset += json_length;
	if (header.format !== FORMAT_VERSION) {
		throw new Error(`Unsupported animation format version ${header.format}`);
	}
	const blob_count = view.getUint32(offset, true);
	offset += 4;
	const blobs = [];
	for (let i = 0; i < blob_count; i++) {
		const length = view.getUint32(offset, true);
		offset += 4;
		blobs.push(bytes.slice(offset, offset + length));
		offset += length;
	}
	return { header, blobs };
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
