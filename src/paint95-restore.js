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
import { hash_image_data } from "./paint95-format.js";
import { ReplayController } from "./paint95-replay.js";

/** Work per frame while restoring: long enough to keep frame overhead small, short enough for a live progress bar */
const RESTORE_SLICE_MS = 40;

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
 * @param {ImageData} options.expected_image_data - the picture the editor loaded (the previous version, as posted)
 * @returns {Promise<{ keep: number, snapped: boolean, drift: any, ms: number }>}
 */
export async function restore_history(file, { width, height, expected_image_data }) {
	const start_time = performance.now();
	const P95 = window.P95;

	// Progress box; the overlay blocks input while replaying. It can't be skipped or closed.
	const $overlay = $(E("div")).addClass("paint95-restore-overlay").appendTo("body");
	const $w = $DialogWindow("Restoring history");
	$w.addClass("paint95-restore-window");
	$w.find(".window-close-button").hide();
	const $message = $(E("div")).css({ padding: "12px 16px 4px", minWidth: "240px" }).text("Restoring the undo history…");
	const $progress = $(E("progress")).attr({ max: 100, value: 0 }).css({ width: "100%", margin: "4px 0 12px" });
	$w.$main.append($message, $(E("div")).css({ padding: "0 16px" }).append($progress));
	$w.center();

	const controller = new ReplayController();
	let drift = null;
	P95.mode = "replay";
	try {
		controller.load_file(file);
		controller.ondrift = (details) => { drift = drift || details; };
		await controller.prepare(); // starting pictures stored by URL
		while (!controller.done) {
			await new Promise((resolve) => requestAnimationFrame(() => resolve()));
			controller.advance_to(Infinity, RESTORE_SLICE_MS);
			$progress.attr("value", Math.round(100 * controller.position / controller.timeline.length));
		}
	} finally {
		P95.mode = "edit";
		P95.player = null;
		P95.behavior = P95.ENGINE_BEHAVIOR;
		P95.in_dispatch = false;
		P95.event_time = null;
		$w.close();
		$overlay.remove();
	}
	const keep = history_keep_for(width, height);
	P95.prune_history(keep);
	// Continue from exactly the posted picture.
	const snapped = main_canvas.width !== width || main_canvas.height !== height ||
		hash_image_data(main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height)) !== hash_image_data(expected_image_data);
	if (snapped) {
		P95.snap_to_picture(expected_image_data);
	}
	const ms = Math.round(performance.now() - start_time);
	console.log(`Restored the undo history in ${ms} ms${snapped ? ` (then set the canvas to the posted picture${drift ? `; the replay drifted: ${drift.type}` : ""})` : ""}`);
	return { keep, snapped, drift, ms };
}
