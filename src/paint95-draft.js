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
/** After a failed save, try again this long after (and at every change) */
export const RETRY_MS = 5000;
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
 * it under its own key. The 30 days count from now (aside_at), not from its last save.
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
		drafts.put({ ...meta, key: aside, set_aside: true, aside_at: Date.now() });
		drafts.delete(key);
		parts.delete(parts_range(key));
	}
	await done(tx);
	return aside;
}

/**
 * Deletes drafts not saved (or set aside) for DRAFT_MAX_AGE_MS (all drafts in this database are this tool's).
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
			const at = Math.max(typeof meta.saved === "number" ? meta.saved : 0, typeof meta.aside_at === "number" ? meta.aside_at : 0);
			if (!(at > 0 && now - at < DRAFT_MAX_AGE_MS)) {
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
	 * @param {(error: any) => void} [options.onfailed] - a save failed (it is tried again at the next change, and
	 *   every RETRY_MS)
	 * @param {(state: AutosaveState) => void} [options.onstate] - whenever the state changes
	 */
	constructor({ key, recorder, required, restored_meta = null, onsaved, onfailed, onstate }) {
		this.key = key;
		this.recorder = recorder;
		this.required = required;
		this.onsaved = onsaved;
		this.onfailed = onfailed;
		this.onstate = onstate;
		/** the last save failed (and nothing has saved since) */
		this.failed = false;
		/** a copy of this drawing is on this device (saved by this page, or the one it was restored from) */
		this.ever_saved = !!restored_meta;
		/** another tab took the drawing over (yield_edit): no more saves here */
		this.yielded = false;
		/** @type {string} the state last reported */
		this.reported = "";
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
		/** every piece's name, in the order written (the copy on 2draw takes them in this order: 2draw.net
		 * worker/src/lib/draftlayouts.ts "p95-1") */
		this.order = restored_meta ? restored_order(restored_meta) : [];
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
		// Hidden (a swipe back, the app switcher, another tab) may be the last chance: on iOS the page is often never
		// shown again. Save now, up to the stroke under way.
		const on_hidden = () => {
			if (document.visibilityState === "hidden") {
				this.save_now();
			}
		};
		document.addEventListener("visibilitychange", on_hidden);
		addEventListener("pagehide", () => this.save_now());
	}

	/**
	 * @typedef {object} AutosaveState
	 * @property {boolean} pending - leaving now would lose something: a change not saved yet, a save under way, a
	 *   stroke under way, or a failing store
	 * @property {boolean} failed - the last save failed
	 * @property {boolean} saved - a copy is on this device (and saving works)
	 * @property {boolean} yielded - another tab has this drawing now
	 */

	/** @returns {AutosaveState} */
	state() {
		const pending = !this.yielded && !this.deleted && (this.dirty || !!this.saving || this.failed || this.recorder.active_pointers.size > 0);
		return { pending, failed: this.failed, saved: this.ever_saved && !this.failed, yielded: this.yielded };
	}

	/** Tells onstate when the state changed */
	report() {
		const state = this.state();
		const key = `${state.pending}|${state.failed}|${state.saved}|${state.yielded}`;
		if (key === this.reported) {
			return;
		}
		this.reported = key;
		try {
			this.onstate?.(state);
		} catch (error) {
			console.error("[autosave] onstate failed", error);
		}
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
		this.report();
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

	/**
	 * Saves right away if anything changed (page hidden, Close, another tab taking over), up to the stroke under way:
	 * that stroke is stored as if it ended where the pointer is now (write). Never while replaying.
	 * @returns {Promise<void>} the save
	 */
	save_now() {
		if (!this.dirty || this.deleted || this.disabled) {
			return this.saving ?? Promise.resolve();
		}
		const P95 = window.P95;
		if (P95.depth > 0 || P95.mode !== "edit") {
			return this.saving ?? Promise.resolve();
		}
		clearTimeout(this.timer);
		this.timer = 0;
		return this.save();
	}

	/** Saves everything now and waits for it (Close: window.drawFlush). */
	async flush() {
		for (let i = 0; i < 3 && !this.deleted && !this.disabled && (this.dirty || this.saving); i++) {
			await this.save_now();
		}
	}

	/** Another tab takes this drawing over: a last save, then no more (edit lock, take_edit_lock). */
	async yield_edit() {
		if (this.yielded) {
			return;
		}
		try {
			await this.flush();
		} finally {
			this.yielded = true;
			this.disabled = true;
			clearTimeout(this.timer);
			this.timer = 0;
			this.report();
		}
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
		this.dirty = false;
		this.saving = this.write().then(() => {
			this.failed = false;
		}, (error) => {
			// (QuotaExceededError: the device is full; anything else: IndexedDB broke.) Nothing it wrote counts (write
			// keeps its pieces only once the transaction is done), so the next try writes it all again.
			console.warn("[autosave] couldn't save the drawing on this device", error);
			this.dirty = true;
			const first = !this.failed;
			this.failed = true;
			if (first) {
				try {
					this.onfailed?.(error);
				} catch (callback_error) {
					console.error("[autosave] onfailed failed", callback_error);
				}
			}
			if (!this.timer && !this.deleted && !this.disabled) {
				this.timer = setTimeout(() => this.on_timer(), RETRY_MS);
			}
		}).finally(() => {
			this.saving = null;
			if (this.again) {
				this.again = false;
				if (this.dirty && !this.failed) {
					if (document.visibilityState === "hidden") {
						// (timers may never run again in a hidden page)
						this.save_now();
					} else {
						this.changed();
					}
				}
			}
			this.report();
		});
		this.report();
		return this.saving;
	}

	async write() {
		const start = performance.now();
		const recorder = this.recorder;
		/** @type {{ name: string, data: Uint8Array }[]} */
		const puts = [];
		// What this save adds, kept (in this) only once it is written: a failed save leaves nothing half-counted.
		const previous_stored = this.previous_stored.slice();
		const blob_names = this.blob_names.slice();
		const chunk_names = this.chunk_names.slice();
		let sealed = this.sealed;
		const order = this.order.slice();

		// previous sessions (a revision's posted recording): written once
		recorder.previous_segments.forEach((segment, i) => {
			if (!previous_stored[i]) {
				const name = `${this.prefix}p${i}`;
				puts.push({ name, data: pack_events(segment.events) });
				previous_stored[i] = { info: segment_info(segment), chunks: [name], tail: null };
			}
		});
		// blobs: written once, as PNG (kept as PNG in the recorder too, so finalize doesn't encode them again)
		for (let i = 0; i < recorder.blobs.length; i++) {
			if (!blob_names[i]) {
				const blob = recorder.blobs[i];
				const png = "png" in blob ? blob.png : encode_png(blob.image_data);
				if (!("png" in blob)) {
					recorder.blobs[i] = { png };
				}
				const name = `${this.prefix}b${i}`;
				puts.push({ name, data: png });
				blob_names[i] = name;
			}
		}
		// this session's events: sealed chunks, plus the rest as the tail
		const events = recorder.segment.events;
		const count = events.length;
		while (count - sealed >= CHUNK_EVENTS) {
			const name = `${this.prefix}c${chunk_names.length}`;
			puts.push({ name, data: pack_events(events.slice(sealed, sealed + CHUNK_EVENTS)) });
			chunk_names.push(name);
			sealed += CHUNK_EVENTS;
		}
		// A stroke under way (the page is being hidden): the copy ends it where the pointer is now, so a replay of the
		// copy has the stroke as drawn so far. Its picture isn't known until that replay, so the copy has no hash.
		const closing = open_stroke_ends(recorder, events);
		const tail = pack_events(closing.length ? [...events.slice(sealed, count), ...closing] : events.slice(sealed, count));
		const image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
		const hash = closing.length ? null : hash_image_data(image_data);
		const info = segment_info(recorder.segment);
		info.duration = Math.max(recorder.last_t, Math.round(recorder.now()));
		if (hash != null) {
			info.end = { hash, width: image_data.width, height: image_data.height };
		} else {
			delete info.end;
		}
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
			segments: [...previous_stored, { info, chunks: chunk_names, tail }],
			blobs: blob_names,
			snapshot: this.snapshot,
			order: order.concat(puts.map((p) => p.name).filter((name) => !order.includes(name))),
			events: recorder.previous_segments.reduce((n, s) => n + s.events.length, 0) + count + closing.length,
			open_stroke: closing.length > 0,
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
		this.previous_stored = previous_stored;
		this.blob_names = blob_names;
		this.chunk_names = chunk_names;
		this.sealed = sealed;
		this.order = meta.order;
		this.ever_saved = true;
		this.saved_events = count;
		this.saved_blobs = recorder.blobs.length;
		const bytes = puts.reduce((n, p) => n + p.data.byteLength, 0) + tail.byteLength;
		const ms = performance.now() - start;
		this.saves++;
		this.last_stats = { at: saved, ms: Math.round(ms * 10) / 10, sync_ms: Math.round(sync_ms * 10) / 10, bytes, events: meta.events, chunks: this.chunk_names.length, tail: tail.byteLength, open_stroke: closing.length > 0 };
		console.log(`[autosave] saved on this device: ${meta.events} events${closing.length ? " (mid-stroke)" : ""}, wrote ${bytes} bytes in ${this.last_stats.ms} ms (${this.last_stats.sync_ms} ms on the main thread)`);
		try {
			this.onsaved?.({ at: saved, ms, bytes });
		} catch (error) {
			console.error("draftSaved failed", error);
		}
		if (hash != null && hash !== this.snapshot?.hash && (!this.snapshot || saved - this.snapshot.at >= SNAPSHOT_INTERVAL_MS || document.visibilityState === "hidden")) {
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
			this.report();
		}
		return this.deleting;
	}
}

/**
 * The pieces of a restored copy in the order they were written: its own list, or (a copy saved before it kept one)
 * the revision's segments, its blobs, then the session's chunks.
 * @param {any} meta
 * @returns {string[]}
 */
function restored_order(meta) {
	if (Array.isArray(meta.order)) {
		return meta.order.slice();
	}
	const out = [];
	const segments = Array.isArray(meta.segments) ? meta.segments : [];
	for (const segment of segments.slice(0, -1)) {
		out.push(...(segment.chunks || []));
	}
	out.push(...(meta.blobs || []));
	const last = segments[segments.length - 1];
	if (last) {
		out.push(...(last.chunks || []));
	}
	return [...new Set(out)];
}

/**
 * Events that end the strokes under way where each pointer is now: a pointer up per pointer still down, for a copy
 * saved mid-stroke (the recorder itself carries on with the real events).
 * @param {import("./paint95-record.js").Recorder} recorder
 * @param {any[][]} events
 * @returns {any[][]}
 */
export function open_stroke_ends(recorder, events) {
	if (!recorder.active_pointers.size) {
		return [];
	}
	const ends = [];
	for (const id of recorder.active_pointers) {
		// the last position: its latest down ["d", dt, id, target, x, y, …] or move ["m"/"M", dt, id, x, y, …]
		let x = 0;
		let y = 0;
		for (let i = events.length - 1; i >= 0; i--) {
			const event = events[i];
			if (event[2] !== id) {
				continue;
			}
			if (event[0] === "m" || event[0] === "M") {
				[x, y] = [event[3], event[4]];
				break;
			}
			if (event[0] === "d") {
				[x, y] = [event[4], event[5]];
				break;
			}
		}
		ends.push(["u", 0, id, x, y, 0, 0, 0]);
	}
	return ends;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One editor per draft on this device (two tabs, or a tab and the iOS app's web view). The editor holds the Web
 * Lock "paint95-draft-edit:<key>" while it is open. A new one that finds it held posts "take" on
 * BroadcastChannel("paint95-draft:<key>"); the holder answers "taking", saves (ontake), lets go and posts
 * "released". The new one waits for that (4 s at most, then steals the lock from a tab that never answers), and only
 * then reads the device copy, so it starts from everything the other tab drew. Without Web Locks the message alone
 * does it: with no answer in 250 ms nobody else has it open. Modelled on Lascaux Pocket's (2draw.net
 * worker/src/pocket/ink.ts, "one editor at a time").
 * @param {string} key
 * @param {() => Promise<void>} ontake - another tab takes over: save, stop saving, say so; given 2 s at most
 * @returns {Promise<{ lost: boolean }>} once this tab is the editor
 */
export async function take_edit_lock(key, ontake) {
	const tab = make_session_id();
	const handle = { lost: false, held: false };
	/** @type {(() => void) | null} */
	let release = null;
	/** @type {(() => void) | null} */
	let answered = null;
	/** @type {(() => void) | null} */
	let released = null;
	/** @type {BroadcastChannel | null} */
	let channel = null;
	try {
		channel = new BroadcastChannel(`paint95-draft:${key}`);
	} catch (_error) { /* no BroadcastChannel */ }
	const post = (t) => {
		try {
			channel?.postMessage({ t, from: tab });
		} catch (_error) { /* closed */ }
	};
	const give_up = async () => {
		if (handle.lost) {
			return;
		}
		handle.lost = true;
		try {
			await Promise.race([ontake(), sleep(2000)]);
		} catch (error) {
			console.error("[autosave] couldn't hand the drawing over", error);
		}
		release?.();
		release = null;
		post("released");
	};
	channel?.addEventListener("message", (e) => {
		const m = e.data || {};
		if (m.from === tab) {
			return;
		}
		if (m.t === "take" && handle.held && !handle.lost) {
			post("taking");
			give_up();
		} else if (m.t === "taking") {
			answered?.();
		} else if (m.t === "released") {
			released?.();
		}
	});
	const locks = navigator.locks;
	if (!locks || !locks.request) {
		if (channel) {
			const yes = await new Promise((resolve) => {
				answered = () => resolve(true);
				setTimeout(() => resolve(false), 250);
				post("take");
			});
			if (yes) {
				await Promise.race([new Promise((resolve) => { released = () => resolve(undefined); }), sleep(4000)]);
			}
			answered = released = null;
		}
		handle.held = true;
		return handle;
	}
	/** @type {() => void} */
	let let_go = () => { };
	const held = new Promise((resolve) => { let_go = () => resolve(undefined); });
	const name = `paint95-draft-edit:${key}`;
	/** @param {LockOptions} options */
	const request = (options) => new Promise((granted) => {
		let mine = false;
		locks.request(name, options, (lock) => {
			if (!lock) {
				granted(false);
				return undefined;
			}
			mine = true;
			granted(true);
			return held;
		}).catch(() => {
			// stolen (by a tab that waited 4 s), or our own wait ran out
			if (mine) {
				give_up();
			} else {
				granted(false);
			}
		});
	});
	if (!(await request({ ifAvailable: true }))) {
		post("take");
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), 4000);
		const got = await request({ signal: abort.signal });
		clearTimeout(timer);
		if (!got) {
			console.warn("[autosave] the other tab didn't let go of the drawing; taking it");
			await request({ steal: true });
		}
	}
	release = let_go;
	handle.held = true;
	return handle;
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
