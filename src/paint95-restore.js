// @ts-check
/* global main_canvas, main_ctx */
// JSPaint.exe: when revising a drawing, resume from its recording: replay the previous sessions in the editor itself
// (time-sliced, with a progress box), so their undo history is back. See docs/2draw-animation-format.md.
//
// It always completes. If the replayed picture isn't exactly the posted one (drift, a truncated log, a size change),
// the history is kept and one more undoable step sets the canvas to the posted picture; the new segment records that
// step (start.snap), so playback reproduces it.

import { $DialogWindow } from "./$ToolWindow.js";
import { E } from "./helpers.js";
import { hash_image_data_sliced } from "./paint95-draft.js";
import { ReplayController } from "./paint95-replay.js";

/**
 * Work per slice while restoring (ms; a slice stops after the event that passes it). Short, so the page stays
 * responsive (painting, the progress bar, the host page's own work): every task well under 50 ms even on a slow phone.
 */
const RESTORE_SLICE_MS = 12;
/** The progress box shows only for a restore that takes longer than this (ms); a short one just blocks input */
const RESTORE_BOX_DELAY_MS = 300;
/** The user's input, ignored while restoring (the replay drives the engine; a stroke or a shortcut now would land on a
 * half-replayed picture and history). The replay's own events are jQuery triggers, not these. */
const BLOCKED_INPUT_EVENTS = [
	"pointerdown", "pointermove", "pointerup", "pointercancel", "mousedown", "mousemove", "mouseup", "click", "dblclick",
	"contextmenu", "touchstart", "touchmove", "touchend", "touchcancel", "wheel", "keydown", "keypress", "keyup",
	"copy", "cut", "paste", "dragover", "drop", "gesturestart", "gesturechange", "gestureend",
];

/** A task boundary with no idle wait (a message, not a timer or frame). */
function make_yield() {
	const channel = new MessageChannel();
	let pending = null;
	channel.port1.onmessage = () => {
		const resolve = pending;
		pending = null;
		resolve?.();
	};
	return () => new Promise((resolve) => {
		pending = resolve;
		channel.port2.postMessage(null);
	});
}
/** The next frame, or a moment (a hidden page has no frames, and restoring must not wait for it to be shown). */
const next_frame_or_timeout = (ms) => new Promise((resolve) => {
	const timer = setTimeout(resolve, ms);
	requestAnimationFrame(() => {
		clearTimeout(timer);
		resolve();
	});
});

/**
 * Undo steps kept after restoring (the engine's own history limit; see P95.history_keep_for)
 * @param {number} width
 * @param {number} height
 */
export function history_keep_for(width, height) {
	// ENGINE_BEHAVIOR 4: steps are patches and the engine trims the history by memory, so keep (nearly) all of it
	return window.P95.ENGINE_BEHAVIOR >= 4 ? 10000 : window.P95.history_keep_for(width, height);
}

/**
 * Replays the previous recording in the editor, so the undo history ends up as it was at the end of the last session,
 * then makes sure the canvas is the posted picture.
 * @param {import("./paint95-format.js").P95File} file
 * @param {object} options
 * @param {number} options.width - required canvas size
 * @param {number} options.height
 * @param {ImageData} [options.expected_image_data] - the picture the editor loaded (the previous version, as posted)
 * @param {number} [options.expected_hash] - instead of expected_image_data (a device draft): the hash the replay should
 *   end on (hash_image_data)...
 * @param {(() => ImageData | null) | null} [options.fallback_picture] - ...and the picture to set if it doesn't
 * @param {string} [options.title] - of the progress box
 * @param {string} [options.message]
 * @param {Uint8Array | null} [options.preview] - a PNG of the picture the replay ends on, shown over the canvas meanwhile
 * @returns {Promise<{ keep: number, snapped: boolean, drift: any, ms: number, matched: boolean, stats: any, hash: number | null }>}
 */
export async function restore_history(file, { width, height, expected_image_data, expected_hash, fallback_picture = null, title = "Restoring history", message = "Restoring the undo history…", preview = null }) {
	const start_time = performance.now();
	const P95 = window.P95;

	// The overlay and the input blocker keep the user off the canvas while replaying; the progress box (which can't be
	// skipped or closed) shows if it takes a while. A preview (the saved picture) can cover the canvas meanwhile.
	const $overlay = $(E("div")).addClass("paint95-restore-overlay paint95-restore-overlay-quiet").appendTo("body");
	const block = (/** @type {Event} */ event) => {
		event.stopImmediatePropagation();
		// (keys keep their browser default: reload, back and the like still work)
		if (event.cancelable && !/^key|move$/.test(event.type)) {
			event.preventDefault();
		}
	};
	for (const type of BLOCKED_INPUT_EVENTS) {
		window.addEventListener(type, block, { capture: true, passive: false });
	}
	/** @type {any} */
	let $w = null;
	/** @type {any} */
	let $progress = null;
	const show_box = () => {
		$overlay.removeClass("paint95-restore-overlay-quiet");
		$w = $DialogWindow(title);
		$w.addClass("paint95-restore-window");
		$w.find(".window-close-button").hide();
		const $message = $(E("div")).css({ padding: "12px 16px 4px", minWidth: "240px" }).text(message);
		$progress = $(E("progress")).attr({ max: 100, value: 0 }).css({ width: "100%", margin: "4px 0 12px" });
		$w.$main.append($message, $(E("div")).css({ padding: "0 16px" }).append($progress));
		$w.center();
	};
	// (in a box over the canvas area, clipped to it like the canvas is)
	/** @type {HTMLDivElement | null} */
	let preview_box = null;
	/** @type {HTMLImageElement | null} */
	let preview_img = null;
	let preview_url = null;
	const place_preview = () => {
		if (!preview_box || !preview_img) return;
		const area = window.$canvas_area[0].getBoundingClientRect();
		const rect = main_canvas.getBoundingClientRect();
		Object.assign(preview_box.style, { left: `${area.left}px`, top: `${area.top}px`, width: `${area.width}px`, height: `${area.height}px` });
		Object.assign(preview_img.style, { left: `${rect.left - area.left}px`, top: `${rect.top - area.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
	};
	if (preview) {
		try {
			preview_url = URL.createObjectURL(new Blob([preview], { type: "image/png" }));
			preview_box = /** @type {HTMLDivElement} */ (E("div"));
			preview_box.className = "paint95-restore-preview-box";
			preview_img = /** @type {HTMLImageElement} */ (E("img"));
			preview_img.className = "paint95-restore-preview";
			preview_img.alt = "";
			preview_img.src = preview_url;
			preview_box.appendChild(preview_img);
			document.body.appendChild(preview_box);
			place_preview();
		} catch (error) {
			console.warn("[restore] no preview", error);
		}
	}

	const controller = new ReplayController();
	let drift = null;
	/** for the console and tests: slices, replay work (ms), the longest slice (ms) and what it ended with */
	const stats = { slices: 0, work: 0, longest: 0, longest_at: "", after_ms: 0 };
	let frames_on = true;
	const keep = history_keep_for(width, height);
	let after_start = 0;
	/** @type {number | null} */
	let actual_hash = null;
	/** @type {number | null} */
	let expected_image_hash = null;
	P95.mode = "replay";
	try {
		controller.load_file(file);
		controller.ondrift = (details) => { drift = drift || details; };
		await controller.prepare(); // starting pictures stored by URL
		// Work in short slices, yielding with a message (no idle wait for a frame) so input, painting and the host page
		// get their turn in between. Browsers paint between such tasks; if one doesn't for a while, wait for a frame,
		// so the canvas and the progress bar are seen to move.
		const yield_to_browser = make_yield();
		let last_frame = performance.now();
		const on_frame = () => {
			last_frame = performance.now();
			if (frames_on) requestAnimationFrame(on_frame);
		};
		requestAnimationFrame(on_frame);
		while (!controller.done) {
			await yield_to_browser();
			if (performance.now() - last_frame > 250) {
				await next_frame_or_timeout(50);
				last_frame = performance.now();
			}
			if (!$w && performance.now() - start_time > RESTORE_BOX_DELAY_MS) {
				show_box();
				await yield_to_browser();
			}
			const slice_start = performance.now();
			const from = controller.position;
			controller.advance_to(Infinity, RESTORE_SLICE_MS);
			const slice_ms = performance.now() - slice_start;
			stats.slices++;
			stats.work += slice_ms;
			if (slice_ms > stats.longest) {
				stats.longest = slice_ms;
				const entry = controller.timeline[controller.position - 1];
				const event = entry && entry.index >= 0 ? controller.file.header.segments[entry.seg].events[entry.index] : null;
				stats.longest_at = `${controller.position - from} events, last ${event ? event[0] + (event[0] === "f" ? ` ${event[2]}` : "") : entry?.index === -1 ? "segment start" : "segment end"}`;
			}
			$progress?.attr("value", Math.round(100 * controller.position / controller.timeline.length));
			place_preview();
		}
		// (still keeping the user off: the picture is hashed in slices)
		after_start = performance.now();
		P95.prune_history(keep);
		actual_hash = (await hash_image_data_sliced(main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height))).hash;
		if (expected_image_data) {
			expected_image_hash = (await hash_image_data_sliced(expected_image_data)).hash;
		}
	} finally {
		frames_on = false;
		P95.mode = "edit";
		P95.flush_ui(); // the tool options and color box, as the replay left them
		P95.player = null;
		P95.behavior = P95.ENGINE_BEHAVIOR;
		P95.in_dispatch = false;
		P95.event_time = null;
		$w?.close();
		$overlay.remove();
		preview_box?.remove();
		if (preview_url) URL.revokeObjectURL(preview_url);
		for (const type of BLOCKED_INPUT_EVENTS) {
			window.removeEventListener(type, block, { capture: true });
		}
	}
	// Continue from exactly the posted picture.
	let snapped = false;
	let matched;
	if (expected_image_data) {
		matched = actual_hash === expected_image_hash;
		snapped = main_canvas.width !== width || main_canvas.height !== height || !matched;
		if (snapped) {
			P95.snap_to_picture(expected_image_data);
		}
	} else {
		// A device draft: the replay should end exactly where the draft was saved; if not, set its snapshot.
		// (no hash: saved mid-stroke, its picture is whatever the replay ends on)
		matched = expected_hash == null || actual_hash === expected_hash;
		const picture = matched ? null : fallback_picture?.() ?? null;
		if (picture) {
			P95.snap_to_picture(picture);
			snapped = true;
		}
	}
	const ms = Math.round(performance.now() - start_time);
	stats.after_ms = performance.now() - after_start;
	{
		const { ms: event_ms, entry, tool } = controller.longest_event;
		const event = entry && entry.index >= 0 ? controller.file.header.segments[entry.seg].events[entry.index] : null;
		stats.longest_event = `${Math.round(event_ms)} ms (${tool}): ${event ? JSON.stringify(event).slice(0, 60) : entry?.index === -1 ? "segment start" : "segment end"}`;
	}
	console.log(`Restored the undo history in ${ms} ms (${stats.slices} slices, ${Math.round(stats.work)} ms of work, longest ${Math.round(stats.longest)} ms: ${stats.longest_at}; longest event ${stats.longest_event}; then ${Math.round(stats.after_ms)} ms)${snapped ? ` (then set the canvas to the ${expected_image_data ? "posted picture" : "saved snapshot"}${drift ? `; the replay drifted: ${drift.type}` : ""})` : ""}${matched ? "" : " (the replay did not end on the expected picture)"}`);
	// the picture's hash, for the recorder (unless it was just set to another picture)
	const hash = snapped ? null : actual_hash;
	return { keep, snapped, drift, ms, matched, stats, hash };
}
