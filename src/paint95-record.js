// @ts-check
/* global $canvas_area, airbrush_size, brush_shape, brush_size, eraser_size, magnification, main_canvas, main_ctx, palette, pencil_size, selected_colors, selected_tools, selection, stroke_size, text_tool_font, textbox, tool_transparent_mode */
// JSPaint.exe: records the drawing session as input events (see docs/2draw-animation-format.md).

import { update_canvas_rect } from "./functions.js";
import { make_canvas } from "./helpers.js";
import { FORMAT_VERSION, encode_p95, encode_png, hash_image_data } from "./paint95-format.js";
import { tools } from "./tools.js";

const HASH_EVERY_EVENTS = 300;
const KEYFRAME_EVERY_MS = 2 * 60 * 1000;
const MAX_EVENTS = 500000;
const MAX_RAW_BYTES = 40 * 1024 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

const POINTER_TYPES = { mouse: 0, pen: 1, touch: 2 };

/** @param {any} color */
const color_value = (color) => (typeof color === "string" ? color : null);

export function get_engine_sha() {
	return document.getElementById("paint95-version")?.textContent?.trim() || "dev";
}

/**
 * The tool state that affects drawing, as recorded in "s" events.
 * (Tool selection itself is recorded as select_tool commands.)
 */
export function get_tool_state() {
	/** @type {Record<string, number>} */
	const shape_styles = {};
	for (const tool of tools) {
		if (tool.$options && "fill" in tool.$options) {
			shape_styles[tool.id] = (tool.$options.stroke ? 1 : 0) | (tool.$options.fill ? 2 : 0);
		}
	}
	return {
		bs: brush_shape,
		b: brush_size,
		e: eraser_size,
		a: airbrush_size,
		p: pencil_size,
		w: stroke_size,
		tm: tool_transparent_mode,
		fg: color_value(selected_colors.foreground),
		bg: color_value(selected_colors.background),
		tc: color_value(selected_colors.ternary),
		pal: palette.map(color_value),
		font: { ...text_tool_font },
		z: magnification,
		so: shape_styles,
	};
}

/**
 * Re-indexes blob references in a segment's events (in place).
 * @param {any} segment
 * @param {(index: number) => number} map
 */
export function remap_segment_blobs(segment, map) {
	if (segment.start && typeof segment.start.blob === "number") {
		segment.start.blob = map(segment.start.blob);
	}
	if (segment.end && typeof segment.end.blob === "number") {
		segment.end.blob = map(segment.end.blob);
	}
	for (const event of segment.events) {
		if (event[0] === "f" && event[2] === "paste") {
			event[3] = map(event[3]);
		} else if (event[0] === "b") {
			event[3] = map(event[3]);
		} else if (event[0] === "p") {
			event[2] = map(event[2]);
		}
	}
}

export class Recorder {
	/**
	 * @param {object} options
	 * @param {import("./paint95-format.js").P95File | null} [options.previous] - animation being continued
	 */
	constructor({ previous = null } = {}) {
		this.t0 = performance.now();
		this.last_t = 0;
		this.stopped = false;
		this.raw_bytes = 0;
		this.events_since_hash = 0;
		this.last_keyframe_t = 0;
		/** @type {({ png: Uint8Array } | { image_data: ImageData })[]} */
		this.blobs = [];
		/** @type {Record<string, string>} */
		this.last_state = {};
		/** @type {Map<number, number>} real pointerId -> recorded id */
		this.pointer_ids = new Map();
		/** @type {Set<number>} */
		this.active_pointers = new Set();
		/** @type {Map<number, string>} recorded id -> last "M" fields, for the short "m" form */
		this.last_move_fields = new Map();
		this.clear_timer = 0;

		this.previous_segments = [];
		if (previous) {
			for (const png of previous.blobs) {
				this.blobs.push({ png });
			}
			this.previous_segments = previous.header.segments;
			this.previous_truncated = previous.header.truncated;
		}

		const seed = crypto.getRandomValues(new Uint32Array(1))[0];
		window.P95.seed(seed);
		/** @type {import("./paint95-format.js").P95Segment} */
		this.segment = {
			seed,
			engine: { sha: get_engine_sha(), behavior: window.P95.ENGINE_BEHAVIOR },
			width: main_canvas.width,
			height: main_canvas.height,
			start: { type: "blank" },
			events: [],
			duration: 0,
		};
	}

	/**
	 * @param {object} options
	 * @param {"blank" | "image" | "continue"} options.start
	 */
	begin({ start }) {
		const image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
		if (start === "image") {
			this.segment.start = { type: "image", blob: this.add_blob(image_data) };
		} else if (start === "continue") {
			this.segment.start = { type: "continue", hash: hash_image_data(image_data) };
		} else {
			this.segment.start = { type: "blank" };
		}
		// Full initial state, including the selected tools.
		const state = get_tool_state();
		for (const [key, value] of Object.entries(state)) {
			this.last_state[key] = JSON.stringify(value);
		}
		this.segment.events.push(["s", 0, { ...state, tools: selected_tools.map((tool) => tool.id) }]);

		window.P95.recorder = this;
		this.install_listeners();
	}

	now() {
		return performance.now() - this.t0;
	}

	/** @param {ImageData} image_data */
	add_blob(image_data) {
		this.blobs.push({ image_data });
		this.raw_bytes += image_data.width * image_data.height; // rough compressed size estimate
		return this.blobs.length - 1;
	}

	/**
	 * Appends an event with the given (integer) time.
	 * @param {number} t
	 * @param {string} type
	 * @param {...any} args
	 */
	push(t, type, ...args) {
		if (this.stopped) {
			return;
		}
		const event = [type, t - this.last_t, ...args];
		this.last_t = t;
		this.segment.events.push(event);
		this.events_since_hash++;
		this.raw_bytes += 12 + (type === "t" ? String(args[0]).length : 0);
		if (this.segment.events.length > MAX_EVENTS || this.raw_bytes > MAX_RAW_BYTES) {
			// Stop recording; the final picture is still stored at the end.
			this.stopped = true;
			this.segment.truncated = true;
		}
	}

	/**
	 * Called at the start of each recorded event: records state changes, and a keyframe hash if due.
	 * @returns {number} the event time
	 */
	begin_event() {
		const t = Math.max(this.last_t, Math.round(this.now()));
		window.P95.event_time = t;
		this.record_state_changes(t);
		if (window.P95.debug && !this.stopped) {
			// debugging divergence: hash before every event
			const image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
			this.push(t, "h", hash_image_data(image_data), image_data.width, image_data.height);
		} else if (this.active_pointers.size === 0 && !this.stopped) {
			if (t - this.last_keyframe_t >= KEYFRAME_EVERY_MS) {
				const image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
				this.push(t, "p", this.add_blob(image_data), hash_image_data(image_data), image_data.width, image_data.height);
				this.last_keyframe_t = t;
				this.events_since_hash = 0;
			} else if (this.events_since_hash >= HASH_EVERY_EVENTS) {
				const image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
				this.push(t, "h", hash_image_data(image_data), image_data.width, image_data.height);
				this.events_since_hash = 0;
			}
		}
		return t;
	}

	/** @param {number} t */
	record_state_changes(t) {
		const state = get_tool_state();
		/** @type {Record<string, any>} */
		const changes = {};
		let changed = false;
		for (const [key, value] of Object.entries(state)) {
			const json = JSON.stringify(value);
			if (json !== this.last_state[key]) {
				this.last_state[key] = json;
				changes[key] = value;
				changed = true;
			}
		}
		if (changed) {
			this.push(t, "s", changes);
		}
	}

	/** Marks that a recorded event is being dispatched, until the next unrecorded event or task. */
	set_dispatching(t) {
		window.P95.in_dispatch = true;
		window.P95.event_time = t;
		clearTimeout(this.clear_timer);
		this.clear_timer = setTimeout(() => this.clear_dispatching(), 0);
	}
	clear_dispatching() {
		window.P95.in_dispatch = false;
		window.P95.event_time = null;
	}

	/**
	 * @param {EventTarget | null} target
	 * @returns {string | [string, number] | null}
	 */
	target_id(target) {
		if (!(target instanceof Element) || !$canvas_area[0].contains(target)) {
			return null;
		}
		if (target === main_canvas) {
			return "c";
		}
		for (const [key, object] of [["s", selection], ["t", textbox]]) {
			const el = object?.$el?.[0];
			if (el && el.contains(target)) {
				return [key, target === el ? -1 : [...el.querySelectorAll("*")].indexOf(target)];
			}
		}
		return "a";
	}

	/** @param {PointerEvent} e */
	canvas_coords(e) {
		const rect = window.canvas_bounding_client_rect;
		return [
			~~((e.clientX - rect.left) / rect.width * main_canvas.width),
			~~((e.clientY - rect.top) / rect.height * main_canvas.height),
		];
	}

	install_listeners() {
		/** @param {PointerEvent} e */
		const on_pointer = (e) => {
			if (this.stopped) {
				this.clear_dispatching();
				return;
			}
			let id;
			let target;
			if (e.type === "pointerdown") {
				target = this.target_id(e.target);
				if (target == null) {
					this.clear_dispatching();
					return;
				}
				if (!this.pointer_ids.has(e.pointerId)) {
					this.pointer_ids.set(e.pointerId, this.pointer_ids.size + 1);
				}
				id = this.pointer_ids.get(e.pointerId);
				this.active_pointers.add(id);
				update_canvas_rect(); // (the app does this too on canvas pointerdown; done for every recorded down so replay can match)
			} else {
				id = this.pointer_ids.get(e.pointerId);
				if (id == null || !this.active_pointers.has(id)) {
					this.clear_dispatching();
					return;
				}
			}
			const t = this.begin_event();
			const [x, y] = this.canvas_coords(e);
			const mods = (e.ctrlKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
			const pressure = Math.round((e.pressure || 0) * 255);
			if (e.type === "pointerdown") {
				this.push(t, "d", id, target, x, y, e.button, e.buttons, mods, POINTER_TYPES[e.pointerType] ?? 0, pressure, e.isPrimary ? 1 : 0);
				this.last_move_fields.delete(id);
			} else if (e.type === "pointermove") {
				const fields = `${e.button},${e.buttons},${mods},${pressure}`;
				if (this.last_move_fields.get(id) === fields) {
					this.push(t, "m", id, x, y);
				} else {
					this.push(t, "M", id, x, y, e.button, e.buttons, mods, pressure);
					this.last_move_fields.set(id, fields);
				}
			} else if (e.type === "pointerup") {
				this.push(t, "u", id, x, y, e.button, e.buttons, mods);
				this.active_pointers.delete(id);
			} else {
				this.push(t, "c", id, x, y);
				this.active_pointers.delete(id);
			}
			this.set_dispatching(t);
		};
		for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
			addEventListener(type, on_pointer, { capture: true });
		}
		// Text typed into the Text tool's box
		addEventListener("input", (e) => {
			if (!this.stopped && textbox && e.target === textbox.$editor[0]) {
				const t = this.begin_event();
				this.push(t, "t", textbox.$editor.val());
				this.set_dispatching(t);
			} else {
				this.clear_dispatching();
			}
		}, { capture: true });
		// Any other user input ends the "dispatching a recorded event" state, so UI commands get recorded.
		for (const type of ["keydown", "keyup", "click", "dblclick", "mousedown", "mouseup", "contextmenu", "wheel", "change", "focusin", "touchstart", "dragstart", "drop", "paste", "copy", "cut"]) {
			addEventListener(type, () => this.clear_dispatching(), { capture: true });
		}
		// State changes made through the UI (tool options, colors) are recorded as they happen, to keep their order.
		$(window).on("option-changed", () => {
			if (!this.stopped && !window.P95.in_dispatch && window.P95.depth === 0) {
				this.record_state_changes(Math.max(this.last_t, Math.round(this.now())));
			}
		});
	}

	/**
	 * Called by P95.cmd for commands coming from the UI.
	 * @param {string} name
	 * @param {any[]} args
	 * @returns {any[] | undefined} replacement arguments for the call
	 */
	command(name, args) {
		if (this.stopped) {
			return;
		}
		const t = this.begin_event();
		if (name === "paste") {
			// Store the image, and paste exactly what a replay will paste (normalized through ImageData).
			const [img, x, y] = args;
			const source = make_canvas(img);
			const image_data = source.ctx.getImageData(0, 0, source.width, source.height);
			const normalized = make_canvas(image_data.width, image_data.height);
			normalized.ctx.putImageData(image_data, 0, 0);
			this.push(t, "f", "paste", this.add_blob(image_data), x, y);
			return [normalized, x, y];
		}
		this.push(t, "f", name, ...args);
	}

	/** Airbrush timer tick */
	tick(fn) {
		if (this.stopped) {
			fn();
			return;
		}
		const t = this.begin_event();
		this.push(t, "k");
		const was = window.P95.in_dispatch;
		window.P95.in_dispatch = true;
		try {
			fn();
		} finally {
			window.P95.in_dispatch = was;
		}
	}

	/**
	 * Out-of-band data from hooks in the app (pixel snapshots).
	 * @param {string} kind
	 * @param {any} data
	 */
	put(kind, data) {
		if (this.stopped) {
			return;
		}
		const t = Math.max(this.last_t, window.P95.event_time ?? Math.round(this.now()));
		if (kind === "text") {
			this.push(t, "b", kind, this.add_blob(data.image_data), data.x, data.y);
		} else {
			this.push(t, "b", kind, this.add_blob(data));
		}
	}

	/**
	 * Builds the animation file for the current picture. Doesn't stop recording (submitting might fail).
	 * Never throws; returns null if the animation can't be made.
	 * @returns {Blob | null}
	 */
	finalize() {
		try {
			const image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
			const blobs = [...this.blobs, { image_data }];
			const segment = {
				...this.segment,
				events: this.segment.events.slice(),
				duration: Math.max(this.last_t, Math.round(this.now())),
				end: { hash: hash_image_data(image_data), width: image_data.width, height: image_data.height, blob: blobs.length - 1 },
			};
			const segments = [...this.previous_segments.map((s) => ({ ...s, events: s.events.slice() })), segment];
			const make_file = (/** @type {any[]} */ segs, truncated) => {
				// keep only referenced blobs, re-indexed
				const used = new Map();
				const out_blobs = [];
				const out_segments = segs.map((s) => {
					const copy = { ...s, start: { ...s.start }, end: s.end && { ...s.end }, events: s.events.map((e) => e.slice()) };
					remap_segment_blobs(copy, (index) => {
						if (!used.has(index)) {
							used.set(index, out_blobs.length);
							const blob = blobs[index];
							out_blobs.push("png" in blob ? blob.png : encode_png(blob.image_data));
						}
						return used.get(index);
					});
					return copy;
				});
				return encode_p95({
					header: {
						format: FORMAT_VERSION,
						engine: segment.engine,
						width: segment.width,
						height: segment.height,
						truncated: truncated || out_segments.some((s) => s.truncated),
						segments: out_segments,
					},
					blobs: out_blobs,
				});
			};
			const strip = (s) => ({ ...s, events: s.events.filter((e) => e[0] === "s").slice(0, 1), truncated: true });
			let bytes = make_file(segments, !!this.previous_truncated);
			if (bytes.length > MAX_FILE_BYTES) {
				// Too big: drop this session's events (keeping its start and final picture).
				bytes = make_file([...segments.slice(0, -1), strip(segment)], true);
			}
			if (bytes.length > MAX_FILE_BYTES) {
				// Still too big: keep only the start and final pictures of every session.
				bytes = make_file(segments.map(strip), true);
			}
			if (bytes.length > MAX_FILE_BYTES) {
				return null;
			}
			return new Blob([bytes], { type: "application/x-paint95-animation" });
		} catch (error) {
			console.error("Failed to build the animation", error);
			return null;
		}
	}
}
