// @ts-check
// JSPaint.exe: loading the starting picture / previous animation from another origin (S3) with CORS.
//
// S3 only sends CORS headers (and `Vary: Origin`) when the request has an Origin header. So when the page that links
// to the editor has already shown the same image with a plain <img> (no Origin), browsers can cache that response
// (with no Vary) and reuse it for our CORS fetch, which then fails ("TypeError: Load failed" in Safari).
// So: ask for a URL the plain <img> never used (an extra query parameter), bypass the HTTP cache,
// and as a last resort try an <img crossOrigin="anonymous"> with a unique URL.

import { read_image_file } from "./functions.js";
import { make_canvas } from "./helpers.js";

/**
 * Adds a query parameter so the request doesn't match a cached non-CORS response.
 * (Not "cors": S3 treats ?cors as its bucket-CORS API.) Leaves signed URLs and non-http(s) URLs alone.
 * @param {string} url
 * @param {string} [value]
 */
export function cors_cache_bust(url, value = "1") {
	if (!/^https?:/i.test(url) || /[?&](X-Amz-Signature|Signature)=/i.test(url)) {
		return url;
	}
	return `${url}${url.includes("?") ? "&" : "?"}p95load=${encodeURIComponent(value)}`;
}

/**
 * @param {string} url
 * @returns {Promise<Response>}
 */
export async function fetch_cors(url) {
	const response = await fetch(cors_cache_bust(url), { mode: "cors", credentials: "omit", cache: "no-store" });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
	}
	return response;
}

/**
 * @param {Blob} blob
 * @returns {Promise<HTMLImageElement | HTMLCanvasElement>}
 */
function blob_to_image(blob) {
	return new Promise((resolve, reject) => {
		read_image_file(blob, (error, info) => {
			if (error) {
				reject(error);
			} else {
				resolve(info.image || make_canvas(info.image_data));
			}
		});
	});
}

/**
 * @param {string} url
 * @returns {Promise<HTMLImageElement>}
 */
function load_img_cors(url) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error(`<img crossorigin> failed to load ${url}`));
		img.src = url;
	});
}

/**
 * Loads an image from another origin, CORS-enabled (so it can be read back from the canvas).
 * @param {string} url
 * @returns {Promise<HTMLImageElement | HTMLCanvasElement>}
 */
export async function load_image_cors(url) {
	let fetch_error;
	try {
		return await blob_to_image(await (await fetch_cors(url)).blob());
	} catch (error) {
		fetch_error = error;
		console.warn("CORS fetch of the starting picture failed; trying <img crossorigin>", error);
	}
	try {
		return await load_img_cors(cors_cache_bust(url, String(Date.now())));
	} catch (img_error) {
		throw new Error(`${url}\n${fetch_error && fetch_error.message || fetch_error}\n${img_error.message}`);
	}
}

/**
 * Whether a starting picture can be stored by reference in a recording: an immutable, versioned 2draw picture URL
 * like https://s3.amazonaws.com/zoraw.2draw.net/data/13/132726/132726-v1.png
 * @param {string | null} url
 */
export function is_reference_url(url) {
	if (!url) return false;
	try {
		const parsed = new URL(url);
		return /^https?:$/.test(parsed.protocol) && !parsed.search && /\/data\/\d+\/\d+\/\d+-v\d+\.(png|jpe?g)$/i.test(parsed.pathname);
	} catch {
		return false;
	}
}

/**
 * Loads a picture for replay the way the editor loaded it (fetch + the engine's decoder), composited onto a white
 * canvas of the given size at the top left, as ImageData.
 * @param {string} url
 * @param {number} width
 * @param {number} height
 * @returns {Promise<ImageData>}
 */
export async function load_picture_image_data(url, width, height) {
	const image = await load_image_cors(url);
	const canvas = make_canvas(width, height);
	canvas.ctx.fillStyle = "#ffffff";
	canvas.ctx.fillRect(0, 0, width, height);
	canvas.ctx.drawImage(image, 0, 0);
	return canvas.ctx.getImageData(0, 0, width, height);
}
