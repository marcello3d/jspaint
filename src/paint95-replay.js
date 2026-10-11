// @ts-check
/* global airbrush_size:writable, brush_shape:writable, brush_size:writable, eraser_size:writable, my_canvas_height:writable, my_canvas_width:writable, palette:writable, pencil_size:writable, stroke_size:writable, tool_transparent_mode:writable, current_history_node, magnification, main_canvas, main_ctx, selected_colors, selection, text_tool_font, textbox */
// JSPaint.exe: replays a recorded drawing (.p95) in this same engine. Active with index.html?replay=1.
// Driven by player.js through window.paint95Replay. See docs/2draw-animation-format.md

import { cancel, deselect, get_tool_by_id, reset_canvas_and_history, reset_selected_colors, select_tools, set_magnification, update_canvas_rect } from "./functions.js";
import { $G, make_canvas } from "./helpers.js";
import { decode_p95, decode_png, hash_image_data } from "./paint95-format.js";

/** Longest idle time between events in playback (ms) */
const IDLE_CAP = 1000;
const POINTER_TYPE_NAMES = ["mouse", "pen", "touch"];

class ReplayController {
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
		/** @type {(drift: any) => void} */
		this.ondrift = () => { };
		this.done = false;
	}

	/**
	 * @param {ArrayBuffer | Uint8Array} buffer
	 */
	load(buffer) {
		this.file = decode_p95(buffer);
		const { header } = this.file;
		const timeline = [];
		let t = 0;
		header.segments.forEach((segment, seg) => {
			timeline.push({ t, seg, index: -1 });
			let raw = 0;
			let last_raw = 0;
			segment.events.forEach((event, index) => {
				raw += event[1];
				t += Math.max(0, Math.min(raw - last_raw, IDLE_CAP));
				last_raw = raw;
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
	 * Processes events up to the given playback time.
	 * @param {number} time - playback time in ms
	 * @param {number} [budget_ms] - stop after spending this long (returns false if not caught up)
	 * @returns {boolean} caught up
	 */
	advance_to(time, budget_ms = Infinity) {
		const start = performance.now();
		while (this.position < this.timeline.length && this.timeline[this.position].t <= time) {
			const entry = this.timeline[this.position++];
			try {
				this.process(entry);
			} catch (error) {
				console.error("[replay] error processing event", entry, error);
				this.drift({ type: "error", time: entry.t, message: String(error && error.message || error) });
			} finally {
				window.P95.in_dispatch = false;
				window.P95.event_time = null;
			}
			if (performance.now() - start > budget_ms) {
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

		if (seg > 0 || segment.start.type === "continue") {
			// Leave any floating selection/text box from the previous session
			deselect(true);
			cancel(true);
		}
		if (segment.start.type === "continue" && seg > 0) {
			const previous = this.file.header.segments[seg - 1];
			// The editor started from the submitted picture: the previous result cropped/padded onto white.
			let source = make_canvas(main_canvas);
			if (previous.end && previous.end.blob != null && hash_image_data(main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height)) !== previous.end.hash) {
				source = make_canvas(this.blob_image_data(previous.end.blob));
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
				const image_data = this.blob_image_data(segment.start.blob);
				main_canvas.width = image_data.width;
				main_canvas.height = image_data.height;
				main_ctx.putImageData(image_data, 0, 0);
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
			if (segment.end.blob != null) {
				deselect(true);
				this.snap(this.blob_image_data(segment.end.blob));
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
		const clientX = rect.left + (x + 0.5) * rect.width / main_canvas.width;
		const clientY = rect.top + (y + 0.5) * rect.height / main_canvas.height;
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

	/** For the player's display */
	get_frame() {
		return {
			canvas: main_canvas,
			selection: selection && selection.canvas ? { canvas: selection.canvas, x: selection.x, y: selection.y } : null,
			textbox: textbox && textbox.canvas ? { canvas: textbox.canvas, x: textbox.x, y: textbox.y } : null,
			cursor: this.cursor,
		};
	}
}

if (window.P95.replaying) {
	window.paint95Replay = new ReplayController();
}
