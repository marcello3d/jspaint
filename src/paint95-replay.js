// @ts-check
/* global airbrush_size:writable, brush_shape:writable, brush_size:writable, eraser_size:writable, my_canvas_height:writable, my_canvas_width:writable, palette:writable, pencil_size:writable, stroke_size:writable, tool_transparent_mode:writable, current_history_node, magnification, main_canvas, main_ctx, selected_colors, selection, text_tool_font, textbox */
// JSPaint.exe: replays a recorded drawing (.p95) in this same engine. Active with index.html?replay=1.
// Driven by player.js through window.paint95Replay. See docs/2draw-animation-format.md

import { cancel, deselect, get_tool_by_id, render_canvas_view, reset_canvas_and_history, reset_selected_colors, select_tools, set_magnification, update_canvas_rect } from "./functions.js";
import { $G, make_canvas } from "./helpers.js";
import { CheckpointStore } from "./paint95-checkpoint.js";
import { load_picture_image_data } from "./paint95-fetch.js";
import { decode_p95, decode_png, hash_image_data } from "./paint95-format.js";

// Playback timing (display only; the replayed engine always sees the recorded times).
/** While a pointer is down, recorded timing is kept, except a pointer held still longer than this (ms) */
const STROKE_IDLE_CAP_MS = 1000;
/** Longest pause between strokes / picture-changing commands (ms) */
const BETWEEN_STROKES_CAP_MS = 250;
/** Commands that don't change the picture take no playback time */
const UI_ONLY_COMMANDS = new Set(["select_tool"]);

/**
 * Playback time taken by the gap before an event.
 * @param {any[]} event
 * @param {number} gap - recorded ms since the previous event
 * @param {boolean} pointer_down - whether a pointer was down before this event
 */
function playback_gap(event, gap, pointer_down) {
	if (pointer_down) {
		return Math.min(gap, STROKE_IDLE_CAP_MS);
	}
	const type = event[0];
	if (type === "s" || type === "h" || type === "p" || type === "b" || (type === "f" && UI_ONLY_COMMANDS.has(event[2]))) {
		return 0;
	}
	return Math.min(gap, BETWEEN_STROKES_CAP_MS);
}
const POINTER_TYPE_NAMES = ["mouse", "pen", "touch"];

export class ReplayController {
	constructor() {
		/** @type {import("./paint95-format.js").P95File | null} */
		this.file = null;
		/** @type {{ t: number, seg: number, index: number }[]} flattened timeline; index -1 = segment start, -2 = segment end */
		this.timeline = [];
		this.position = 0;
		this.duration = 0;
		/** @type {Map<number, ImageData>} */
		this.decoded = new Map();
		/** @type {Set<string>} consumed "b" events, as "seg:index" */
		this.consumed = new Set();
		this.current = { seg: 0, index: 0 };
		/** @type {Map<number, { pointerType: string, button: number, buttons: number, mods: number, pressure: number, isPrimary: boolean }>} */
		this.pointer_state = new Map();
		/** cursor for the player's overlay */
		this.cursor = { x: 0, y: 0, down: false, visible: false };
		this.drifted = false;
		/** @type {Map<number, ImageData>} starting pictures stored by reference (fetched and hash-verified by prepare()) */
		this.start_images = new Map();
		/** @type {ImageData | null} the final picture from the page (player.js finalImageUrl), for the end snap */
		this.final_image = null;
		/** @type {(drift: any) => void} */
		this.ondrift = () => { };
		this.done = false;
		/** bumped for every processed event, so the player can skip redrawing an unchanged frame */
		this.version = 0;
		/** replay work so far (ms, as measured while first replaying each part; checkpoints keep it) */
		this.work = 0;
		/** @type {CheckpointStore | null} in-memory checkpoints for seeking (enable_checkpoints) */
		this.checkpoints = null;
	}

	/**
	 * Keeps in-memory checkpoints while replaying, so seek() can go back without replaying from the start.
	 * @param {object} [options]
	 * @param {number} [options.memory] - bytes they may use (default 64 MB)
	 * @param {number} [options.interval] - replay work (ms) between checkpoints (default 250)
	 */
	enable_checkpoints({ memory = 64 * 1024 * 1024, interval = 250 } = {}) {
		this.checkpoints = new CheckpointStore({ memory, interval });
	}

	/**
	 * Gets ready to advance_to(time): restores the latest checkpoint at or before it when the replay is already past
	 * it, or when that checkpoint is far enough ahead to be quicker than replaying there.
	 * @param {number} time
	 * @returns {boolean} false if it's past the time with no checkpoint to go back to (replay from the start instead)
	 */
	seek(time) {
		const past = this.position > 0 && this.timeline[this.position - 1].t > time;
		const store = this.checkpoints;
		const checkpoint = store && !store.disabled ? store.best_for(time) : null;
		if (past && !checkpoint) {
			return false;
		}
		if (checkpoint && (past || (checkpoint.position > this.position && checkpoint.work - this.work > 2 * store.restore_ms))) {
			try {
				store.restore(this, checkpoint);
			} catch (error) {
				console.error("[replay] couldn't restore a checkpoint", error);
				store.disabled = true;
				store.list = [];
				return !past;
			}
			this.version++;
		}
		return true;
	}

	/**
	 * @param {ArrayBuffer | Uint8Array} buffer
	 */
	load(buffer) {
		return this.load_file(decode_p95(buffer));
	}

	/**
	 * @param {import("./paint95-format.js").P95File} file
	 */
	load_file(file) {
		this.file = file;
		const { header } = this.file;
		const timeline = [];
		let t = 0;
		header.segments.forEach((segment, seg) => {
			timeline.push({ t, seg, index: -1 });
			const pointers_down = new Set();
			segment.events.forEach((event, index) => {
				// (the recorded time before a zero-time event is skipped, not carried over to the next event)
				t += playback_gap(event, Math.max(0, event[1]), pointers_down.size > 0);
				if (event[0] === "d") {
					pointers_down.add(event[2]);
				} else if (event[0] === "u" || event[0] === "c") {
					pointers_down.delete(event[2]);
				}
				timeline.push({ t, seg, index });
			});
			timeline.push({ t, seg, index: -2 });
		});
		this.timeline = timeline;
		this.duration = t;
		this.position = 0;
		window.P95.player = this;
		return { duration: this.duration, width: header.width, height: header.height, truncated: header.truncated, segments: header.segments.length };
	}

	/**
	 * Fetches what the file refers to instead of embedding: starting pictures stored by URL (verified against their
	 * hash), and the final picture for the end snap. Never throws; missing pictures are handled during replay.
	 * @param {object} [options]
	 * @param {string | null} [options.final_image_url]
	 */
	async prepare({ final_image_url = null } = {}) {
		const segments = this.file.header.segments;
		const jobs = segments.map(async (segment, seg) => {
			const { start } = segment;
			if (!start.url) return;
			try {
				const image_data = await load_picture_image_data(start.url, segment.width, segment.height);
				if (hash_image_data(image_data) === start.hash) {
					this.start_images.set(seg, image_data);
				} else {
					console.warn(`[replay] starting picture ${start.url} doesn't match its hash`);
				}
			} catch (error) {
				console.warn(`[replay] couldn't load the starting picture ${start.url}`, error);
			}
		});
		if (final_image_url) {
			const last = segments[segments.length - 1];
			jobs.push((async () => {
				try {
					this.final_image = await load_picture_image_data(final_image_url, last.width, last.height);
				} catch (error) {
					console.warn(`[replay] couldn't load the final picture ${final_image_url}`, error);
				}
			})());
		}
		await Promise.all(jobs);
	}

	/**
	 * Processes events up to the given playback time.
	 * @param {number} time - playback time in ms
	 * @param {number} [budget_ms] - stop after spending this long (returns false if not caught up)
	 * @returns {boolean} caught up
	 */
	advance_to(time, budget_ms = Infinity) {
		const start = performance.now();
		let last = start;
		while (this.position < this.timeline.length && this.timeline[this.position].t <= time) {
			const entry = this.timeline[this.position++];
			this.version++;
			try {
				this.process(entry);
			} catch (error) {
				console.error("[replay] error processing event", entry, error);
				this.drift({ type: "error", time: entry.t, message: String(error && error.message || error) });
			} finally {
				window.P95.in_dispatch = false;
				window.P95.event_time = null;
			}
			let now = performance.now();
			this.work += now - last;
			if (this.checkpoints) {
				this.checkpoints.maybe_take(this);
				now = performance.now();
			}
			last = now;
			if (now - start > budget_ms) {
				break;
			}
		}
		this.done = this.position >= this.timeline.length;
		return this.position >= this.timeline.length || this.timeline[this.position].t > time;
	}

	/** @param {{ t: number, seg: number, index: number }} entry */
	process(entry) {
		const segment = this.file.header.segments[entry.seg];
		this.current = { seg: entry.seg, index: entry.index };
		if (entry.index === -1) {
			this.start_segment(segment, entry.seg);
			return;
		}
		if (entry.index === -2) {
			this.end_segment(segment, entry);
			return;
		}
		const event = segment.events[entry.index];
		// event time within the segment (virtual clock)
		const t = this.segment_time(segment, entry.index);
		switch (event[0]) {
			case "d": case "M": case "m": case "u": case "c":
				this.pointer_event(event, t);
				break;
			case "s":
				this.apply_state(event[2]);
				break;
			case "k":
				window.P95.in_dispatch = true;
				window.P95.event_time = t;
				window.P95.commands.tick();
				break;
			case "t":
				if (textbox) {
					textbox.$editor.val(event[2]);
					textbox.$editor.trigger("input");
				} else {
					this.drift_note("text input without a text box");
				}
				break;
			case "f": {
				const [, , name, ...args] = event;
				const command = window.P95.commands[name];
				if (command) {
					window.P95.event_time = t;
					command(...args);
				} else {
					this.drift_note(`unknown command ${name}`);
				}
				break;
			}
			case "b":
				// consumed by hooks in the app via take()
				break;
			case "h":
				this.check_keyframe(event[2], null, entry.t);
				break;
			case "p":
				this.check_keyframe(event[3], event[2], entry.t);
				break;
			default:
				console.warn("[replay] unknown event type", event[0]);
		}
	}

	segment_time(segment, index) {
		// cache cumulative times per segment
		if (!segment._times) {
			let raw = 0;
			segment._times = segment.events.map((event) => (raw += event[1]));
		}
		return segment._times[index];
	}

	start_segment(segment, seg) {
		window.P95.seed(segment.seed);
		window.P95.behavior = segment.engine?.behavior ?? window.P95.ENGINE_BEHAVIOR;
		if (window.P95.behavior > window.P95.ENGINE_BEHAVIOR) {
			console.warn(`[replay] recorded with a newer engine (behavior ${window.P95.behavior}); relying on keyframes`);
		}
		window.paint95_required_width = segment.width;
		window.paint95_required_height = segment.height;
		this.pointer_state.clear();
		this.drifted = false;

		if (segment.start.type === "continue" && segment.start.history && seg > 0) {
			// The editor restored the previous sessions' undo history (by replaying them) and continued from there.
			// See paint95-restore.js; this must do exactly what the editor did after restoring.
			my_canvas_width = segment.width;
			my_canvas_height = segment.height;
			window.P95.prune_history(segment.start.keep);
			if (segment.start.snap) {
				// the editor then set the canvas to the posted picture, as an undoable step
				const picture = segment.start.blob != null ? this.blob_image_data(segment.start.blob) : this.start_images.get(seg);
				if (picture) {
					window.P95.snap_to_picture(picture);
				} else {
					this.drift({ type: "start", segment: seg, message: "posted picture unavailable" });
				}
			}
			const actual = hash_image_data(main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height));
			if (actual !== segment.start.hash) {
				this.drift({ type: "start", segment: seg, expected: segment.start.hash, actual });
			}
			window.$canvas_area.trigger("resize");
			return;
		}

		if (seg > 0 || segment.start.type === "continue") {
			// Leave any floating selection/text box from the previous session
			deselect(true);
			cancel(true);
		}
		if (segment.start.type === "continue" && seg > 0) {
			const previous = this.file.header.segments[seg - 1];
			// The editor started from the submitted picture: the previous result cropped/padded onto white.
			let source = make_canvas(main_canvas);
			if (previous.end && hash_image_data(main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height)) !== previous.end.hash) {
				// the previous session drifted: start from the real picture (by reference, or v1's stored final picture)
				if (this.start_images.has(seg)) {
					source = make_canvas(this.start_images.get(seg));
				} else if (previous.end.blob != null) {
					source = make_canvas(this.blob_image_data(previous.end.blob));
				}
			}
			my_canvas_width = segment.width;
			my_canvas_height = segment.height;
			reset_selected_colors();
			main_canvas.width = segment.width;
			main_canvas.height = segment.height;
			main_ctx.disable_image_smoothing();
			main_ctx.fillStyle = "#ffffff";
			main_ctx.fillRect(0, 0, main_canvas.width, main_canvas.height);
			main_ctx.drawImage(source, 0, 0);
			const actual = hash_image_data(main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height));
			if (actual !== segment.start.hash) {
				this.drift({ type: "start", segment: seg, expected: segment.start.hash, actual });
			}
		} else {
			my_canvas_width = segment.width;
			my_canvas_height = segment.height;
			reset_selected_colors();
			reset_canvas_and_history();
			if (segment.start.type === "image") {
				const image_data = segment.start.blob != null ? this.blob_image_data(segment.start.blob) : this.start_images.get(seg);
				if (image_data) {
					main_canvas.width = image_data.width;
					main_canvas.height = image_data.height;
					main_ctx.putImageData(image_data, 0, 0);
				} else {
					// starting picture unavailable: replay from white; the end snaps to the final picture
					this.drift({ type: "start", segment: seg, message: "starting picture unavailable" });
				}
			}
		}
		window.P95.reset_history_keeping_canvas();
		window.$canvas_area.trigger("resize");
	}

	end_segment(segment, entry) {
		if (!segment.end) {
			return;
		}
		const image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
		const actual = hash_image_data(image_data);
		if (actual !== segment.end.hash || segment.truncated) {
			if (actual !== segment.end.hash && !segment.truncated) {
				this.drift({ type: "end", time: entry.t, expected: segment.end.hash, actual });
			}
			const is_last = segment === this.file.header.segments[this.file.header.segments.length - 1];
			if (segment.end.blob != null) {
				deselect(true);
				this.snap(this.blob_image_data(segment.end.blob));
			} else if (is_last && this.final_image) {
				deselect(true);
				this.snap(this.final_image);
			}
		}
	}

	/**
	 * @param {number} expected_hash
	 * @param {number | null} blob
	 * @param {number} time
	 */
	check_keyframe(expected_hash, blob, time) {
		const actual = hash_image_data(main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height));
		if (actual === expected_hash) {
			this.drifted = false;
			return;
		}
		if (!this.drifted) {
			this.drift({ type: "keyframe", time, expected: expected_hash, actual });
		}
		this.drifted = true;
		if (blob != null) {
			this.snap(this.blob_image_data(blob));
			this.drifted = false;
		}
	}

	/** @param {ImageData} image_data */
	snap(image_data) {
		if (main_canvas.width !== image_data.width || main_canvas.height !== image_data.height) {
			main_canvas.width = image_data.width;
			main_canvas.height = image_data.height;
			main_ctx.disable_image_smoothing();
		}
		main_ctx.putImageData(image_data, 0, 0);
		current_history_node.image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
		window.$canvas_area.trigger("resize");
	}

	drift(details) {
		console.warn("[replay] drift", details);
		try {
			this.ondrift(details);
		} catch (error) {
			console.error(error);
		}
	}
	drift_note(message) {
		console.warn("[replay]", message);
	}

	/** @param {number} index */
	blob_image_data(index) {
		if (!this.decoded.has(index)) {
			this.decoded.set(index, decode_png(this.file.blobs[index]));
		}
		return this.decoded.get(index);
	}
	/** @param {number} index */
	blob_canvas(index) {
		const image_data = this.blob_image_data(index);
		const canvas = make_canvas(image_data.width, image_data.height);
		canvas.ctx.putImageData(image_data, 0, 0);
		return canvas;
	}

	/**
	 * Returns the next recorded out-of-band data of this kind after the current event (for hooks in the app).
	 * @param {string} kind
	 */
	take(kind) {
		const { seg, index } = this.current;
		const events = this.file.header.segments[seg].events;
		for (let i = Math.max(0, index + 1); i < events.length; i++) {
			const event = events[i];
			if (event[0] === "b" && event[2] === kind && !this.consumed.has(`${seg}:${i}`)) {
				this.consumed.add(`${seg}:${i}`);
				const image_data = this.blob_image_data(event[3]);
				if (kind === "text") {
					return { x: event[4], y: event[5], image_data };
				}
				return image_data;
			}
			// don't look past the next user action
			if (event[0] === "d" || event[0] === "f" || event[0] === "t") {
				break;
			}
		}
		this.drift_note(`missing ${kind} data`);
		return undefined;
	}

	apply_state(changes) {
		if ("tools" in changes) {
			select_tools(changes.tools.map((id) => get_tool_by_id(id)).filter(Boolean));
		}
		if ("bs" in changes) brush_shape = changes.bs;
		if ("b" in changes) brush_size = changes.b;
		if ("e" in changes) eraser_size = changes.e;
		if ("a" in changes) airbrush_size = changes.a;
		if ("p" in changes) pencil_size = changes.p;
		if ("w" in changes) stroke_size = changes.w;
		if ("tm" in changes) tool_transparent_mode = changes.tm;
		if (changes.fg != null) selected_colors.foreground = changes.fg;
		if (changes.bg != null) selected_colors.background = changes.bg;
		if ("tc" in changes) selected_colors.ternary = changes.tc ?? "";
		if ("pal" in changes) {
			palette = changes.pal.map((color, i) => color ?? palette[i]);
			window.$colorbox?.rebuild_palette();
		}
		if ("font" in changes) Object.assign(text_tool_font, changes.font);
		if ("so" in changes) {
			for (const [id, bits] of Object.entries(changes.so)) {
				const tool = get_tool_by_id(id);
				if (tool?.$options) {
					tool.$options.stroke = !!(bits & 1);
					tool.$options.fill = !!(bits & 2);
				}
			}
		}
		if ("z" in changes && changes.z !== magnification) {
			set_magnification(changes.z);
		}
		$G.trigger("option-changed");
	}

	pointer_event(event, t) {
		const type = event[0];
		const pid = event[2];
		let target = window;
		let x;
		let y;
		/** @type {any} */
		let state = this.pointer_state.get(pid);
		if (type === "d") {
			const [, , , target_id, ex, ey, button, buttons, mods, ptype, pressure, primary] = event;
			x = ex;
			y = ey;
			state = { pointerType: POINTER_TYPE_NAMES[ptype] || "mouse", button, buttons, mods, pressure, isPrimary: !!primary };
			this.pointer_state.set(pid, state);
			update_canvas_rect();
			target = this.resolve_target(target_id);
			if (!target) {
				this.drift_note(`pointerdown target ${JSON.stringify(target_id)} not found`);
				return;
			}
		} else {
			if (!state) {
				return;
			}
			x = event[3];
			y = event[4];
			if (type === "M") {
				[state.button, state.buttons, state.mods, state.pressure] = event.slice(5, 9);
			} else if (type === "u") {
				[state.button, state.buttons, state.mods] = event.slice(5, 8);
			} else if (type === "m") {
				// same fields as the last M for this pointer
			}
		}
		const rect = window.canvas_bounding_client_rect;
		// The engine truncates toward zero (~~): pixel n > 0 came from [n, n + 1), n < 0 from (n - 1, n], and 0 from (-1, 1);
		// aim for the middle of that range.
		const center = (n) => (n > 0 ? n + 0.5 : n < 0 ? n - 0.5 : 0);
		const clientX = rect.left + center(x) * rect.width / main_canvas.width;
		const clientY = rect.top + center(y) * rect.height / main_canvas.height;
		const jq_type = { d: "pointerdown", M: "pointermove", m: "pointermove", u: "pointerup", c: "pointercancel" }[type];
		const props = {
			clientX, clientY, pageX: clientX, pageY: clientY, screenX: clientX, screenY: clientY,
			button: type === "m" || type === "M" ? state.button : (type === "c" ? -1 : state.button),
			buttons: type === "c" ? 0 : state.buttons,
			ctrlKey: !!(state.mods & 1), shiftKey: !!(state.mods & 2), altKey: !!(state.mods & 4), metaKey: !!(state.mods & 8),
			pointerId: pid,
			pointerType: state.pointerType,
			pressure: state.pressure / 255,
			isPrimary: state.isPrimary,
		};
		this.cursor = { x, y, down: type !== "u" && type !== "c" && (props.buttons & 3) !== 0, visible: true };
		if (type === "u" || type === "c") {
			this.pointer_state.delete(pid);
		}
		window.P95.in_dispatch = true;
		window.P95.event_time = t;
		$(target).trigger($.Event(jq_type, props));
	}

	/** @param {any} target_id */
	resolve_target(target_id) {
		if (target_id === "c") {
			return main_canvas;
		}
		if (target_id === "a") {
			return window.$canvas_area[0];
		}
		if (Array.isArray(target_id)) {
			const [key, index] = target_id;
			const object = key === "s" ? selection : textbox;
			const el = object?.$el?.[0];
			if (!el) {
				return null;
			}
			return index === -1 ? el : el.querySelectorAll("*")[index] || null;
		}
		return null;
	}

	/** The document canvas itself */
	get_document_canvas() {
		return main_canvas;
	}

	/**
	 * For the player's display: what the user saw, i.e. the document plus in-progress strokes/shape previews
	 * (which tools draw on a mask or preview canvas until the pointer is released), the floating selection and text box.
	 * Rendered like the engine's thumbnail view.
	 */
	get_frame() {
		if (!this.view_canvas) {
			this.view_canvas = make_canvas(1, 1);
		}
		const view = this.view_canvas;
		if (view.width !== main_canvas.width || view.height !== main_canvas.height) {
			view.width = main_canvas.width;
			view.height = main_canvas.height;
			view.ctx.disable_image_smoothing();
		}
		try {
			render_canvas_view(view, 1, 0, 0, false);
		} catch (error) {
			console.warn("[replay] failed to render the view", error);
			view.ctx.drawImage(main_canvas, 0, 0);
		}
		return {
			canvas: view,
			selection: null, // (included in the view)
			textbox: null,
			cursor: this.cursor,
		};
	}
}

if (window.P95.replaying) {
	window.paint95Replay = new ReplayController();
}
