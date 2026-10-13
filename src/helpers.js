// @ts-check

/* global AccessKeys, main_canvas */
/* eslint-disable @stylistic/space-unary-ops */

const TAU =
	//                //////|//////                //
	//            /////     |     /////            //
	//         ///         tau         ///         //
	//       ///     ...--> | <--...     ///       //  //
	//     ///     -'   one | turn  '-     ///     //  //
	//    //     .'         |         '.     //    //  //
	//   //     /           |           \     //   //  //
	//  //     |            | <-..       |     //  //  //
	//  //    |          .->|     \       |    //  //  //
	//  //    |         /   |      |      |    //  //  //
	- - - - - - - - Math.PI + Math.PI - - - - - 0;
//	//  //    |         \   |      |      |    //  //
//	//  //    |          '->|     /       |    //  //
//	//  //     |            | <-''       |     //  //
//	//   //     \           |           /     //   //
//	//    //     '.         |         .'     //    //
//	//     ///     -.       |       .-     ///     //
//	//       ///     '''----|----'''     ///       //
//	//         ///          |          ///         //
//	//           //////     |     /////            //
//	//                //////|//////          C/r;  //  /////////////

const is_pride_month = new Date().getMonth() === 5; // June (0-based, 0 is January)

const query_params = new URLSearchParams(window.location.search);
export const is_discord_embed = query_params.get("frame_id") != null;

const $G = $(window);

/**
 * Wrapper for AccessKeys.toHTML that ensures whitespace isn't collapsed in cases like "Fox &Trot" or "Fo&x Trot" where the access key abuts a space.
 *
 * (Actually a simple `<span>` may be enough (since it's an inline element?), but `white-space: pre` is more explicit.)
 *
 * @param {string} label  text with an access key denoted by an ampersand (can escape with double ampersand)
 * @returns {string}  HTML for label with access key underlined
 */
function render_access_key(label) {
	return `<span style="white-space: pre">${AccessKeys.toHTML(label)}</span>`;
}

/**
 * @param {string} name  filename without extension
 * @param {[number, number]} coords  hotspot coordinates
 * @param {string} fallback  fallback cursor value
 * @returns {string}  CSS `cursor` value
 */
function make_css_cursor(name, coords, fallback) {
	return `url(images/cursors/${name}.png) ${coords.join(" ")}, ${fallback}`;
}

/**
 * @type {typeof document.createElement}
 */
const E = function E(t) {
	return document.createElement(t);
};

/**
 * @template {any[]} A
 * @param {(...args: A)=> void} func  function to debounce
 * @param {number} wait_ms  minimum milliseconds between invocations
 * @param {boolean=} immediate  trigger the function on the leading edge, instead of the trailing.
 * @returns {((...args: A)=> void) & {cancel: ()=> void}}  a function, that, as long as it continues to be invoked, will not be triggered.
 *   The function will be called after it stops being called for `wait_ms` milliseconds.
 *
 * @example
 * window.addEventListener("resize", debounce(() => {
 *  console.log(window.innerWidth);
 * }, 250));
 */
function debounce(func, wait_ms, immediate) {
	let timeout;
	const debounced_func = function () {
		// eslint-disable-next-line no-invalid-this
		const context = this;
		const args = arguments;

		const later = () => {
			timeout = null;
			if (!immediate) {
				func.apply(context, args);
			}
		};

		const callNow = immediate && !timeout;

		clearTimeout(timeout);

		timeout = setTimeout(later, wait_ms);

		if (callNow) {
			func.apply(context, args);
		}
	};
	debounced_func.cancel = () => {
		clearTimeout(timeout);
	};
	return debounced_func;
}

/**
 * @template {any[]} A - The type of the arguments to the function
 * @template {any} R - The return type of the function
 * @param {(...args: A) => R} func - The function to memoize.
 * @param {number} [max_entries=50000] - The maximum number of entries to store in the cache.
 * @returns {((...args: A) => R) & { clear_memo_cache: () => void }} - The memoized function, with an extra `clear_memo_cache` method.
 */
function memoize_synchronous_function(func, max_entries = 50000) {
	const cache = {};
	const keys = [];
	const memoized_func = (...args) => {
		if (args.some((arg) => arg instanceof CanvasPattern)) {
			return func.apply(null, args);
		}
		const key = JSON.stringify(args);
		if (cache[key]) {
			return cache[key];
		} else {
			const val = func.apply(null, args);
			cache[key] = val;
			keys.push(key);
			if (keys.length > max_entries) {
				const oldest_key = keys.shift();
				delete cache[oldest_key];
			}
			return val;
		}
	};
	memoized_func.clear_memo_cache = () => {
		for (const key of keys) {
			delete cache[key];
		}
		keys.length = 0;
	};
	return memoized_func;
}

/**
 * @param {string | CanvasPattern | CanvasGradient} color  CSS color value (or pattern/gradient, which will be sampled from a 1x1 canvas)
 * @returns {[number, number, number, number]}  [r, g, b, a] values ranging from 0 to 255
 * @example
 * const [r, g, b, a] = get_rgba_from_color("rgba(255, 0, 0, 0.5)");
 * console.log(r, g, b, a); // 255, 0, 0, 128
 */
const get_rgba_from_color_implementation = (color) => {
	const single_pixel_canvas = make_canvas(1, 1);

	single_pixel_canvas.ctx.fillStyle = color;
	single_pixel_canvas.ctx.fillRect(0, 0, 1, 1);

	const image_data = single_pixel_canvas.ctx.getImageData(0, 0, 1, 1);

	// We could just return image_data.data, but let's return an Array instead
	// I'm not totally sure image_data.data wouldn't keep the ImageData object around in memory
	return /** @type {[number, number, number, number]} */ (Array.from(image_data.data));
	// Equivalently:
	// return [image_data.data[0], image_data.data[1], image_data.data[2], image_data.data[3]];
};
const get_rgba_from_color = memoize_synchronous_function(get_rgba_from_color_implementation);

/**
 * Compare two ImageData.
 * Note: putImageData is lossy, due to premultiplied alpha.
 * @param {ImageData} a
 * @param {ImageData} b
 * @param {number} threshold  maximum difference in channel values
 * @returns {boolean} whether all pixels match within the specified threshold
*/
function image_data_match(a, b, threshold) {
	const a_data = a.data;
	const b_data = b.data;
	if (a_data.length !== b_data.length) {
		return false;
	}
	for (let len = a_data.length, i = 0; i < len; i++) {
		if (a_data[i] !== b_data[i]) {
			if (Math.abs(a_data[i] - b_data[i]) > threshold) {
				return false;
			}
		}
	}
	return true;
}

/**
 * @overload
 * @param {number} width
 * @param {number} height
 * @returns {PixelCanvas}  a new canvas element, augmented with `ctx` property, which is also augmented
 */
/**
 * @overload
 * @param {HTMLImageElement | HTMLCanvasElement | ImageData} source  image to copy
 * @returns {PixelCanvas}  a new canvas element, augmented with `ctx` property, which is also augmented
 */
/**
 * @overload
 * @returns {PixelCanvas}  a new canvas element, augmented with `ctx` property, which is also augmented
 */
// #region Canvas content bounds (2draw)
// Every canvas made by make_canvas keeps a conservative bounding box of where it may have non-transparent pixels
// (`canvas.content_bounds`, or null when empty), updated by its drawing calls. So when one canvas is drawn onto
// another (a tool's mask onto the picture), the destination knows which rectangle can have changed. The main canvas
// uses this to know the rectangle changed since the last history step (`canvas.on_draw`), so history steps read back
// only that rectangle instead of the whole canvas.

/** @typedef {{ x0: number, y0: number, x1: number, y1: number }} Bounds */

/** Composite operations that only affect pixels where the canvas already has content (so its bounds can't grow) */
const CONTAINED_COMPOSITE_OPERATIONS = new Set(["source-in", "destination-in", "source-atop"]);
/** Composite operations that only affect pixels inside what's drawn */
const LOCAL_COMPOSITE_OPERATIONS = new Set([
	"source-over", "source-atop", "destination-over", "destination-out", "lighter", "xor", "multiply", "screen", "overlay",
	"darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue",
	"saturation", "color", "luminosity",
]);

/**
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 */
function track_canvas_bounds(canvas, ctx) {
	/** @type {Bounds | null} */
	let bounds = null;
	Object.defineProperty(canvas, "content_bounds", { configurable: true, get: () => bounds });
	const all = () => ({ x0: 0, y0: 0, x1: canvas.width, y1: canvas.height });
	/**
	 * @param {Bounds | null} b - null: unknown, anywhere
	 * @param {boolean} [adds_content] - false for clearing (changes pixels, but adds no content)
	 */
	const touched = (b, adds_content = true) => {
		const rect = b ? {
			x0: Math.max(0, Math.floor(b.x0) - 1),
			y0: Math.max(0, Math.floor(b.y0) - 1),
			x1: Math.min(canvas.width, Math.ceil(b.x1) + 1),
			y1: Math.min(canvas.height, Math.ceil(b.y1) + 1),
		} : all();
		if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) {
			return;
		}
		if (!adds_content) {
			canvas.on_draw?.(b ? rect : null);
			return;
		}
		bounds = bounds ? {
			x0: Math.min(bounds.x0, rect.x0), y0: Math.min(bounds.y0, rect.y0),
			x1: Math.max(bounds.x1, rect.x1), y1: Math.max(bounds.y1, rect.y1),
		} : rect;
		canvas.on_draw?.(b ? rect : null);
	};
	for (const dim of ["width", "height"]) {
		const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dim);
		Object.defineProperty(canvas, dim, {
			configurable: true,
			enumerable: true,
			get() { return descriptor.get.call(this); },
			set(value) {
				descriptor.set.call(this, value);
				bounds = null; // cleared
				canvas.on_draw?.(null); // (everything changed)
			},
		});
	}
	/** For a drawing call: true if handled because it can only change pixels inside the existing content */
	const contained = () => {
		if (!CONTAINED_COMPOSITE_OPERATIONS.has(ctx.globalCompositeOperation)) return false;
		if (bounds) canvas.on_draw?.(bounds);
		return true;
	};
	/** the translation of the current transform, or null if it scales/rotates */
	const translation = () => {
		const m = ctx.getTransform();
		return (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1) ? m : null;
	};
	const rect_op = (name, { composite = true, pad = () => 0 } = {}) => {
		const original = ctx[name];
		ctx[name] = function (x, y, w, h) {
			if (composite && contained()) {
				return original.apply(this, arguments);
			}
			const t = translation();
			if (!t || (composite && !LOCAL_COMPOSITE_OPERATIONS.has(ctx.globalCompositeOperation))) {
				touched(null);
			} else {
				const p = pad();
				const x0 = Math.min(x, x + w) + t.e - p;
				const y0 = Math.min(y, y + h) + t.f - p;
				touched({ x0, y0, x1: x0 + Math.abs(w) + 2 * p, y1: y0 + Math.abs(h) + 2 * p });
			}
			return original.apply(this, arguments);
		};
	};
	rect_op("fillRect");
	rect_op("strokeRect", { pad: () => ctx.lineWidth / 2 + 1 });
	// clearing changes pixels but never adds content; clearing everything empties the canvas
	const original_clear_rect = ctx.clearRect;
	ctx.clearRect = function (x, y, w, h) {
		const t = translation();
		if (!t) {
			canvas.on_draw?.(null);
		} else {
			const x0 = Math.min(x, x + w) + t.e;
			const y0 = Math.min(y, y + h) + t.f;
			const x1 = x0 + Math.abs(w);
			const y1 = y0 + Math.abs(h);
			touched({ x0, y0, x1, y1 }, false);
			if (x0 <= 0 && y0 <= 0 && x1 >= canvas.width && y1 >= canvas.height) {
				bounds = null;
			}
		}
		return original_clear_rect.apply(this, arguments);
	};
	for (const name of ["fill", "stroke", "fillText", "strokeText"]) {
		const original = ctx[name];
		ctx[name] = function () {
			if (!contained()) {
				touched(null);
			}
			return original.apply(this, arguments);
		};
	}
	const original_draw_image = ctx.drawImage;
	ctx.drawImage = function (image, ...args) {
		if (contained()) {
			return original_draw_image.apply(this, arguments);
		}
		const t = translation();
		if (!t || !LOCAL_COMPOSITE_OPERATIONS.has(ctx.globalCompositeOperation)) {
			touched(null);
			return original_draw_image.apply(this, arguments);
		}
		const iw = image.naturalWidth || image.videoWidth || image.width;
		const ih = image.naturalHeight || image.videoHeight || image.height;
		let sx = 0, sy = 0, sw = iw, sh = ih, dx, dy, dw, dh;
		if (args.length === 2) {
			[dx, dy] = args;
			dw = iw;
			dh = ih;
		} else if (args.length === 4) {
			[dx, dy, dw, dh] = args;
		} else {
			[sx, sy, sw, sh, dx, dy, dw, dh] = args;
		}
		const source_bounds = image.content_bounds;
		if (image.content_bounds !== undefined && source_bounds === null) {
			// an empty canvas: nothing drawn (with a local composite operation)
			return original_draw_image.apply(this, arguments);
		}
		if (source_bounds && dw === sw && dh === sh) {
			// only where the source has content
			touched({
				x0: Math.max(source_bounds.x0, sx) - sx + dx + t.e,
				y0: Math.max(source_bounds.y0, sy) - sy + dy + t.f,
				x1: Math.min(source_bounds.x1, sx + sw) - sx + dx + t.e,
				y1: Math.min(source_bounds.y1, sy + sh) - sy + dy + t.f,
			});
		} else {
			touched({ x0: Math.min(dx, dx + dw) + t.e, y0: Math.min(dy, dy + dh) + t.f, x1: Math.max(dx, dx + dw) + t.e, y1: Math.max(dy, dy + dh) + t.f });
		}
		return original_draw_image.apply(this, arguments);
	};
	const original_put_image_data = ctx.putImageData;
	ctx.putImageData = function (image_data, dx, dy, dirty_x = 0, dirty_y = 0, dirty_w = image_data.width, dirty_h = image_data.height) {
		// (putImageData ignores the transform and the composite operation)
		touched({ x0: dx + dirty_x, y0: dy + dirty_y, x1: dx + dirty_x + dirty_w, y1: dy + dirty_y + dirty_h });
		return original_put_image_data.apply(this, arguments);
	};
}

// #endregion

function make_canvas(width, height) {
	const image = width;


	const new_canvas = /** @type {PixelCanvas} */ (E("canvas"));
	const new_ctx = /** @type {PixelContext} */ (new_canvas.getContext("2d"));

	new_canvas.ctx = new_ctx;

	new_ctx.disable_image_smoothing = () => {
		new_ctx.imageSmoothingEnabled = false;
		// condition is to avoid a deprecation warning in Firefox
		if (new_ctx.imageSmoothingEnabled !== false) {
			// @ts-ignore
			new_ctx.mozImageSmoothingEnabled = false;
			// @ts-ignore
			new_ctx.webkitImageSmoothingEnabled = false;
			// @ts-ignore
			new_ctx.msImageSmoothingEnabled = false;
		}
	};
	new_ctx.enable_image_smoothing = () => {
		new_ctx.imageSmoothingEnabled = true;
		if (new_ctx.imageSmoothingEnabled !== true) {
			// @ts-ignore
			new_ctx.mozImageSmoothingEnabled = true;
			// @ts-ignore
			new_ctx.webkitImageSmoothingEnabled = true;
			// @ts-ignore
			new_ctx.msImageSmoothingEnabled = true;
		}
	};

	// @TODO: simplify the abstraction by defining setters for width/height
	// that reset the image smoothing to disabled
	// and make image smoothing a parameter to make_canvas

	new_ctx.copy = (image) => {
		// @ts-ignore
		new_canvas.width = image.naturalWidth || image.width;
		// @ts-ignore
		new_canvas.height = image.naturalHeight || image.height;

		// setting width/height resets image smoothing (along with everything)
		new_ctx.disable_image_smoothing();

		if (image instanceof ImageData) {
			new_ctx.putImageData(image, 0, 0);
		} else {
			new_ctx.drawImage(image, 0, 0);
		}
	};

	track_canvas_bounds(new_canvas, new_ctx);

	if (width && height) {
		// make_canvas(width, height)
		new_canvas.width = width;
		new_canvas.height = height;
		// setting width/height resets image smoothing (along with everything)
		new_ctx.disable_image_smoothing();
	} else if (image) {
		// make_canvas(image)
		new_ctx.copy(image);
	}

	return new_canvas;
}

/**
 * @param {string} file_name  name of an image file in the help/ folder, including extension
 * @returns {HTMLImageElement}  an image element
 */
function get_help_folder_icon(file_name) {
	const icon_img = new Image();
	icon_img.src = `help/${file_name}`;
	return icon_img;
}

/**
 * @param {Tool} tool
 * @returns {HTMLImageElement}  an image element representing the tool
 */
function get_icon_for_tool(tool) {
	return get_help_folder_icon(tool.help_icon);
}

/**
 * not to be confused with load_image_from_uri
 * @param {string} src  URI of an image
 * @returns {Promise<HTMLImageElement>}  an image element
 */
function load_image_simple(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();

		img.onload = () => { resolve(img); };
		img.onerror = () => { reject(new Error(`failed to load image from ${src}`)); };

		img.src = src;
	});
}

/**
 * @param {Tool[]} tools  an array of selected tools
 * @returns {HTMLImageElement | HTMLCanvasElement}  an icon representing the tools
 */
function get_icon_for_tools(tools) {
	if (tools.length === 1) {
		return get_icon_for_tool(tools[0]);
	}
	const icon_canvas = make_canvas(16, 16);

	Promise.all(tools.map((tool) => load_image_simple(`help/${tool.help_icon}`)))
		.then((icons) => {
			icons.forEach((icon, i) => {
				const w = icon_canvas.width / icons.length;
				const x = i * w;
				const h = icon_canvas.height;
				const y = 0;
				icon_canvas.ctx.drawImage(icon, x, y, w, h, x, y, w, h);
			});
		});
	return icon_canvas;
}

/**
 * does NOT accept a file extension itself as input - if input does not have a dot, returns empty string
 * @param {string} file_path_or_name  path or name of a file
 * @returns {string}  file extension without the dot
 */
function get_file_extension(file_path_or_name) {
	return file_path_or_name.match(/\.([^./]+)$/)?.[1] || "";
}

/**
 * accepts a file extension as input, or a file name, or path
 * @template {FileFormat} T
 * @param {T[]} formats
 * @param {string} file_path_or_name_or_ext  file path, name, or extension
 * @returns {T}  format object
 */
function get_format_from_extension(formats, file_path_or_name_or_ext) {
	const ext_match = file_path_or_name_or_ext.match(/\.([^.]+)$/);
	const ext = ext_match ? ext_match[1].toLowerCase() : file_path_or_name_or_ext; // excluding dot
	for (const format of formats) {
		if (format.extensions.includes(ext)) {
			return format;
		}
	}
}

/**
 * Converts an RGB color value to HSL. Conversion formula
 * adapted from http://en.wikipedia.org/wiki/HSL_color_space.
 * Assumes r, g, and b are contained in the set [0, 255] and
 * returns h, s, and l in the set [0, 1].
 *
 * @param   {number}  r  The red color value
 * @param   {number}  g  The green color value
 * @param   {number}  b  The blue color value
 * @return  {[number, number, number]}  The HSL representation
 */
function rgb_to_hsl(r, g, b) {
	r /= 255; g /= 255; b /= 255;

	var max = Math.max(r, g, b), min = Math.min(r, g, b);
	var h, s, l = (max + min) / 2;

	if (max == min) {
		h = s = 0; // achromatic
	} else {
		var d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

		switch (max) {
			case r: h = (g - b) / d + (g < b ? 6 : 0); break;
			case g: h = (b - r) / d + 2; break;
			case b: h = (r - g) / d + 4; break;
		}

		h /= 6;
	}

	return [h, s, l];
}

// #region Coordinate Transformations
/**
 * @param {{ clientX: number, clientY: number }} client_point e.g. a MouseEvent
 * @returns {{ x: number, y: number }} canvas coordinates
 */
function to_canvas_coords({ clientX, clientY }) {
	if (clientX === undefined || clientY === undefined) {
		throw new TypeError("clientX and clientY must be defined (not {x, y} or x, y or [x, y])");
	}
	const rect = window.canvas_bounding_client_rect;
	return {
		x: ~~((clientX - rect.left) / rect.width * main_canvas.width),
		y: ~~((clientY - rect.top) / rect.height * main_canvas.height),
	};
}
/**
 * @param {{ x: number, y: number }} canvas_point
 * @returns {{ clientX: number, clientY: number }} client coordinates
 */
function from_canvas_coords({ x, y }) {
	const rect = window.canvas_bounding_client_rect;
	return {
		clientX: ~~(x / main_canvas.width * rect.width + rect.left),
		clientY: ~~(y / main_canvas.height * rect.height + rect.top),
	};
}
// #endregion


/**
 * Checks if the browser supports vertical writing mode for textareas.
 * @returns {boolean} True if vertical writing mode is supported, false otherwise.
 */
function supports_vertical_writing_mode() {
	const el = document.createElement("textarea");
	el.style.writingMode = "vertical-rl";
	// @ts-ignore
	el.style.webkitWritingMode = "vertical-rl";
	// @ts-ignore
	el.style.msWritingMode = "vertical-rl";
	// @ts-ignore
	el.style.mozWritingMode = "vertical-rl";
	// not sure if this "hiding" is needed given that it'll be removed immediately...
	el.style.position = "absolute";
	// el.style.opacity = "0";
	el.style.top = "-9999px";
	document.body.appendChild(el);

	const computed = getComputedStyle(el);
	// Need to check properties of `computed` BEFORE removing the element, in Firefox.
	// @ts-ignore
	const supported = computed.writingMode === "vertical-rl" || computed.webkitWritingMode === "vertical-rl" || computed.msWritingMode === "vertical-rl" || computed.mozWritingMode === "vertical-rl";
	document.body.removeChild(el);

	return supported;
}


export {
	$G,
	E,
	TAU,
	debounce,
	from_canvas_coords,
	get_file_extension,
	get_format_from_extension,
	get_help_folder_icon,
	get_icon_for_tool,
	get_icon_for_tools,
	get_rgba_from_color,
	image_data_match,
	is_pride_month,
	load_image_simple,
	make_canvas,
	make_css_cursor,
	memoize_synchronous_function,
	render_access_key,
	rgb_to_hsl,
	supports_vertical_writing_mode,
	to_canvas_coords
};
// Temporary globals until all dependent code is converted to ES Modules
window.$G = $G; // used by app-localization.js
window.make_canvas = make_canvas; // used by app-state.js, electron-injected.js
window.get_format_from_extension = get_format_from_extension; // used by electron-injected.js
