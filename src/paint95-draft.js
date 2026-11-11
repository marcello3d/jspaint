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
import { FORMAT_VERSION, encode_png } from "./paint95-format.js";

export const DB_NAME = "2draw-paint95-drafts";
const DB_VERSION = 1;
const DRAFTS = "drafts";
const PARTS = "parts";
/** Drafts not saved for this long are deleted when the editor loads. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Events per sealed chunk */
export const CHUNK_EVENTS = 2048;
/** A save is due this long after the first change since the last save; later changes don't put it off (see "When
 * to save" below). */
export const SAVE_DELAY_MS = 700;
/** A store that failed is tried again after these waits (a fresh connection each time) before a save says it failed */
export const DB_RETRY_MS = [250, 1000, 3000];
/** A new snapshot at most this often (and when the page is hidden) */
export const SNAPSHOT_INTERVAL_MS = 20000;
/** After a failed save, try again this long after (and at every change) */
export const RETRY_MS = 5000;
const DRAFT_VERSION = 1;

// #region The pen
// Nothing interrupts drawing. On 2draw's draw page (the same-origin parent) window.drawPen (2draw.net
// client/draw-bar.ts) says when the pen rests: a save waits for a pause in the drawing, not just for the pen to lift (a
// save in the gap between two fast strokes held up the next one), and runs in slices of a few ms, each one only once
// the pen rests again. Without that page (the editor alone): at once, with plain yields between slices.

/** @returns {{ idle(fn: () => void, since?: number): void, slice?(since?: number): Promise<void>, sliceMs?: number, yielded?(): boolean } | null} */
function draw_pen() {
	try {
		const pen = window.parent !== window ? /** @type {any} */ (window.parent).drawPen : null;
		return pen && typeof pen.idle === "function" ? pen : null;
	} catch (_error) {
		return null;
	}
}
/** ms a slice of a save may take */
function slice_ms() {
	return draw_pen()?.sliceMs || 4;
}
/**
 * Before the next slice of a save begun at `since`; at once when `urgent` (the page is being hidden or left: the save
 * has to start its transaction now).
 */
export function next_slice(urgent = false, since = Date.now()) {
	if (urgent || document.visibilityState === "hidden") {
		return Promise.resolve();
	}
	const pen = draw_pen();
	if (pen && typeof pen.slice === "function") {
		return Promise.resolve(pen.slice(since));
	}
	return new Promise((resolve) => setTimeout(resolve, 0));
}
/** A slice should end early: input is waiting */
function input_waiting() {
	try {
		return !!draw_pen()?.yielded?.();
	} catch (_error) {
		return false;
	}
}
// #endregion

/** A 2draw draft key (lib/drafts.ts): 12 lowercase Crockford base32 characters; anything URL-safe and short is accepted. */
export function valid_draft_key(key) {
	return typeof key === "string" && /^[0-9a-z_-]{4,64}$/.test(key);
}

// #region IndexedDB
// Every transaction is committed as soon as its last request is made (commit_tx), never left to commit by itself:
// WebKit (Safari, the iOS app) puts a page that is left into its back/forward cache right after pagehide and freezes
// it there, and a frozen page with a transaction still open holds the store, so the same drawing opened again waited
// behind it until the frozen page was thrown away, minutes later. So, too, as Lascaux Pocket does (2draw.net
// worker/src/pocket/ink.ts, "The device's store"): a page going into that cache (pagehide, persisted) starts no new
// transaction until it is shown again (page_away), aborts any still waiting on its own requests (open_tx) and closes
// its connection (opened again when next needed). A transaction that fails is tried again on a fresh connection
// (DB_RETRY_MS) before anyone says "Not saved".

/** @type {Promise<IDBDatabase> | null} */
let db_promise = null;
/** @type {IDBDatabase | null} */
let db_connection = null;
/** @type {Promise<void> | null} the page is in the back/forward cache: resolves when it is shown again */
let page_away = null;
/** @type {(() => void) | null} */
let page_back = null;
/** @type {Set<IDBTransaction>} transactions still making requests (from callbacks): aborted if the page goes away */
const open_tx = new Set();
/** @type {Set<() => void>} called when the page comes back from the back/forward cache */
const on_page_back = new Set();

/** Whether the page is in the back/forward cache (nothing is started then) */
export function is_page_away() {
	return !!page_away;
}

/** Thrown for a transaction aborted because the page went into the back/forward cache: not a failure */
export class PageAwayError extends Error {
	constructor() {
		super("the page went into the back/forward cache");
		this.name = "PageAwayError";
	}
}

/** @param {IDBTransaction} tx */
export function commit_tx(tx) {
	// (commit(): Safari 15+, Chrome 76+; older ones commit by themselves)
	const commit = /** @type {any} */ (tx).commit;
	if (typeof commit === "function") {
		try {
			commit.call(tx);
		} catch (_error) { /* already finishing */ }
	}
}

/** @param {IDBDatabase} db */
function drop_db(db) {
	try {
		db.close();
	} catch (_error) { /* closed */ }
	if (db_connection === db) {
		db_connection = null;
		db_promise = null;
	}
}

if (typeof addEventListener === "function") {
	addEventListener("pagehide", (event) => {
		if (!(/** @type {PageTransitionEvent} */ (event).persisted)) {
			return;
		}
		page_away ??= new Promise((resolve) => { page_back = () => resolve(undefined); });
		for (const tx of open_tx) {
			try {
				tx.abort();
			} catch (_error) { /* finished */ }
		}
		open_tx.clear();
		if (db_connection) {
			drop_db(db_connection);
		}
	});
	addEventListener("pageshow", () => {
		if (!page_away) {
			return;
		}
		page_away = null;
		page_back?.();
		page_back = null;
		for (const fn of on_page_back) {
			try {
				fn();
			} catch (error) {
				console.error("[autosave] pageshow handler failed", error);
			}
		}
	});
}

/** @returns {Promise<IDBDatabase>} */
function open_db_once() {
	return new Promise((resolve, reject) => {
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
			db.onversionchange = () => drop_db(db);
			/** @type {any} */ (db).onclose = () => drop_db(db);
			db_connection = db;
			resolve(db);
		};
		request.onerror = () => reject(request.error);
		request.onblocked = () => console.warn("[autosave] the device store's open is waiting on another page");
	});
}

/** @returns {Promise<IDBDatabase>} */
export function open_db() {
	if (!db_promise) {
		db_promise = (async () => {
			for (let i = 0; ; i++) {
				try {
					return await open_db_once();
				} catch (error) {
					if (i >= DB_RETRY_MS.length || typeof indexedDB === "undefined") {
						throw error;
					}
					await sleep(DB_RETRY_MS[i]);
				}
			}
		})();
		db_promise.catch(() => { db_promise = null; });
	}
	return db_promise;
}

/** @param {any} error */
const retryable = (error) => !(error instanceof PageAwayError) && !(error && ["QuotaExceededError", "DataError", "DataCloneError", "ConstraintError", "ReadOnlyError", "VersionError"].includes(error.name));

/**
 * A transaction whose requests `fn` makes at once (none from another's callback): committed straight after, waited
 * for, and tried again (DB_RETRY_MS, on a fresh connection) if it fails. Never started while the page is in the
 * back/forward cache. Resolves with what `fn` returned, its requests' results filled in.
 * @template T
 * @param {string[]} stores
 * @param {IDBTransactionMode} mode
 * @param {(tx: IDBTransaction) => T} fn
 * @returns {Promise<T>}
 */
export async function run_tx(stores, mode, fn) {
	for (let i = 0; ; i++) {
		try {
			while (page_away) {
				await page_away;
			}
			const db = await open_db();
			/** @type {IDBTransaction} */
			let tx;
			try {
				tx = db.transaction(stores, mode);
			} catch (error) {
				// (closed under it: opened again)
				drop_db(db);
				throw error;
			}
			const out = fn(tx);
			commit_tx(tx);
			await done(tx);
			return out;
		} catch (error) {
			if (i >= DB_RETRY_MS.length || !retryable(error)) {
				throw error;
			}
			await sleep(DB_RETRY_MS[i]);
		}
	}
}

/**
 * A transaction that makes requests from its requests' callbacks (it can't commit at once): `fn` calls finish() after
 * its last request, which commits it. Aborted if the page goes into the back/forward cache meanwhile (PageAwayError).
 * @template T
 * @param {string[]} stores
 * @param {IDBTransactionMode} mode
 * @param {(tx: IDBTransaction, finish: () => void) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
async function run_chained_tx(stores, mode, fn) {
	while (page_away) {
		await page_away;
	}
	const db = await open_db();
	const tx = db.transaction(stores, mode);
	open_tx.add(tx);
	const finished = done(tx).finally(() => open_tx.delete(tx));
	try {
		const out = await fn(tx, () => commit_tx(tx));
		commit_tx(tx);
		await finished;
		return out;
	} catch (error) {
		try {
			tx.abort();
		} catch (_error) { /* finished */ }
		await finished.catch(() => { });
		throw page_away ? new PageAwayError() : error;
	}
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
	tx.onabort = () => reject(page_away ? new PageAwayError() : tx.error || new Error("transaction aborted"));
});

/** All parts of one draft */
const parts_range = (key) => IDBKeyRange.bound([key, ""], [key, "￿"]);

/**
 * Reads a draft: its record and every part, as a P95File for paint95-restore.js.
 * @param {string} key
 * @returns {Promise<null | { meta: any, file: import("./paint95-format.js").P95File, snapshot: Uint8Array | null, bytes: number }>}
 */
export async function load_draft(key) {
	const got = await run_tx([DRAFTS, PARTS], "readonly", (tx) => ({
		meta: tx.objectStore(DRAFTS).get(key),
		parts: tx.objectStore(PARTS).getAll(parts_range(key)),
	}));
	const meta = got.meta.result;
	const parts = got.parts.result;
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
	await run_tx([DRAFTS, PARTS], "readwrite", (tx) => {
		tx.objectStore(DRAFTS).delete(key);
		tx.objectStore(PARTS).delete(parts_range(key));
	});
}

/**
 * Keeps an unreadable draft for 30 more days under another key (so a new session doesn't overwrite it), then deletes
 * it under its own key. The 30 days count from now (aside_at), not from its last save.
 * @param {string} key
 */
export async function set_draft_aside(key) {
	const aside = `${key}~unreadable-${Date.now()}`;
	// (read, then written in a second transaction: each one commits at once; one editor per draft, so nothing writes
	// it in between)
	const got = await run_tx([DRAFTS, PARTS], "readonly", (tx) => ({
		meta: tx.objectStore(DRAFTS).get(key),
		parts: tx.objectStore(PARTS).getAll(parts_range(key)),
	}));
	const meta = got.meta.result;
	if (!meta) {
		return aside;
	}
	await run_tx([DRAFTS, PARTS], "readwrite", (tx) => {
		const drafts = tx.objectStore(DRAFTS);
		const parts = tx.objectStore(PARTS);
		for (const part of got.parts.result) {
			parts.put({ ...part, key: aside });
		}
		drafts.put({ ...meta, key: aside, set_aside: true, aside_at: Date.now() });
		drafts.delete(key);
		parts.delete(parts_range(key));
	});
	return aside;
}

/**
 * Deletes drafts not saved (or set aside) for DRAFT_MAX_AGE_MS (all drafts in this database are this tool's), but
 * never `keep` (the draft this page has open: its pieces are still in use).
 * @param {number} [now]
 * @param {string} [keep]
 * @returns {Promise<number>} how many were deleted
 */
export async function expire_drafts(now = Date.now(), keep = "") {
	// (the records read in one transaction and the old ones deleted in another, not with a cursor: a cursor makes its
	// requests from callbacks, so its transaction couldn't commit at once)
	const all = await run_tx([DRAFTS], "readonly", (tx) => tx.objectStore(DRAFTS).getAll());
	const old = all.result.filter((/** @type {any} */ meta) => {
		const at = Math.max(typeof meta.saved === "number" ? meta.saved : 0, typeof meta.aside_at === "number" ? meta.aside_at : 0);
		return meta.key !== keep && !(at > 0 && now - at < DRAFT_MAX_AGE_MS);
	});
	if (old.length) {
		await run_tx([DRAFTS, PARTS], "readwrite", (tx) => {
			for (const meta of old) {
				tx.objectStore(PARTS).delete(parts_range(meta.key));
				tx.objectStore(DRAFTS).delete(meta.key);
			}
		});
	}
	return old.length;
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
/** Words hashed per slice (hash_image_data_sliced). */
const HASH_SLICE_WORDS = 1 << 14;

/**
 * hash_image_data in slices of HASH_SLICE_WORDS pixels with a yield between them (the same hash): a save happens
 * every moment while drawing, and hashing a whole big canvas at once held the page for tens of ms on a slow phone.
 * @param {ImageData} image_data - a copy (getImageData): it doesn't change meanwhile
 * @returns {Promise<{ hash: number, longest: number }>} the hash, and the longest slice's main-thread time (ms)
 */
export async function hash_image_data_sliced(image_data, urgent = false, since = Date.now()) {
	const { data, width, height } = image_data;
	const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
	let h = 0x811c9dc5;
	h = Math.imul(h ^ width, 0x01000193);
	h = Math.imul(h ^ height, 0x01000193);
	let longest = 0;
	const budget = slice_ms();
	let t = performance.now();
	for (let from = 0; from < words.length; from += HASH_SLICE_WORDS) {
		const to = Math.min(words.length, from + HASH_SLICE_WORDS);
		for (let i = from; i < to; i++) {
			h = Math.imul(h ^ words[i], 0x01000193);
		}
		// (a slice ends after `budget` ms, or sooner if input is waiting)
		if (to < words.length && !urgent && (performance.now() - t >= budget || input_waiting())) {
			longest = Math.max(longest, performance.now() - t);
			await next_slice(urgent, since);
			t = performance.now();
		}
	}
	longest = Math.max(longest, performance.now() - t);
	return { hash: h >>> 0, longest };
}

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
		this.timer = 0;
		/** a save is due, waiting for the pen to lift */
		this.due = false;
		this.due_check = false;
		/** a gated save is waiting for drawPen.idle */
		this.gate_waiting = false;
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
		// When to save: the copy has to be current before the page is left, not when it is. A save is due
		// SAVE_DELAY_MS after the first change since the last one, and later changes don't put it off, so drawing
		// without a pause still saves (it waits for the pen to lift: on_timer). Leaving is a bonus: a page hidden
		// (the app switcher, another tab; iOS delivers it before it suspends the page) saves at once, up to the stroke
		// under way; but a page going into the back/forward cache (a swipe back in Safari or the iOS app: pagehide,
		// persisted, and the visibilitychange after it) starts nothing, since WebKit freezes it right away and the
		// write would never run (it would only hold the store, see "IndexedDB"). What it held is saved when it is
		// shown again.
		const on_hidden = () => {
			if (document.visibilityState === "hidden" && !is_page_away()) {
				this.save_now();
			}
		};
		document.addEventListener("visibilitychange", on_hidden);
		addEventListener("pagehide", (event) => {
			if (!(/** @type {PageTransitionEvent} */ (event).persisted)) {
				this.save_now();
			}
		});
		on_page_back.add(() => {
			if (this.dirty && !this.deleted && !this.disabled) {
				clearTimeout(this.timer);
				this.timer = setTimeout(() => this.on_timer(), 0);
			}
		});
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
		if (this.due && draw_pen()) {
			// a save is due, waiting for the pen to rest (gated_save)
		} else if (this.due) {
			// a save is due, waiting for the pen to lift: this change may be its lifting (checked once it is recorded)
			if (!this.due_check) {
				this.due_check = true;
				setTimeout(() => {
					this.due_check = false;
					if (this.due && !this.busy()) {
						clearTimeout(this.timer);
						this.on_timer();
					}
				}, 0);
			}
		} else if (!this.timer) {
			// (a save already due stands: later changes never put it off)
			this.timer = setTimeout(() => this.on_timer(), SAVE_DELAY_MS);
		}
		this.report();
	}

	on_timer() {
		this.timer = 0;
		if (!this.dirty || this.deleted || this.disabled || is_page_away()) {
			// (in the back/forward cache: saved when shown again)
			this.due = false;
			return;
		}
		if (draw_pen() && !this.replaying()) {
			this.gated_save();
			return;
		}
		if (this.busy()) {
			// mid-stroke (or replaying): saved as soon as the pen lifts (changed), or found here a moment later
			this.due = true;
			this.timer = setTimeout(() => this.on_timer(), 250);
			return;
		}
		this.due = false;
		// (right away, not at an idle moment: the next stroke may start any moment, and the page may be left; a save
		// takes a few ms on the main thread)
		this.save();
	}

	/**
	 * On 2draw's draw page: the save once the pen rests (drawPen.idle: in a pause between strokes; after a while of
	 * drawing without one, at the next pen-up).
	 */
	gated_save() {
		this.due = true;
		if (this.gate_waiting) {
			return;
		}
		this.gate_waiting = true;
		draw_pen()?.idle(() => {
			this.gate_waiting = false;
			if (!this.due) {
				return;
			}
			this.due = false;
			if (!this.dirty || this.deleted || this.disabled || is_page_away()) {
				return;
			}
			if (this.busy()) {
				// (still pressed in this frame, or replaying: looked at again in a moment)
				clearTimeout(this.timer);
				this.timer = setTimeout(() => this.on_timer(), 250);
				return;
			}
			this.save();
		});
	}

	/** Replaying (or in a nested dispatch): no save yet */
	replaying() {
		const P95 = window.P95;
		return P95.in_dispatch || P95.depth > 0 || P95.mode !== "edit";
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
		this.due = false;
		// (urgent: no slices, the transaction starts in this task)
		return this.save(true);
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
	save(urgent = false) {
		if (this.deleted || this.disabled) {
			return Promise.resolve();
		}
		if (this.saving) {
			this.again = true;
			this.urgent ||= urgent;
			return this.saving;
		}
		this.dirty = false;
		this.due = false;
		this.urgent = urgent;
		this.saving = this.write().then(() => {
			this.failed = false;
		}, (error) => {
			this.dirty = true;
			if (error instanceof PageAwayError) {
				// (the page went into the back/forward cache: not a failure; saved again when it is shown)
				return;
			}
			// (QuotaExceededError: the device is full; anything else: IndexedDB broke, and stayed broken through
			// DB_RETRY_MS.) Nothing it wrote counts (write keeps its pieces only once the transaction is done), so the next
			// try writes it all again.
			console.warn("[autosave] couldn't save the drawing on this device", error);
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
					if (document.visibilityState === "hidden" || this.urgent) {
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
		// (a save that waited for the pen starts in a slice of its own)
		const since = Date.now();
		if (!this.urgent) {
			await next_slice(false, since);
		}
		const urgent = () => this.urgent || document.visibilityState === "hidden";
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

		// The picture and the events it is made of, as of now (one task: the slices below only read these copies).
		const events = recorder.segment.events;
		const count = events.length;
		// A stroke under way (the page is being hidden): the copy ends it where the pointer is now, so a replay of the
		// copy has the stroke as drawn so far. Its picture isn't known until that replay, so the copy has no hash.
		const closing = open_stroke_ends(recorder, events);
		const image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
		const info = segment_info(recorder.segment);
		info.duration = Math.max(recorder.last_t, Math.round(recorder.now()));
		const blob_count = recorder.blobs.length;
		const previous = recorder.previous_segments.slice();
		/** @type {(() => void)[]} the encoding, a slice each (or all at once when urgent) */
		const jobs = [];
		// previous sessions (a revision's posted recording): written once
		previous.forEach((segment, i) => {
			if (!previous_stored[i]) {
				const name = `${this.prefix}p${i}`;
				previous_stored[i] = { info: segment_info(segment), chunks: [name], tail: null };
				jobs.push(() => puts.push({ name, data: pack_events(segment.events) }));
			}
		});
		// blobs: written once, as PNG (kept as PNG in the recorder too, so finalize doesn't encode them again)
		for (let i = 0; i < blob_count; i++) {
			if (!blob_names[i]) {
				const name = `${this.prefix}b${i}`;
				blob_names[i] = name;
				jobs.push(() => {
					const blob = recorder.blobs[i];
					const png = "png" in blob ? blob.png : encode_png(blob.image_data);
					if (!("png" in blob)) {
						recorder.blobs[i] = { png };
					}
					puts.push({ name, data: png });
				});
			}
		}
		// this session's events: sealed chunks, plus the rest as the tail
		while (count - sealed >= CHUNK_EVENTS) {
			const name = `${this.prefix}c${chunk_names.length}`;
			const list = events.slice(sealed, sealed + CHUNK_EVENTS);
			jobs.push(() => puts.push({ name, data: pack_events(list) }));
			chunk_names.push(name);
			sealed += CHUNK_EVENTS;
		}
		const rest = closing.length ? [...events.slice(sealed, count), ...closing] : events.slice(sealed, count);
		/** @type {Uint8Array} */
		let tail = new Uint8Array(0);
		jobs.push(() => {
			tail = pack_events(rest);
		});
		let sync_ms = performance.now() - start;
		for (const job of jobs) {
			if (!urgent()) {
				await next_slice(false, since);
			}
			const t = performance.now();
			job();
			sync_ms = Math.max(sync_ms, performance.now() - t);
		}
		// (the picture as of now, hashed in slices with a yield between: a big canvas at once is a long task)
		const sliced = closing.length ? null : await hash_image_data_sliced(image_data, urgent(), since);
		const hash = sliced ? sliced.hash : null;
		if (sliced) {
			sync_ms = Math.max(sync_ms, sliced.longest);
		}
		if (hash != null) {
			info.end = { hash, width: image_data.width, height: image_data.height };
		} else {
			delete info.end;
		}

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

		if (this.deleted) {
			return;
		}
		await run_tx([DRAFTS, PARTS], "readwrite", (tx) => {
			const parts = tx.objectStore(PARTS);
			for (const { name, data } of puts) {
				parts.put({ key: this.key, name, data });
			}
			tx.objectStore(DRAFTS).put(meta);
		});
		if (this.deleted) {
			// (deleted while it was writing: a submit, or Discard) the copy goes after all
			return;
		}
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
			// (its get and puts chained: committed after the puts, aborted if the page goes away first)
			const snapshot = await run_chained_tx([DRAFTS, PARTS], "readwrite", async (tx, finish) => {
				const drafts = tx.objectStore(DRAFTS);
				const meta = await req(drafts.get(this.key));
				// (deleted after a submit, or another tab saved since: leave it)
				if (!meta || meta.session !== this.session) {
					return null;
				}
				const parts = tx.objectStore(PARTS);
				parts.put({ key: this.key, name: this.snapshot_name, data: png });
				const old = meta.snapshot?.name;
				if (old && old !== this.snapshot_name) {
					parts.delete([this.key, old]);
				}
				const made = { name: this.snapshot_name, hash, at: Date.now() };
				meta.snapshot = made;
				drafts.put(meta);
				finish();
				return made;
			});
			if (!snapshot) {
				return;
			}
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
