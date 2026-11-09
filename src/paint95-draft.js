// @ts-check
/* global main_canvas, main_ctx, pako */
// JSPaint.exe: a copy of the drawing in progress on this device (IndexedDB), keyed by the 2draw draft key
// (index.html?draft=<key>). Reloading, going back and forward, or reopening /draw/<key>/ restores it by replaying it
// (paint95-restore.js), so the undo history comes back too, and the recording carries on. See
// docs/2draw-animation-format.md, "Device drafts".
//
// What is stored is the recording so far, not the picture: the same segments and blobs a finalized .p95 holds,
// written in pieces so a save only writes what changed:
// - DB "2draw-paint95-drafts", store "drafts": one small record per draft key (the segment headers, the names of the
//   pieces, the current segment's last few events as a "tail", the canvas hash at the save, and when it was saved);
// - store "parts", keyed [draft key, name]: sealed event chunks (CHUNK_EVENTS events each, never rewritten), blobs
//   (PNG, written once), and a PNG snapshot of the canvas (at most every 20 s, and when the page is hidden: the
//   picture to set if replaying the copy ever drifts, used only if it was taken at the last save).
// Event chunks are encoded independently with encode_events (paint95-events.js), so decoding each and concatenating
// the events gives back the segment's events exactly.

import { decode_events, encode_events } from "./paint95-events.js";
import { FORMAT_VERSION, encode_png, hash_image_data } from "./paint95-format.js";

export const DB_NAME = "2draw-paint95-drafts";
const DB_VERSION = 1;
const DRAFTS = "drafts";
const PARTS = "parts";
/** Drafts not saved for this long are deleted when the editor loads. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Events per sealed chunk */
export const CHUNK_EVENTS = 2048;
/** Save this long after the last change */
export const SAVE_DELAY_MS = 1500;
/** A new snapshot at most this often (and when the page is hidden) */
export const SNAPSHOT_INTERVAL_MS = 20000;
const DRAFT_VERSION = 1;

/** A 2draw draft key (lib/drafts.ts): 12 lowercase Crockford base32 characters; anything URL-safe and short is accepted. */
export function valid_draft_key(key) {
	return typeof key === "string" && /^[0-9a-z_-]{4,64}$/.test(key);
}

// #region IndexedDB

/** @type {Promise<IDBDatabase> | null} */
let db_promise = null;

/** @returns {Promise<IDBDatabase>} */
export function open_db() {
	if (!db_promise) {
		db_promise = new Promise((resolve, reject) => {
			if (typeof indexedDB === "undefined") {
				reject(new Error("IndexedDB is not available"));
				return;
			}
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(DRAFTS)) {
					db.createObjectStore(DRAFTS, { keyPath: "key" });
				}
				if (!db.objectStoreNames.contains(PARTS)) {
					db.createObjectStore(PARTS, { keyPath: ["key", "name"] });
				}
			};
			request.onsuccess = () => {
				const db = request.result;
				// another tab upgrading: let it
				db.onversionchange = () => { db.close(); db_promise = null; };
				resolve(db);
			};
			request.onerror = () => reject(request.error);
			request.onblocked = () => reject(new Error("IndexedDB open blocked"));
		});
		db_promise.catch(() => { db_promise = null; });
	}
	return db_promise;
}

/** @param {IDBRequest} request */
const req = (request) => new Promise((resolve, reject) => {
	request.onsuccess = () => resolve(request.result);
	request.onerror = () => reject(request.error);
});

/** @param {IDBTransaction} tx */
const done = (tx) => new Promise((resolve, reject) => {
	tx.oncomplete = () => resolve(undefined);
	tx.onerror = () => reject(tx.error);
	tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
});

/** All parts of one draft */
const parts_range = (key) => IDBKeyRange.bound([key, ""], [key, "￿"]);

/**
 * Reads a draft: its record and every part, as a P95File for paint95-restore.js.
 * @param {string} key
 * @returns {Promise<null | { meta: any, file: import("./paint95-format.js").P95File, snapshot: Uint8Array | null, bytes: number }>}
 */
export async function load_draft(key) {
	const db = await open_db();
	const tx = db.transaction([DRAFTS, PARTS], "readonly");
	const [meta, parts] = await Promise.all([
		req(tx.objectStore(DRAFTS).get(key)),
		req(tx.objectStore(PARTS).getAll(parts_range(key))),
	]);
	if (!meta) {
		return null;
	}
	if (meta.v !== DRAFT_VERSION) {
		throw new Error(`Unsupported device draft version ${meta.v}`);
	}
	/** @type {Map<string, Uint8Array>} */
	const by_name = new Map();
	let bytes = 0;
	for (const part of parts) {
		by_name.set(part.name, to_bytes(part.data));
		bytes += part.data.byteLength;
	}
	const get = (name) => {
		const data = by_name.get(name);
		if (!data) {
			throw new Error(`Device draft is missing its part ${name}`);
		}
		return data;
	};
	const segments = meta.segments.map((/** @type {any} */ stored) => {
		const events = [];
		for (const name of stored.chunks) {
			events.push(...unpack_events(get(name)));
		}
		if (stored.tail) {
			events.push(...unpack_events(to_bytes(stored.tail)));
			bytes += stored.tail.byteLength;
		}
		return { ...stored.info, events };
	});
	const blobs = meta.blobs.map(get);
	const last = segments[segments.length - 1];
	const file = {
		header: {
			format: FORMAT_VERSION,
			engine: last.engine,
			width: last.width,
			height: last.height,
			truncated: !!meta.truncated || segments.some((s) => s.truncated),
			segments,
		},
		blobs,
	};
	// (only the picture at the save itself is any use: an older one would lose strokes)
	const snapshot = meta.snapshot && meta.snapshot.hash === meta.hash ? by_name.get(meta.snapshot.name) ?? null : null;
	return { meta, file, snapshot, bytes };
}

/** @param {any} data */
function to_bytes(data) {
	return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * Deletes a draft and its parts.
 * @param {string} key
 */
export async function delete_draft(key) {
	const db = await open_db();
	const tx = db.transaction([DRAFTS, PARTS], "readwrite");
	tx.objectStore(DRAFTS).delete(key);
	tx.objectStore(PARTS).delete(parts_range(key));
	await done(tx);
}

/**
 * Keeps an unreadable draft for 30 more days under another key (so a new session doesn't overwrite it), then deletes
 * it under its own key.
 * @param {string} key
 */
export async function set_draft_aside(key) {
	const db = await open_db();
	const tx = db.transaction([DRAFTS, PARTS], "readwrite");
	const drafts = tx.objectStore(DRAFTS);
	const parts = tx.objectStore(PARTS);
	const aside = `${key}~unreadable-${Date.now()}`;
	const meta = await req(drafts.get(key));
	if (meta) {
		const list = await req(parts.getAll(parts_range(key)));
		for (const part of list) {
			parts.put({ ...part, key: aside });
		}
		drafts.put({ ...meta, key: aside, set_aside: true });
		drafts.delete(key);
		parts.delete(parts_range(key));
	}
	await done(tx);
	return aside;
}

/**
 * Deletes drafts not saved for DRAFT_MAX_AGE_MS (all drafts in this database are this tool's).
 * @returns {Promise<number>} how many were deleted
 */
export async function expire_drafts(now = Date.now()) {
	const db = await open_db();
	const tx = db.transaction([DRAFTS, PARTS], "readwrite");
	const drafts = tx.objectStore(DRAFTS);
	const parts = tx.objectStore(PARTS);
	let count = 0;
	await new Promise((resolve, reject) => {
		const cursor_request = drafts.openCursor();
		cursor_request.onerror = () => reject(cursor_request.error);
		cursor_request.onsuccess = () => {
			const cursor = cursor_request.result;
			if (!cursor) {
				resolve(undefined);
				return;
			}
			const meta = cursor.value;
			if (!(typeof meta.saved === "number" && now - meta.saved < DRAFT_MAX_AGE_MS)) {
				parts.delete(parts_range(meta.key));
				cursor.delete();
				count++;
			}
			cursor.continue();
		};
	});
	await done(tx);
	return count;
}

// #endregion

// #region Event chunks

/** @param {any[][]} events */
export function pack_events(events) {
	return pako.deflate(encode_events(events));
}

/** @param {Uint8Array} bytes */
export function unpack_events(bytes) {
	return decode_events(pako.inflate(bytes));
}

// #endregion

/**
 * The segment's header fields, without its events (what a draft record keeps per segment).
 * @param {any} segment
 */
function segment_info(segment) {
	const { events: _events, _times, ...info } = segment;
	return JSON.parse(JSON.stringify(info));
}

/** Random id for this page load: names its parts, so two tabs on one draft never write over each other's pieces. */
function make_session_id() {
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** @param {HTMLCanvasElement} canvas */
function canvas_png(canvas) {
	return new Promise((resolve) => {
		try {
			canvas.toBlob((blob) => {
				if (!blob) {
					resolve(null);
					return;
				}
				blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), () => resolve(null));
			}, "image/png");
		} catch (_error) {
			resolve(null);
		}
	});
}

/**
 * Saves the recorder's work in progress to the device, a moment after each change, without ending the recording.
 */
export class Autosaver {
	/**
	 * @param {object} options
	 * @param {string} options.key - draft key
	 * @param {import("./paint95-record.js").Recorder} options.recorder - recording (already begun)
	 * @param {{ width: number, height: number }} options.required - the drawing's size on 2draw
	 * @param {any} [options.restored_meta] - the draft record this session was restored from: its pieces are reused
	 * @param {(info: { at: number, ms: number, bytes: number }) => void} [options.onsaved]
	 */
	constructor({ key, recorder, required, restored_meta = null, onsaved }) {
		this.key = key;
		this.recorder = recorder;
		this.required = required;
		this.onsaved = onsaved;
		this.session = make_session_id();
		this.prefix = `${this.session}:`;
		/** stored form of the previous segments (restored from the draft), or null until written */
		this.previous_stored = recorder.previous_segments.map((_segment, i) => restored_meta?.segments?.[i] ?? null);
		/** part name per recorder blob, once stored */
		this.blob_names = recorder.blobs.map((_blob, i) => restored_meta?.blobs?.[i] ?? null);
		/** @type {{ name: string, hash: number, at: number } | null} the latest snapshot stored (the restored session's at first) */
		this.snapshot = restored_meta?.snapshot ?? null;
		this.snapshot_name = `${this.prefix}snap`;
		/** @type {Promise<void> | null} */
		this.snapshotting = null;
		/** sealed chunks of the current segment */
		this.chunk_names = [];
		this.sealed = 0;
		/** what the last save held */
		this.saved_events = recorder.segment.events.length;
		this.saved_blobs = recorder.blobs.length;
		this.dirty = false;
		this.last_change = 0;
		this.timer = 0;
		/** @type {Promise<void> | null} */
		this.saving = null;
		this.again = false;
		this.disabled = false;
		this.deleted = false;
		/** @type {Promise<void> | null} */
		this.deleting = null;
		/** stats */
		this.saves = 0;
		this.last_stats = null;

		recorder.onchange = () => this.changed();
		const on_hidden = () => {
			if (document.visibilityState === "hidden") {
				this.save_now();
			}
		};
		document.addEventListener("visibilitychange", on_hidden);
		addEventListener("pagehide", () => this.save_now());
	}

	/** Called by the recorder after every recorded event */
	changed() {
		if (this.deleted || this.disabled) {
			return;
		}
		this.dirty = true;
		this.last_change = performance.now();
		if (!this.timer) {
			this.timer = setTimeout(() => this.on_timer(), SAVE_DELAY_MS);
		}
	}

	on_timer() {
		this.timer = 0;
		const since = performance.now() - this.last_change;
		if (since < SAVE_DELAY_MS - 20) {
			// still changing: wait until it settles
			this.timer = setTimeout(() => this.on_timer(), SAVE_DELAY_MS - since);
			return;
		}
		if (this.busy()) {
			this.timer = setTimeout(() => this.on_timer(), 400);
			return;
		}
		const run = () => {
			if (this.busy()) {
				this.timer = setTimeout(() => this.on_timer(), 400);
				return;
			}
			this.save();
		};
		if (typeof requestIdleCallback === "function") {
			requestIdleCallback(run, { timeout: 1000 });
		} else {
			setTimeout(run, 0);
		}
	}

	/** Mid-stroke (or replaying): don't save now */
	busy() {
		const P95 = window.P95;
		return this.recorder.active_pointers.size > 0 || P95.in_dispatch || P95.depth > 0 || P95.mode !== "edit";
	}

	/** Saves right away if anything changed (page hidden); still never mid-stroke */
	save_now() {
		if (!this.dirty || this.deleted || this.disabled) {
			return;
		}
		const P95 = window.P95;
		if (this.recorder.active_pointers.size > 0 || P95.depth > 0 || P95.mode !== "edit") {
			return;
		}
		clearTimeout(this.timer);
		this.timer = 0;
		this.save();
	}

	/**
	 * Writes what changed since the last save.
	 * @returns {Promise<void>}
	 */
	save() {
		if (this.deleted || this.disabled) {
			return Promise.resolve();
		}
		if (this.saving) {
			this.again = true;
			return this.saving;
		}
		this.saving = this.write().catch((error) => {
			console.warn("[autosave] couldn't save the drawing on this device", error);
			if (error && error.name === "QuotaExceededError") {
				this.disabled = true;
			}
		}).finally(() => {
			this.saving = null;
			if (this.again) {
				this.again = false;
				if (this.dirty) {
					this.changed();
				}
			}
		});
		return this.saving;
	}

	async write() {
		const start = performance.now();
		const recorder = this.recorder;
		this.dirty = false;
		/** @type {{ name: string, data: Uint8Array }[]} */
		const puts = [];

		// previous sessions (a revision's posted recording): written once
		recorder.previous_segments.forEach((segment, i) => {
			if (!this.previous_stored[i]) {
				const name = `${this.prefix}p${i}`;
				puts.push({ name, data: pack_events(segment.events) });
				this.previous_stored[i] = { info: segment_info(segment), chunks: [name], tail: null };
			}
		});
		// blobs: written once, as PNG (kept as PNG in the recorder too, so finalize doesn't encode them again)
		for (let i = 0; i < recorder.blobs.length; i++) {
			if (!this.blob_names[i]) {
				const blob = recorder.blobs[i];
				const png = "png" in blob ? blob.png : encode_png(blob.image_data);
				if (!("png" in blob)) {
					recorder.blobs[i] = { png };
				}
				const name = `${this.prefix}b${i}`;
				puts.push({ name, data: png });
				this.blob_names[i] = name;
			}
		}
		// this session's events: sealed chunks, plus the rest as the tail
		const events = recorder.segment.events;
		const count = events.length;
		while (count - this.sealed >= CHUNK_EVENTS) {
			const name = `${this.prefix}c${this.chunk_names.length}`;
			puts.push({ name, data: pack_events(events.slice(this.sealed, this.sealed + CHUNK_EVENTS)) });
			this.chunk_names.push(name);
			this.sealed += CHUNK_EVENTS;
		}
		const tail = pack_events(events.slice(this.sealed, count));
		const image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
		const hash = hash_image_data(image_data);
		const info = segment_info(recorder.segment);
		info.duration = Math.max(recorder.last_t, Math.round(recorder.now()));
		info.end = { hash, width: image_data.width, height: image_data.height };
		const sync_ms = performance.now() - start;

		const saved = Date.now();
		const meta = {
			key: this.key,
			v: DRAFT_VERSION,
			tool: "paint95",
			saved,
			session: this.session,
			required: this.required,
			truncated: !!recorder.previous_truncated,
			width: image_data.width,
			height: image_data.height,
			hash,
			segments: [...this.previous_stored, { info, chunks: this.chunk_names.slice(), tail }],
			blobs: this.blob_names.slice(),
			snapshot: this.snapshot,
			events: recorder.previous_segments.reduce((n, s) => n + s.events.length, 0) + count,
		};

		const db = await open_db();
		if (this.deleted) {
			return;
		}
		const tx = db.transaction([DRAFTS, PARTS], "readwrite");
		const parts = tx.objectStore(PARTS);
		for (const { name, data } of puts) {
			parts.put({ key: this.key, name, data });
		}
		tx.objectStore(DRAFTS).put(meta);
		await done(tx);
		this.saved_events = count;
		this.saved_blobs = recorder.blobs.length;
		const bytes = puts.reduce((n, p) => n + p.data.byteLength, 0) + tail.byteLength;
		const ms = performance.now() - start;
		this.saves++;
		this.last_stats = { at: saved, ms: Math.round(ms * 10) / 10, sync_ms: Math.round(sync_ms * 10) / 10, bytes, events: meta.events, chunks: this.chunk_names.length, tail: tail.byteLength };
		console.log(`[autosave] saved on this device: ${meta.events} events, wrote ${bytes} bytes in ${this.last_stats.ms} ms (${this.last_stats.sync_ms} ms on the main thread)`);
		try {
			this.onsaved?.({ at: saved, ms, bytes });
		} catch (error) {
			console.error("draftSaved failed", error);
		}
		if (hash !== this.snapshot?.hash && (!this.snapshot || saved - this.snapshot.at >= SNAPSHOT_INTERVAL_MS || document.visibilityState === "hidden")) {
			this.take_snapshot(hash);
		}
	}

	/**
	 * Stores a PNG of the canvas, the picture to set if replaying the copy ever drifts. Encoded off the main thread
	 * (toBlob), written after the recording itself, and only used while its hash is the record's.
	 * @param {number} hash - of the canvas now
	 */
	take_snapshot(hash) {
		if (this.snapshotting) {
			return;
		}
		const start = performance.now();
		this.snapshotting = canvas_png(main_canvas).then(async (png) => {
			if (!png || this.deleted) {
				return;
			}
			const db = await open_db();
			const tx = db.transaction([DRAFTS, PARTS], "readwrite");
			const drafts = tx.objectStore(DRAFTS);
			const meta = await req(drafts.get(this.key));
			// (deleted after a submit, or another tab saved since: leave it)
			if (!meta || meta.session !== this.session) {
				return;
			}
			const parts = tx.objectStore(PARTS);
			parts.put({ key: this.key, name: this.snapshot_name, data: png });
			const old = meta.snapshot?.name;
			if (old && old !== this.snapshot_name) {
				parts.delete([this.key, old]);
			}
			const snapshot = { name: this.snapshot_name, hash, at: Date.now() };
			meta.snapshot = snapshot;
			drafts.put(meta);
			await done(tx);
			this.snapshot = snapshot;
			this.last_snapshot_stats = { bytes: png.byteLength, ms: Math.round(performance.now() - start) };
		}).catch((error) => {
			console.warn("[autosave] couldn't store the snapshot", error);
		}).finally(() => {
			this.snapshotting = null;
		});
	}

	/** After a successful submit: stop saving and delete the copy */
	delete() {
		if (!this.deleting) {
			this.deleted = true;
			clearTimeout(this.timer);
			this.timer = 0;
			this.deleting = Promise.all([this.saving, this.snapshotting]).catch(() => { }).then(() => delete_draft(this.key));
			this.deleting.then(() => console.log("[autosave] deleted the device copy"), () => { this.deleting = null; });
		}
		return this.deleting;
	}
}

/** Asks once per device for storage that the browser won't evict. Never asks the member anything itself. */
export function request_persistent_storage() {
	try {
		const flag = "2draw-paint95-persist-requested";
		if (localStorage.getItem(flag)) {
			return;
		}
		localStorage.setItem(flag, String(Date.now()));
	} catch (_error) {
		// no localStorage: ask anyway (the browser remembers its own answer)
	}
	try {
		const storage = navigator.storage;
		if (storage && storage.persisted && storage.persist) {
			storage.persisted().then((persisted) => (persisted ? true : storage.persist())).then((granted) => {
				console.log(`[autosave] persistent storage ${granted ? "granted" : "not granted"}`);
			}, () => { });
		}
	} catch (_error) { /* ignore */ }
}
