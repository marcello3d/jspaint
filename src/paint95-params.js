// @ts-check
// JSPaint.exe: read the embed parameters before the app initializes.
// index.html?w=<width>&h=<height>[&load=<url-encoded image URL>][&anim=<url-encoded .p95 URL>][&draft=<2draw draft key>]
// (or ?replay=1 for player.js)
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
	// the 2draw draft key: keep a copy of the drawing on this device under it (paint95-draft.js)
	const draft = params.get("draft");
	window.paint95_draft_key = draft && /^[0-9a-z_-]{4,64}$/.test(draft) ? draft : null;
	// set when the device copy couldn't be restored or set aside: don't read or write it on this page load
	window.paint95_no_draft = params.has("p95nodraft");
	window.paint95_lock_size = true;
})();
