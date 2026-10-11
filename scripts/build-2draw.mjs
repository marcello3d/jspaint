#!/usr/bin/env node
// Builds dist-2draw/: only the files the trimmed 2draw Paint 95 app needs,
// to be vendored by 2draw.net and served from /applet/paint95/.
//
// Usage: npm run build:2draw
//
// It starts from index.html and follows <script src>, <link href>, ES module imports,
// CSS url()/@import, and literal "images/...", "lib/..." etc. paths in the shipped JS,
// plus a few directories whose files are picked at runtime (cursors, transform icons, history icons).

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out_dir = path.join(root, "dist-2draw");

/** App-root-relative paths (forward slashes) */
const files = new Set();
const queue = [];

// Referenced by code paths or styles that the 2draw build never uses.
const exclude = [
	/^lib\/pdf\.js\//, // PDF import (pdf.js isn't loaded)
	/^images\/mspaint-win98-reference/, // dev-only reference screenshots (#compare-reference)
	/^images\/help-viewer-toolbar-icons/, // Help Topics viewer (removed)
	/^images\/tracky-mouse/, // head tracker (removed)
];

function add(rel) {
	rel = path.posix.normalize(rel.replace(/\\/g, "/")).replace(/^\.\//, "");
	if (rel.startsWith("../") || files.has(rel) || exclude.some((re) => re.test(rel))) return;
	const abs = path.join(root, rel);
	if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
	files.add(rel);
	queue.push(rel);
}

function add_glob(dir, pattern) {
	for (const name of fs.readdirSync(path.join(root, dir))) {
		if (pattern.test(name)) add(`${dir}/${name}`);
	}
}

const is_external = (ref) => /^(?:[a-z]+:|\/\/|#|data:)/i.test(ref);
const strip_query = (ref) => ref.replace(/[?#].*$/, "");

// Literal paths the app resolves relative to index.html at runtime.
const app_path_re = /["'`(]((?:images|lib|styles|help|audio)\/[\w\-./]+\.(?:png|gif|svg|jpe?g|webp|cur|ico|wav|css|js))["'`)]/g;

function scan(rel) {
	const ext = path.extname(rel).toLowerCase();
	if (![".html", ".css", ".js"].includes(ext)) return;
	const text = fs.readFileSync(path.join(root, rel), "utf8");
	const dir = path.posix.dirname(rel);

	if (ext === ".html") {
		// Skip HTML comments so commented-out <script>/<link> tags aren't shipped.
		const html = text.replace(/<!--[\s\S]*?-->/g, "");
		for (const [, ref] of html.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
			if (!is_external(ref)) add(path.posix.join(dir, strip_query(ref)));
		}
		for (const [, ref] of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
			if (!is_external(ref)) add(path.posix.join(dir, strip_query(ref)));
		}
	}
	if (ext === ".css") {
		const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
		for (const [, ref] of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
			if (!is_external(ref)) add(path.posix.join(dir, strip_query(ref)));
		}
		for (const [, ref] of css.matchAll(/@import\s+["']([^"']+)["']/g)) {
			if (!is_external(ref)) add(path.posix.join(dir, strip_query(ref)));
		}
	}
	if (ext === ".js") {
		// Static ES module imports (relative to the module)
		for (const [, ref] of text.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)) {
			if (ref.startsWith(".")) add(path.posix.join(dir, ref));
		}
		// Literal app-relative paths in non-comment lines (relative to index.html)
		const code = text.split("\n").filter((line) => !/^\s*(?:\/\/|\*)/.test(line)).join("\n");
		for (const [, ref] of code.matchAll(app_path_re)) {
			add(ref);
		}
	}
}

add("index.html");
add("LICENSE.txt");
add("favicon.ico");
// Picked at runtime by name:
add("styles/themes/classic.css"); // theme.js: `styles/themes/${theme}`
add("lib/gif.js/gif.worker.js"); // Extras > Render History As GIF
add("audio/chord.wav"); // message box sound
add_glob("images/cursors", /\.png$/); // make_css_cursor(): `images/cursors/${name}.png`
add_glob("images/transforms", /\.png$/); // Flip/Rotate & Stretch/Skew dialogs
add_glob("images", /^(error|warning|info|question|nuke)-(16x16|32x32)-\w+\.(png|svg)$/); // msgbox.js: `images/${iconID}-32x32-8bpp.png`
add_glob("help", /^p_\w+\.(png|gif)$/); // tool & history icons: `help/${file_name}`
add("images/icons/128x128.png"); // About box

while (queue.length) {
	scan(queue.shift());
}

// Write output
fs.rmSync(out_dir, { recursive: true, force: true });
let total_bytes = 0;
const sha = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
const dirty = execSync("git status --porcelain", { cwd: root }).toString().trim() !== "";
const version = `${sha}${dirty ? "-dirty" : ""}`;
for (const rel of [...files].sort()) {
	const src = path.join(root, rel);
	const dest = path.join(out_dir, rel);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	if (rel === "index.html") {
		const html = fs.readFileSync(src, "utf8")
			.replace('<span id="paint95-version">dev</span>', `<span id="paint95-version">${version}</span>`);
		fs.writeFileSync(dest, html);
	} else {
		fs.copyFileSync(src, dest);
	}
	total_bytes += fs.statSync(dest).size;
}
fs.writeFileSync(path.join(out_dir, "VERSION"), `${sha}\n`);
total_bytes += fs.statSync(path.join(out_dir, "VERSION")).size;

console.log(`dist-2draw: ${files.size + 1} files, ${(total_bytes / 1024).toFixed(0)} KiB, version ${version}`);
