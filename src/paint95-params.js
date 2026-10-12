// @ts-check
// JSPaint.exe: read the embed parameters before the app initializes.
// index.html?w=<width>&h=<height>[&load=<url-encoded image URL>][&anim=<url-encoded .p95 URL>]  (or ?replay=1 for player.js)
(() => {
	const params = new URLSearchParams(location.search);
	const parse_size = (/** @type {string | null} */ value, /** @type {number} */ fallback) => {
		const n = Math.round(Number(value));
		return Number.isFinite(n) && n >= 1 && n <= 4096 ? n : fallback;
	};
	window.paint95_required_width = parse_size(params.get("w"), 400);
	window.paint95_required_height = parse_size(params.get("h"), 300);
	window.paint95_load_url = params.get("load") || null;
	window.paint95_anim_url = params.get("anim") || null;
	// set when restoring the undo history from the previous animation failed (paint95-restore.js)
	window.paint95_no_history = params.has("p95nohistory");
	window.paint95_lock_size = true;
})();
