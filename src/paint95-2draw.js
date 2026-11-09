// @ts-check
/* global current_history_node:writable, main_canvas, main_ctx, saved:writable, undos, redos */
// JSPaint.exe: integration with the 2draw.net draw page.
//
// Embed contract:
//   <iframe src="/applet/paint95/index.html?w=<width>&h=<height>[&load=<url-encoded PNG/JPG URL>]">
//   The (same-origin) parent window may expose:
//     window.paint95Host = {
//       submit(blob /* image/png */, extra?: { animation?: Blob /* .p95 */ }): Promise<void>, // uploads and navigates away on success; rejects with an Error on failure
//       ready?(): void,                            // called once the app has loaded
//       draftSaved?(info: { at: number }): void,   // the device copy was saved (else postMessage {type: "2draw:draft-saved", at})
//     }
//   submit's extra also carries uploaded(): Promise<void>, which the host may call (and await, briefly) once the server
//   has accepted the upload and before it navigates away: it deletes the device copy.
//   Without a host (standalone, or cross-origin parent), Submit downloads the PNG instead.
//   The app exposes window.paint95History = { canUndo(), canRedo(), onChange(cb) => unsubscribe } on its own window.
//   &anim=<url of a previous .p95> continues that recording (see docs/2draw-animation-format.md).
//   &draft=<key> keeps a copy of the drawing in progress on this device under that key and restores it on the next
//   load (paint95-draft.js).
//   In replay mode (index.html?replay=1, used by player.js) none of this runs.

import { change_url_param, deselect, set_magnification, show_error_message } from "./functions.js";
import { $G, E, make_canvas } from "./helpers.js";
import { showMessageBox } from "./msgbox.js";
import { fetch_cors, is_reference_url, load_image_cors } from "./paint95-fetch.js";
import { Autosaver, expire_drafts, load_draft, request_persistent_storage, set_draft_aside } from "./paint95-draft.js";
import { decode_p95, decode_png } from "./paint95-format.js";
import { restore_history } from "./paint95-restore.js";
import { Recorder } from "./paint95-record.js";

// Stand-in for the removed sessions.js (called when opening a file)
window.new_local_session = () => { };

if (!window.P95.replaying) {
	init_editor();
}

function init_editor() {

	const required_width = window.paint95_required_width;
	const required_height = window.paint95_required_height;

	/**
	 * @returns {{ submit: (blob: Blob) => Promise<void>, ready?: () => void } | null}
	 */
	function get_host() {
		try {
			if (window.parent && window.parent !== window) {
				const host = window.parent.paint95Host;
				if (host && typeof host.submit === "function") {
					return host;
				}
			}
		} catch (_error) {
			// cross-origin parent: treat as no host
		}
		return null;
	}

	/** @type {Recorder | null} */
	let recorder = null;
	/** @type {Autosaver | null} */
	let autosaver = null;
	const draft_key = window.paint95_no_draft ? null : window.paint95_draft_key;

	/** Tells the 2draw page the drawing is saved on this device (for its "Saved on this device" line) */
	function announce_saved(at) {
		try {
			const host = window.parent && window.parent !== window ? window.parent.paint95Host : null;
			if (host && typeof host.draftSaved === "function") {
				host.draftSaved({ at });
			} else if (window.parent && window.parent !== window) {
				window.parent.postMessage({ type: "2draw:draft-saved", at }, location.origin);
			}
		} catch (_error) { /* cross-origin or no parent */ }
	}

	// #region History API (for the parent page, e.g. the iOS app's squeeze palette dimming undo/redo)

	/** @type {Set<() => void>} */
	const history_listeners = new Set();
	/**
	 * window.paint95History = {
	 *   canUndo(): boolean,                 // there's a step to undo
	 *   canRedo(): boolean,                 // there's a step to redo
	 *   onChange(cb: () => void): () => void, // cb after each history change (new step, undo, redo, load); returns an unsubscribe function
	 * }
	 */
	Object.defineProperty(window, "paint95History", {
		value: Object.freeze({
			canUndo: () => undos.length > 0,
			canRedo: () => redos.length > 0,
			/** @param {() => void} cb */
			onChange(cb) {
				history_listeners.add(cb);
				return () => { history_listeners.delete(cb); };
			},
		}),
	});
	$G.on("history-update", () => {
		for (const cb of [...history_listeners]) {
			try {
				cb();
			} catch (error) {
				console.error("paint95History listener failed", error);
			}
		}
	});

	// #endregion

	// #region Submit button (right end of the menu bar)

	const $submit_button = $(E("button"))
		.addClass("paint95-submit-button")
		.attr({ type: "button", title: "Submit to 2draw (Ctrl+Enter)" })
		.text("Submit")
		.on("click", () => { submit(); });

	const $menus = $(window.menu_bar.element);
	$menus.append($submit_button);

	let submitting = false;
	/** @param {boolean} busy */
	function set_busy(busy) {
		submitting = busy;
		$submit_button.prop("disabled", busy).text(busy ? "Submitting…" : "Submit");
	}

	// #endregion

	/**
	 * Renders the picture at exactly the required size.
	 * If the canvas size has drifted (rotate, stretch, etc.), asks first, then crops/pads onto white, anchored top-left.
	 * @returns {Promise<HTMLCanvasElement | null>} null if canceled
	 */
	async function get_canvas_for_submit() {
		if (main_canvas.width === required_width && main_canvas.height === required_height) {
			return main_canvas;
		}
		const result = await showMessageBox({
			message: `The picture is ${main_canvas.width}×${main_canvas.height} but this drawing must be ${required_width}×${required_height}.\n\nSubmit it cropped/padded to ${required_width}×${required_height}?`,
			iconID: "warning",
			buttons: [
				{ label: "Submit", value: "submit", default: true },
				{ label: "Cancel", value: "cancel" },
			],
		});
		if (result !== "submit") {
			return null;
		}
		const canvas = make_canvas(required_width, required_height);
		canvas.ctx.fillStyle = "#ffffff";
		canvas.ctx.fillRect(0, 0, required_width, required_height);
		canvas.ctx.drawImage(main_canvas, 0, 0);
		return canvas;
	}

	/**
	 * @param {HTMLCanvasElement} canvas
	 * @returns {Promise<Blob>}
	 */
	function canvas_to_png_blob(canvas) {
		return new Promise((resolve, reject) => {
			canvas.toBlob((blob) => {
				if (blob) {
					resolve(blob);
				} else {
					reject(new Error("Failed to export the picture as PNG."));
				}
			}, "image/png");
		});
	}

	async function submit() {
		if (submitting) {
			return;
		}
		set_busy(true);
		try {
			// Meld any floating selection or text box into the picture.
			deselect();

			const canvas = await get_canvas_for_submit();
			if (!canvas) {
				set_busy(false);
				return;
			}
			const blob = await canvas_to_png_blob(canvas);

			const host = get_host();
			if (!host) {
				// Standalone: just download it.
				saveAs(blob, "2draw-paint95.png");
				set_busy(false);
				return;
			}
			// The recording of the drawing; never let it break submitting.
			let animation = null;
			try {
				animation = recorder?.finalize() ?? null;
			} catch (error) {
				console.error("Failed to finalize the animation", error);
			}
			// The host calls uploaded() once the server has the drawing, before it leaves the page: then the device
			// copy goes.
			const delete_device_copy = () => (autosaver ? autosaver.delete().catch((error) => { console.warn("Couldn't delete the device copy", error); }) : Promise.resolve());
			await host.submit(blob, animation ? { animation, uploaded: delete_device_copy } : { uploaded: delete_device_copy });
			delete_device_copy();
			// The host navigates away on success. Leave the button disabled so it can't be submitted twice,
			// but recover eventually in case the page stays put.
			saved = true;
			$submit_button.text("Submitted");
			setTimeout(() => { set_busy(false); }, 15000);
		} catch (error) {
			set_busy(false);
			showMessageBox({
				message: `The picture could not be submitted.\n\n${(error && error.message) || error}`,
				iconID: "error",
			});
		}
	}
	window.paint95_submit = submit;

	// Ctrl+Enter / Cmd+Enter: submit
	addEventListener("keydown", (event) => {
		if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === "Enter") {
			event.preventDefault();
			event.stopImmediatePropagation();
			submit();
		}
	}, { capture: true });

	// In an iframe, the canvas's pointerdown handling prevents the default action, which also keeps
	// focus from moving into the frame, so keyboard shortcuts (Ctrl+Z, Ctrl+Enter...) wouldn't work.
	addEventListener("pointerdown", () => {
		if (!document.hasFocus()) {
			window.focus();
		}
	}, { capture: true });

	// #region Initial picture

	async function load_initial_image(url) {
		let source;
		try {
			source = await load_image_cors(url);
		} catch (error) {
			show_error_message("The starting picture could not be loaded. You can still draw on a blank canvas.", error);
			return false;
		}
		main_ctx.fillStyle = "#ffffff";
		main_ctx.fillRect(0, 0, main_canvas.width, main_canvas.height);
		main_ctx.drawImage(source, 0, 0);
		// Make the loaded picture the starting point of the history (can't be undone away).
		current_history_node.image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
		undos.length = 0;
		redos.length = 0;
		saved = true;
		$G.triggerHandler("history-update");
		window.$status_text?.default?.();
		return true;
	}

	/**
	 * @param {string} url
	 * @returns {Promise<import("./paint95-format.js").P95File | null>}
	 */
	async function load_previous_animation(url) {
		try {
			const response = await fetch_cors(url);
			// (a file from a newer engine is still resumed: only a missing or undecodable file starts over from the picture)
			return decode_p95(await response.arrayBuffer());
		} catch (error) {
			console.warn("Couldn't load the previous animation; starting a new one.", error);
			return null;
		}
	}

	// #endregion

	// #region Touch devices: show the Quick Undo button by default
	try {
		if (matchMedia("(pointer: coarse)").matches && !/easy-undo/i.test(location.hash)) {
			change_url_param("easy-undo", true, { replace_history_state: true });
		}
	} catch (_error) { /* ignore */ }
	// #endregion

	// Stand-in for the removed sessions.js (called when opening a file)
	window.new_local_session = () => { };

	// Small screens: if the picture doesn't fit, zoom out so the whole picture is visible (like View > Zoom > Zoom To Window).
	function zoom_out_to_fit() {
		const rect = window.$canvas_area[0].getBoundingClientRect();
		const margin = 12;
		const mag = Math.floor(100 * Math.min(
			(rect.width - margin) / main_canvas.width,
			(rect.height - margin) / main_canvas.height,
		)) / 100;
		if (mag < 1 && mag > 0) {
			set_magnification(Math.max(0.1, mag));
		}
	}

	/**
	 * The copy of this drawing saved on this device, if any (expiring old copies first).
	 * @returns {Promise<Awaited<ReturnType<typeof load_draft>>>}
	 */
	async function find_device_copy() {
		try {
			const expired = await expire_drafts();
			if (expired) {
				console.log(`[autosave] deleted ${expired} device ${expired === 1 ? "copy" : "copies"} older than 30 days`);
			}
		} catch (error) {
			console.warn("[autosave] couldn't expire old device copies", error);
		}
		let draft = null;
		try {
			draft = await load_draft(draft_key);
		} catch (error) {
			console.error("[autosave] the device copy can't be read; setting it aside", error);
			await set_draft_aside(draft_key).catch(() => { });
			return null;
		}
		if (!draft) {
			return null;
		}
		const saved_size = draft.meta.required || {};
		if (saved_size.width !== required_width || saved_size.height !== required_height) {
			// Clearly not the same drawing setup: ask.
			const answer = await showMessageBox({
				message: `A copy of this drawing saved on this device is ${saved_size.width}×${saved_size.height}, but this drawing is now ${required_width}×${required_height}.\n\nRestore the saved copy anyway? It is cropped or padded to ${required_width}×${required_height} when you submit.`,
				iconID: "warning",
				buttons: [
					{ label: "Restore", value: "restore", default: true },
					{ label: "Start over", value: "start-over" },
				],
			});
			if (answer !== "restore") {
				// kept aside (still expires after 30 days), not deleted
				await set_draft_aside(draft_key).catch(() => { });
				return null;
			}
		}
		return draft;
	}

	(async () => {
		zoom_out_to_fit();
		const draft = draft_key ? await find_device_copy() : null;
		const previous_promise = !draft && window.paint95_anim_url ? load_previous_animation(window.paint95_anim_url) : Promise.resolve(null);
		let loaded = false;
		if (window.paint95_load_url && !draft) {
			loaded = await load_initial_image(window.paint95_load_url);
		}
		let previous = loaded ? await previous_promise : null;
		let history_keep = null;
		let snapped = false;
		let restored_meta = null;
		if (draft) {
			// The copy saved on this device beats a blank start and the previous version: replay it, so its undo history
			// is back, and keep recording from there.
			try {
				const result = await restore_history(draft.file, {
					width: required_width,
					height: required_height,
					expected_hash: draft.meta.hash,
					fallback_picture: draft.snapshot ? () => decode_png(draft.snapshot) : null,
					title: "Restoring your drawing",
					message: "Restoring your drawing from this device…",
				});
				previous = draft.file;
				history_keep = result.keep;
				snapped = result.snapped;
				restored_meta = draft.meta;
				saved = false;
				set_magnification(1);
				zoom_out_to_fit();
				announce_saved(draft.meta.saved);
			} catch (error) {
				console.error("[autosave] couldn't restore the device copy", error);
				const params = new URLSearchParams(location.search);
				const aside = await set_draft_aside(draft_key).then(() => true, () => false);
				if (!aside) {
					// leave it alone entirely on this load
					params.set("p95nodraft", "1");
				}
				location.replace(`${location.pathname}?${params}${location.hash}`);
				return;
			}
		} else if (previous && !window.paint95_no_history) {
			// Revising: resume from the previous recording (replayed in the editor, so its undo history is back).
			const expected_image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
			try {
				const result = await restore_history(previous, { width: required_width, height: required_height, expected_image_data });
				history_keep = result.keep;
				snapped = result.snapped;
				set_magnification(1);
				zoom_out_to_fit();
			} catch (error) {
				// The recording couldn't be replayed at all (unreadable): start over from the picture.
				console.error("Couldn't restore the undo history", error);
				const params = new URLSearchParams(location.search);
				params.set("p95nohistory", "1");
				location.replace(`${location.pathname}?${params}${location.hash}`);
				return;
			}
		}
		try {
			recorder = new Recorder({ previous });
			// An immutable versioned 2draw picture (…/data/13/132726/132726-v1.png) is stored by reference.
			const reference_url = loaded && is_reference_url(window.paint95_load_url) ? window.paint95_load_url : null;
			recorder.begin({ start: previous ? "continue" : loaded ? "image" : "blank", history_keep, url: reference_url, snapped });
		} catch (error) {
			console.error("Failed to start recording", error);
			recorder = null;
		}
		if (recorder && draft_key) {
			try {
				let first = true;
				autosaver = new Autosaver({
					key: draft_key,
					recorder,
					required: { width: required_width, height: required_height },
					restored_meta,
					onsaved: ({ at }) => {
						announce_saved(at);
						if (first) {
							first = false;
							request_persistent_storage();
						}
					},
				});
				window.paint95_autosaver = autosaver;
			} catch (error) {
				console.error("[autosave] couldn't start", error);
			}
		}
		try {
			get_host()?.ready?.();
		} catch (error) {
			console.error("paint95Host.ready() failed", error);
		}
	})();
}
