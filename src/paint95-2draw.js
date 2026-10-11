// @ts-check
/* global current_history_node:writable, main_canvas, main_ctx, saved:writable, undos, redos */
// 2draw Paint 95: integration with the 2draw.net draw page.
//
// Embed contract:
//   <iframe src="/applet/paint95/index.html?w=<width>&h=<height>[&load=<url-encoded PNG/JPG URL>]">
//   The (same-origin) parent window may expose:
//     window.paint95Host = {
//       submit(blob /* image/png */): Promise<void>, // uploads and navigates away on success; rejects with an Error on failure
//       ready?(): void,                            // called once the app has loaded
//     }
//   Without a host (standalone, or cross-origin parent), Submit downloads the PNG instead.

import { change_url_param, deselect, load_image_from_uri, set_magnification, show_error_message } from "./functions.js";
import { $G, E, make_canvas } from "./helpers.js";
import { showMessageBox } from "./msgbox.js";

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
		await host.submit(blob);
		// The host navigates away on success. Leave the button disabled so it can't be submitted twice,
		// but recover eventually in case the page stays put.
		saved = true;
		$submit_button.text("Submitted");
		setTimeout(() => { set_busy(false); }, 15000);
	} catch (error) {
		set_busy(false);
		showMessageBox({
			title: "Submit to 2draw",
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
	let info;
	try {
		info = await load_image_from_uri(url);
	} catch (error) {
		show_error_message("The starting picture could not be loaded. You can still draw on a blank canvas.", error);
		return;
	}
	const source = info.image || make_canvas(info.image_data);
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

(async () => {
	zoom_out_to_fit();
	if (window.paint95_load_url) {
		await load_initial_image(window.paint95_load_url);
	}
	try {
		get_host()?.ready?.();
	} catch (error) {
		console.error("paint95Host.ready() failed", error);
	}
})();
