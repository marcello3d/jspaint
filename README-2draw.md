# JSPaint.exe

This branch (`2draw`) is a fork of [JS Paint](https://github.com/1j01/jspaint) by Isaiah Odhner (MIT, see `LICENSE.txt`),
trimmed down to run as a drawing applet on [2draw.net](https://2draw.net/).

## Build

```sh
npm run build:2draw
```

This writes `dist-2draw/` with only the files the app needs (no npm install required), plus `dist-2draw/VERSION`
with the source commit. All URLs are relative, so it can be served from any path, e.g. `/applet/paint95/`.

## Embedding

```html
<iframe src="/applet/paint95/index.html?w=500&h=400&load=<url-encoded PNG/JPG URL>"></iframe>
```

- `w`, `h`: canvas size (defaults to 400×300). The canvas starts blank white at exactly this size,
  and the size is locked (no Image > Attributes, no resize handles, no crop, pastes never enlarge it).
- `load` (optional): starting picture, fetched with CORS and drawn at the top-left. On failure, an error is shown
  and the canvas stays blank.

The same-origin parent page may define:

```js
window.paint95Host = {
	// Called by "Submit to 2draw" with a PNG of exactly w×h.
	// Resolve after uploading (and navigate away); reject with an Error to show it to the user.
	submit(blob) { /* ... */ },
	// Optional: called once the app has loaded.
	ready() { /* ... */ },
};
```

Without a host (standalone), Submit downloads the PNG.

"Submit to 2draw" is at the top of the File menu (Ctrl+Enter), and as a button at the right end of the menu bar.
If the picture's size has changed (e.g. Flip/Rotate or Stretch/Skew), Submit asks, then crops/pads it onto white at w×h.

## What's different from JS Paint

- Removed: autosave/sessions/multi-user, Open, Save As, Load From URL, Print, Set As Wallpaper, Upload to Imgur,
  Manage Storage, project news and update checks, CORS proxy fallbacks, themes, languages (English only),
  speech recognition, head tracker / dwell clicker, Help Topics, Konami code easter egg, external links.
- File > Download PNG saves a copy; File > New clears to a blank w×h canvas.
- No network requests besides the app's own files and the `load` image.
- Touch screens show the Quick Undo button and zoom out so the whole picture fits.
- The 2draw-specific code is in `src/paint95-params.js`, `src/paint95-2draw.js`, `styles/paint95-2draw.css`,
  and `scripts/build-2draw.mjs`; other changes are marked with `2draw:` comments.
