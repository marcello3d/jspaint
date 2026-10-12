// @ts-check
/* global main_canvas, main_ctx */
// JSPaint.exe: when revising a drawing, restore the previous sessions' undo history by replaying their recording
// in the editor itself (time-sliced, with a progress box and Skip). See docs/2draw-animation-format.md.

import { $DialogWindow } from "./$ToolWindow.js";
import { E } from "./helpers.js";
import { hash_image_data } from "./paint95-format.js";
import { ReplayController } from "./paint95-replay.js";

export const RESTORE_TIMEOUT_MS = 10000;
/** Give up if the history would hold more than this (estimated from snapshot count × canvas size) */
const MEMORY_BUDGET_BYTES = 600 * 1024 * 1024;
/** Undo steps kept after restoring: about this much memory of snapshots */
const KEEP_BYTES = 256 * 1024 * 1024;

/**
 * @param {number} width
 * @param {number} height
 */
export function history_keep_for(width, height) {
	return Math.max(10, Math.min(100, Math.floor(KEEP_BYTES / (width * height * 4))));
}

/**
 * Replays the previous recording in the editor, so the undo history ends up as it was at the end of the last session.
 * @param {import("./paint95-format.js").P95File} file
 * @param {object} options
 * @param {number} options.width - required canvas size
 * @param {number} options.height
 * @param {number} options.expected_hash - hash of the picture the editor loaded (the previous version, as submitted)
 * @returns {Promise<{ ok: true, keep: number, ms: number } | { ok: false, reason: string, modified: boolean, ms: number }>}
 *   modified: whether the editor's state was touched (the caller should then start over without restoring)
 */
export async function restore_history(file, { width, height, expected_hash }) {
	const start_time = performance.now();
	const P95 = window.P95;
	const { header } = file;
	const segments = header.segments;
	const last = segments[segments.length - 1];
	const fail_early = (reason) => ({ ok: /** @type {false} */ (false), reason, modified: false, ms: 0 });
	if (!last || !last.end) return fail_early("no final picture");
	if (header.truncated || segments.some((segment) => segment.truncated)) return fail_early("truncated recording");
	if (segments.some((segment) => (segment.engine?.behavior ?? 0) > P95.ENGINE_BEHAVIOR)) return fail_early("newer engine");
	if (last.end.width !== width || last.end.height !== height) return fail_early("picture size changed");
	if (last.end.hash !== expected_hash) return fail_early("the recording doesn't end with the loaded picture");

	// Progress box; the overlay blocks input while replaying.
	const $overlay = $(E("div")).addClass("paint95-restore-overlay").appendTo("body");
	const $w = $DialogWindow("Restoring history");
	$w.addClass("paint95-restore-window");
	const $message = $(E("div")).css({ padding: "12px 16px 4px", minWidth: "240px" }).text("Restoring the undo history…");
	const $progress = $(E("progress")).attr({ max: 100, value: 0 }).css({ width: "100%", margin: "4px 0 8px" });
	$w.$main.append($message, $(E("div")).css({ padding: "0 16px" }).append($progress));
	let skipped = false;
	$w.$Button("Skip", () => { skipped = true; });
	$w.on("close", () => { skipped = true; });
	$w.center();

	const controller = new ReplayController();
	let drift = null;
	let error = null;
	let reason = null;
	P95.mode = "replay";
	try {
		controller.load_file(file);
		controller.ondrift = (details) => { drift = drift || details; };
		while (!controller.done) {
			await new Promise((resolve) => requestAnimationFrame(() => resolve()));
			controller.advance_to(Infinity, 12);
			$progress.attr("value", Math.round(100 * controller.position / controller.timeline.length));
			if (skipped) { reason = "skipped"; break; }
			if (drift) { reason = `drift (${drift.type})`; break; }
			if (performance.now() - start_time > RESTORE_TIMEOUT_MS) { reason = "timeout"; break; }
			if (P95.history_size() * main_canvas.width * main_canvas.height * 4 > MEMORY_BUDGET_BYTES) { reason = "memory"; break; }
		}
	} catch (e) {
		error = e;
		reason = `error: ${e && e.message || e}`;
	} finally {
		P95.mode = "edit";
		P95.player = null;
		P95.behavior = P95.ENGINE_BEHAVIOR;
		P95.in_dispatch = false;
		P95.event_time = null;
		$w.close();
		$overlay.remove();
	}
	const ms = Math.round(performance.now() - start_time);
	if (!reason) {
		const actual = hash_image_data(main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height));
		if (drift) {
			reason = `drift (${drift.type})`;
		} else if (actual !== last.end.hash || actual !== expected_hash) {
			reason = "final picture mismatch";
		} else if (main_canvas.width !== width || main_canvas.height !== height) {
			reason = "picture size mismatch";
		}
	}
	if (reason) {
		console.warn(`Couldn't restore the undo history (${reason}); continuing from the picture.`, error || "");
		return { ok: false, reason, modified: true, ms };
	}
	const keep = history_keep_for(width, height);
	P95.prune_history(keep);
	console.log(`Restored the undo history in ${ms} ms`);
	return { ok: true, keep, ms };
}
