/* global aliasing:writable, airbrush_size:writable, brush_shape:writable, brush_size:writable, button:writable, ctrl:writable, eraser_size:writable, fill_color:writable, history_node_to_cancel_to, magnification, main_canvas, main_ctx, monochrome:writable, monochrome_palette:writable, my_canvas_height:writable, my_canvas_width:writable, palette:writable, pencil_size:writable, pick_color_slot:writable, pointer:writable, pointer_active:writable, pointer_buttons:writable, pointer_over_canvas:writable, pointer_previous:writable, pointer_start:writable, pointer_type:writable, pointers:writable, polychrome_palette:writable, return_to_magnification:writable, return_to_tools:writable, reverse:writable, saved:writable, selected_colors:writable, selected_tool:writable, selected_tools:writable, selection:writable, shift:writable, show_grid:writable, stroke_color:writable, stroke_size:writable, text_tool_font, textbox:writable, tool_transparent_mode:writable, transparency:writable, update_helper_layer_on_pointermove_active:writable */
// JSPaint.exe: in-memory checkpoints of a replay, for seeking (player only; nothing is stored in the file).
//
// A checkpoint is everything the replay needs to continue exactly as if it had replayed from the start: the canvas,
// the whole undo history (steps' patches are shared with the live history and between checkpoints), tool and option
// state, the PRNG, and the replay's own position. They're only taken between strokes: no pointer down, no floating
// selection or text box, no polygon/curve in progress, nothing to cancel back to. Pictures are kept in bands of
// BAND_WORDS pixels, run-length encoded, and a band that didn't change since the previous checkpoint is shared with it.
// See docs/2draw-animation-format.md ("Seeking").

import { set_magnification, update_canvas_rect, update_helper_layer } from "./functions.js";
import { $G } from "./helpers.js";
import { tools } from "./tools.js";

/** pixels per band (64 KB) */
const BAND_WORDS = 16384;
/** estimated bytes of a history step's record (besides its pixels) */
const RECORD_BYTES = 160;

const CONTEXT_PROPERTIES = [
	"fillStyle", "strokeStyle", "lineWidth", "lineCap", "lineJoin", "miterLimit", "lineDashOffset", "globalAlpha",
	"globalCompositeOperation", "imageSmoothingEnabled", "imageSmoothingQuality", "font", "textAlign", "textBaseline",
	"direction", "filter", "shadowBlur", "shadowColor", "shadowOffsetX", "shadowOffsetY",
];

// #region Banded pictures

/**
 * @param {Uint32Array} words
 * @returns {Uint32Array} runs as (count, value) pairs, or a copy of the words when that's not smaller
 */
function encode_band(words) {
	const n = words.length;
	const runs = new Uint32Array(Math.min(n, 4096) * 2);
	let k = 0;
	for (let i = 0; i < n;) {
		const value = words[i];
		let j = i + 1;
		while (j < n && words[j] === value) j++;
		if (k + 2 > runs.length || k + 2 >= n) {
			return words.slice(); // (raw: as big as the band)
		}
		runs[k++] = j - i;
		runs[k++] = value;
		i = j;
	}
	return runs.slice(0, k);
}

/**
 * @param {{ data: Uint32Array, raw: boolean }} band
 * @param {Uint32Array} into
 * @param {number} offset
 */
function decode_band(band, into, offset) {
	if (band.raw) {
		into.set(band.data, offset);
		return;
	}
	const runs = band.data;
	let o = offset;
	for (let k = 0; k < runs.length; k += 2) {
		const count = runs[k];
		into.fill(runs[k + 1], o, o + count);
		o += count;
	}
}

/** @param {ImageData} image_data */
function words_of(image_data) {
	return new Uint32Array(image_data.data.buffer, image_data.data.byteOffset, image_data.data.byteLength >> 2);
}

/**
 * @param {ImageData} image_data
 * @param {{ width: number, height: number, words: Uint32Array, bands: any[] } | null} previous - the previous picture
 *   kept (bands equal to its bands are shared)
 */
function encode_picture(image_data, previous) {
	const words = words_of(image_data);
	const same_size = previous && previous.width === image_data.width && previous.height === image_data.height;
	const bands = [];
	for (let offset = 0; offset < words.length; offset += BAND_WORDS) {
		const end = Math.min(words.length, offset + BAND_WORDS);
		if (same_size) {
			const old = previous.words;
			let i = offset;
			while (i < end && old[i] === words[i]) i++;
			if (i === end) {
				bands.push(previous.bands[bands.length]);
				continue;
			}
		}
		const data = encode_band(words.subarray(offset, end));
		bands.push({ data, raw: data.length === end - offset, bytes: data.byteLength });
	}
	return { width: image_data.width, height: image_data.height, bands };
}

/** @param {{ width: number, height: number, bands: any[] }} picture */
function decode_picture(picture) {
	const image_data = new ImageData(picture.width, picture.height);
	const words = words_of(image_data);
	picture.bands.forEach((band, i) => decode_band(band, words, i * BAND_WORDS));
	return image_data;
}

/** @param {ImageData} a @param {ImageData} b */
function same_pixels(a, b) {
	if (a.width !== b.width || a.height !== b.height) return false;
	const x = words_of(a);
	const y = words_of(b);
	for (let i = 0; i < x.length; i++) {
		if (x[i] !== y[i]) return false;
	}
	return true;
}

// #endregion

/** @param {any} value - copies arrays and plain objects (tool state like polygon points); other objects by reference */
function copy_value(value) {
	if (Array.isArray(value)) {
		return value.map(copy_value);
	}
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		const out = {};
		for (const key of Object.keys(value)) out[key] = copy_value(value[key]);
		return out;
	}
	return value;
}

/** @param {CanvasRenderingContext2D} ctx */
function save_context(ctx) {
	const state = {};
	for (const key of CONTEXT_PROPERTIES) state[key] = ctx[key];
	state.transform = ctx.getTransform();
	state.line_dash = ctx.getLineDash();
	return state;
}
/** @param {CanvasRenderingContext2D} ctx @param {any} state */
function restore_context(ctx, state) {
	for (const key of CONTEXT_PROPERTIES) {
		if (ctx[key] !== state[key]) ctx[key] = state[key];
	}
	ctx.setTransform(state.transform);
	ctx.setLineDash(state.line_dash);
}

/**
 * A tool's own canvas (a stroke's mask, a shape's preview): reused by the next gesture, which may not clear it.
 * @param {HTMLCanvasElement & { content_bounds?: any, ctx?: CanvasRenderingContext2D }} canvas
 */
function save_tool_canvas(canvas) {
	const bounds = canvas.content_bounds;
	const empty = bounds === null || (canvas.width <= 1 && canvas.height <= 1 && bounds === undefined);
	return {
		tool_canvas: true,
		canvas,
		width: canvas.width,
		height: canvas.height,
		bounds: bounds ? { ...bounds } : bounds,
		pixels: empty ? null : canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height),
		ctx: save_context(canvas.getContext("2d")),
	};
}
/** @param {ReturnType<typeof save_tool_canvas>} saved */
function restore_tool_canvas(saved) {
	const { canvas } = saved;
	canvas.width = saved.width; // (clears it, even at the same size)
	canvas.height = saved.height;
	restore_context(canvas.getContext("2d"), saved.ctx);
	if (saved.pixels) {
		canvas.getContext("2d").putImageData(saved.pixels, 0, 0);
	}
	if (canvas.set_content_bounds) {
		canvas.set_content_bounds(saved.bounds);
	}
	return canvas;
}

/** @param {any} tool */
function tool_state_keys(tool) {
	return Object.keys(tool).filter((key) => key[0] !== "$" && typeof tool[key] !== "function");
}

/**
 * Whether the replay is between strokes, with nothing that a checkpoint doesn't capture.
 * @param {import("./paint95-replay.js").ReplayController} controller
 */
export function can_checkpoint(controller) {
	if (controller.pointer_state.size > 0 || pointers.length > 0 || pointer_active) return false;
	if (selection || textbox || history_node_to_cancel_to) return false;
	if (window.P95.in_dispatch) return false;
	for (const tool of tools) {
		// polygon/curve (and free-form select while dragging) collect points over several gestures
		if (Array.isArray(tool.points) && tool.points.length > 0) return false;
	}
	return true;
}

export class CheckpointStore {
	/**
	 * @param {object} options
	 * @param {number} options.memory - bytes the checkpoints may use
	 * @param {number} options.interval - replay work (ms) between checkpoints
	 */
	constructor({ memory, interval }) {
		this.memory = memory;
		this.interval = interval;
		/** @type {any[]} sorted by position */
		this.list = [];
		this.bytes = 0;
		/** the last picture encoded, for sharing unchanged bands */
		this.last_picture = null;
		this.disabled = memory <= 0;
		/** recent restore times (ms), for deciding whether a forward seek should restore */
		this.restore_ms = 20;
	}

	/**
	 * Takes a checkpoint if one is due (call after processing an event).
	 * @param {import("./paint95-replay.js").ReplayController} controller
	 */
	maybe_take(controller) {
		if (this.disabled) return;
		const last = this.list[this.list.length - 1];
		if (last && (controller.position <= last.position || controller.work - last.work < this.interval)) return;
		if (!can_checkpoint(controller)) return;
		this.take(controller);
	}

	/** @param {import("./paint95-replay.js").ReplayController} controller */
	take(controller) {
		const previous = this.list[this.list.length - 1] || null;
		const canvas_image = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
		const canvas = encode_picture(canvas_image, this.last_picture);
		this.last_picture = { width: canvas.width, height: canvas.height, words: words_of(canvas_image), bands: canvas.bands };
		const history = window.P95.history_save(previous && previous.history);
		let anchor = null;
		if (history.anchor_image) {
			anchor = same_pixels(history.anchor_image, canvas_image) ? "canvas" : encode_picture(history.anchor_image, this.last_picture);
		}
		history.anchor_image = null; // (the live one changes)
		const tool_states = tools.map((tool) => {
			const state = {};
			for (const key of tool_state_keys(tool)) {
				const value = tool[key];
				state[key] = value instanceof HTMLCanvasElement ? save_tool_canvas(value) : copy_value(value);
			}
			if (tool.$options) state.$options = { stroke: tool.$options.stroke, fill: tool.$options.fill };
			return state;
		});
		const ctx_state = save_context(main_ctx);
		const canvas_area = window.$canvas_area[0];
		const checkpoint = {
			position: controller.position,
			time: controller.position > 0 ? controller.timeline[controller.position - 1].t : 0,
			work: controller.work,
			canvas,
			anchor,
			content_bounds: main_canvas.content_bounds ? { ...main_canvas.content_bounds } : null,
			ctx: ctx_state,
			history,
			globals: {
				my_canvas_width, my_canvas_height, aliasing, transparency, monochrome, magnification, return_to_magnification,
				palette: palette.slice(), polychrome_is_palette: polychrome_palette === palette, polychrome_palette: polychrome_palette.slice(),
				monochrome_is_palette: monochrome_palette === palette, monochrome_palette: monochrome_palette.slice(),
				brush_shape, brush_size, eraser_size, airbrush_size, pencil_size, stroke_size, tool_transparent_mode,
				stroke_color, fill_color, pick_color_slot, selected_tool, selected_tools: selected_tools.slice(), return_to_tools: return_to_tools.slice(),
				selected_colors: { ...selected_colors }, text_tool_font: { ...text_tool_font }, show_grid, saved,
				pointer: copy_value(pointer), pointer_start: copy_value(pointer_start), pointer_previous: copy_value(pointer_previous),
				pointer_type, pointer_buttons, reverse, ctrl, shift, button, pointer_over_canvas, update_helper_layer_on_pointermove_active,
				scroll: [canvas_area.scrollLeft, canvas_area.scrollTop],
			},
			tools: tool_states,
			p95: {
				random: window.P95.random.get_state(),
				behavior: window.P95.behavior,
				required: [window.paint95_required_width, window.paint95_required_height],
			},
			controller: {
				current: { ...controller.current },
				cursor: { ...controller.cursor },
				drifted: controller.drifted,
				consumed: [...controller.consumed],
			},
		};
		this.list.push(checkpoint);
		this.recount();
		while (this.bytes > this.memory && !this.disabled) {
			this.thin();
		}
	}

	/** Over budget: drop every other checkpoint (keeping the first) and take them half as often. */
	thin() {
		if (this.list.length <= 1) {
			// even one doesn't fit: no checkpoints (seeking back replays from the start)
			console.warn("[replay] not enough memory for seeking checkpoints");
			this.list = [];
			this.disabled = true;
			this.bytes = 0;
			this.last_picture = null;
			return;
		}
		this.list = this.list.filter((_checkpoint, i) => i % 2 === 0);
		this.interval *= 2;
		this.recount();
	}

	/** Memory held by the checkpoints: unique bands and history records, and pixels the live history no longer has. */
	recount() {
		const seen = new Set();
		let bytes = 0;
		const live = window.P95.history_pixels();
		const add_pixels = (image_data) => {
			if (image_data && image_data.data && !seen.has(image_data) && !live.has(image_data)) {
				seen.add(image_data);
				bytes += image_data.data.byteLength;
			}
		};
		const add_picture = (picture) => {
			if (!picture || picture === "canvas") return;
			for (const band of picture.bands) {
				if (!seen.has(band)) {
					seen.add(band);
					bytes += band.bytes + 32;
				}
			}
		};
		for (const checkpoint of this.list) {
			bytes += 2048 + 8 * checkpoint.history.records.length + 64 * checkpoint.controller.consumed.length;
			add_picture(checkpoint.canvas);
			add_picture(checkpoint.anchor);
			for (const state of checkpoint.tools) {
				for (const value of Object.values(state)) {
					if (value && value.tool_canvas && value.pixels) bytes += value.pixels.data.byteLength;
				}
			}
			for (const record of checkpoint.history.records) {
				if (seen.has(record)) continue;
				seen.add(record);
				bytes += RECORD_BYTES;
				if (record.patch) {
					add_pixels(record.patch.before);
					add_pixels(record.patch.after);
				}
				add_pixels(record.fields.selection_image_data);
			}
		}
		this.bytes = bytes;
	}

	/**
	 * The latest checkpoint from which replaying to `time` gives exactly the replay from the start.
	 * @param {number} time
	 */
	best_for(time) {
		let best = null;
		for (const checkpoint of this.list) {
			if (checkpoint.time > time) break;
			best = checkpoint;
		}
		return best;
	}

	/**
	 * @param {import("./paint95-replay.js").ReplayController} controller
	 * @param {any} checkpoint
	 */
	restore(controller, checkpoint) {
		const started = performance.now();
		const g = checkpoint.globals;
		// let go of what's in progress (a stroke's handlers wait for its pointerup; a floating selection or text box)
		if (controller.pointer_state.size > 0 || pointer_active || history_node_to_cancel_to) {
			$G.triggerHandler("pointerup", ["canceling", true]);
		}
		if (selection) {
			selection.destroy();
			selection = null;
		}
		if (textbox) {
			textbox.destroy();
			textbox = null;
		}
		const canvas_image = decode_picture(checkpoint.canvas);
		if (main_canvas.width !== canvas_image.width || main_canvas.height !== canvas_image.height) {
			main_canvas.width = canvas_image.width;
			main_canvas.height = canvas_image.height;
		}
		main_ctx.putImageData(canvas_image, 0, 0); // (not affected by the transform or compositing)
		restore_context(main_ctx, checkpoint.ctx);
		main_canvas.set_content_bounds(checkpoint.content_bounds);
		let anchor_image = null;
		if (checkpoint.anchor === "canvas") {
			anchor_image = canvas_image; // (putImageData copied it; this copy is the anchor's own)
		} else if (checkpoint.anchor) {
			anchor_image = decode_picture(checkpoint.anchor);
		}
		window.P95.history_restore(checkpoint.history, anchor_image);

		my_canvas_width = g.my_canvas_width;
		my_canvas_height = g.my_canvas_height;
		aliasing = g.aliasing;
		transparency = g.transparency;
		monochrome = g.monochrome;
		const palette_changed = palette.length !== g.palette.length || palette.some((color, i) => color !== g.palette[i]);
		palette = g.palette.slice();
		polychrome_palette = g.polychrome_is_palette ? palette : g.polychrome_palette.slice();
		monochrome_palette = g.monochrome_is_palette ? palette : g.monochrome_palette.slice();
		brush_shape = g.brush_shape;
		brush_size = g.brush_size;
		eraser_size = g.eraser_size;
		airbrush_size = g.airbrush_size;
		pencil_size = g.pencil_size;
		stroke_size = g.stroke_size;
		tool_transparent_mode = g.tool_transparent_mode;
		stroke_color = g.stroke_color;
		fill_color = g.fill_color;
		pick_color_slot = g.pick_color_slot;
		selected_tool = g.selected_tool;
		selected_tools = g.selected_tools.slice();
		return_to_tools = g.return_to_tools.slice();
		selected_colors = { ...g.selected_colors };
		for (const key of Object.keys(text_tool_font)) {
			if (!(key in g.text_tool_font)) delete text_tool_font[key];
		}
		Object.assign(text_tool_font, g.text_tool_font);
		show_grid = g.show_grid;
		saved = g.saved;
		pointer = copy_value(g.pointer);
		pointer_start = copy_value(g.pointer_start);
		pointer_previous = copy_value(g.pointer_previous);
		pointer_active = false;
		pointers = [];
		pointer_type = g.pointer_type;
		pointer_buttons = g.pointer_buttons;
		reverse = g.reverse;
		ctrl = g.ctrl;
		shift = g.shift;
		button = g.button;
		pointer_over_canvas = g.pointer_over_canvas;
		if (update_helper_layer_on_pointermove_active !== g.update_helper_layer_on_pointermove_active) {
			if (g.update_helper_layer_on_pointermove_active) {
				$G.on("pointermove", update_helper_layer);
			} else {
				$G.off("pointermove", update_helper_layer);
			}
			update_helper_layer_on_pointermove_active = g.update_helper_layer_on_pointermove_active;
		}
		tools.forEach((tool, i) => {
			const state = checkpoint.tools[i];
			for (const key of tool_state_keys(tool)) {
				if (!(key in state)) delete tool[key];
			}
			for (const key of Object.keys(state)) {
				if (key === "$options") continue;
				tool[key] = state[key] && state[key].tool_canvas ? restore_tool_canvas(state[key]) : copy_value(state[key]);
			}
			if (state.$options && tool.$options) {
				tool.$options.stroke = state.$options.stroke;
				tool.$options.fill = state.$options.fill;
			}
		});

		window.P95.random = window.P95.make_prng(0);
		window.P95.random.set_state(checkpoint.p95.random);
		window.P95.behavior = checkpoint.p95.behavior;
		[window.paint95_required_width, window.paint95_required_height] = checkpoint.p95.required;
		window.P95.in_dispatch = false;
		window.P95.event_time = null;

		controller.position = checkpoint.position;
		controller.work = checkpoint.work;
		controller.current = { ...checkpoint.controller.current };
		controller.cursor = { ...checkpoint.controller.cursor };
		controller.drifted = checkpoint.controller.drifted;
		controller.consumed = new Set(checkpoint.controller.consumed);
		controller.pointer_state.clear();
		controller.done = controller.position >= controller.timeline.length;

		// the UI (doesn't affect the replay, except the canvas's on-screen rectangle, which pointer events go through)
		if (palette_changed) {
			window.$colorbox?.rebuild_palette();
		}
		if (magnification !== g.magnification) {
			set_magnification(g.magnification);
		}
		return_to_magnification = g.return_to_magnification;
		window.$canvas_area.trigger("resize");
		window.$canvas_area[0].scrollLeft = g.scroll[0];
		window.$canvas_area[0].scrollTop = g.scroll[1];
		update_canvas_rect();
		$G.trigger("option-changed");
		window.$toolbox?.update_selected_tool?.();

		const elapsed = performance.now() - started;
		this.restore_ms = 0.7 * this.restore_ms + 0.3 * elapsed;
	}
}
