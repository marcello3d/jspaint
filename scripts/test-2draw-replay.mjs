#!/usr/bin/env node
// Record -> replay round trip test for JSPaint.exe animations.
//
//   npm run test:2draw-replay            (tests the source tree)
//   npm run test:2draw-replay -- --dist  (tests dist-2draw/, run npm run build:2draw first)
//
// Drives the editor with real (Playwright) mouse/keyboard input through every tool, paste, undo/redo and the Image menu,
// takes the recording, replays it with player.js, and asserts the replayed canvas is pixel-identical.
// Uses playwright-core with the installed Google Chrome (PLAYWRIGHT_CHANNEL=chromium to use Playwright's own browser).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const use_dist = process.argv.includes("--dist");
const app_root = process.env.P95_APP_ROOT ? path.resolve(process.env.P95_APP_ROOT) : use_dist ? path.join(repo_root, "dist-2draw") : repo_root;
const verbose = process.argv.includes("--verbose");

async function load_playwright() {
	try {
		return await import("playwright-core");
	} catch {
		// `npx -p playwright-core@x node ...` puts the package's .bin on PATH; find the package next to it.
		for (const dir of (process.env.PATH || "").split(path.delimiter)) {
			const candidate = path.join(dir, "..", "playwright-core");
			if (fs.existsSync(path.join(candidate, "package.json"))) {
				return createRequire(path.join(candidate, "package.json"))("./index.js");
			}
		}
		throw new Error("playwright-core not found; run via `npm run test:2draw-replay`");
	}
}

const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".wav": "audio/wav", ".json": "application/json", ".cur": "image/x-icon" };
function serve(root) {
	const server = http.createServer((req, res) => {
		let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
		if (!p.startsWith("/app/")) {
			res.writeHead(404);
			res.end();
			return;
		}
		p = p.slice("/app".length);
		if (p.endsWith("/")) p += "index.html";
		const file = path.join(root, p);
		if (!file.startsWith(root)) {
			res.writeHead(403);
			res.end();
			return;
		}
		fs.readFile(file, (error, data) => {
			if (error) {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": types[path.extname(file).toLowerCase()] || "application/octet-stream" });
			res.end(data);
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** A small 24x16 RGBA PNG (with a transparent stripe) to paste */
function make_test_png() {
	const width = 24;
	const height = 16;
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0;
		for (let x = 0; x < width; x++) {
			const o = y * (width * 4 + 1) + 1 + x * 4;
			raw[o] = x * 10;
			raw[o + 1] = y * 15;
			raw[o + 2] = 200;
			raw[o + 3] = x > 16 ? 0 : 255;
		}
	}
	const crc_table = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc32 = (buffer) => {
		let c = 0xffffffff;
		for (const byte of buffer) c = crc_table[(c ^ byte) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const { chromium } = await load_playwright();
const server = await serve(app_root);
const base = `http://127.0.0.1:${server.address().port}/app`;
const browser = await chromium.launch({
	channel: process.env.PLAYWRIGHT_CHANNEL === "chromium" ? undefined : (process.env.PLAYWRIGHT_CHANNEL || "chrome"),
	headless: true,
});

let failures = 0;
const check = (condition, message) => {
	console.log(`${condition ? "PASS" : "FAIL"} ${message}`);
	if (!condition) failures++;
};

function watch(page, label) {
	page.on("pageerror", (error) => { console.log(`[${label}] PAGEERROR ${error.message}`); failures++; });
	page.on("console", (message) => {
		const text = message.text();
		if (message.type() === "error" || (verbose && message.type() === "warning")) {
			console.log(`[${label}] console.${message.type()}: ${text.slice(0, 400)}`);
		}
		if (/\[replay\] drift/.test(text)) {
			console.log(`[${label}] ${text.slice(0, 400)}`);
		}
	});
}

/**
 * @param {import("playwright-core").Page} page
 */
async function record_session(page, { width, height, script, debug = false }) {
	await page.goto(`${base}/index.html?w=${width}&h=${height}${process.argv.includes("--debug") || debug ? "&p95debug=1" : ""}`, { waitUntil: "networkidle" });
	await wait_until(page, () => !!(window.P95 && window.P95.recorder));
	const canvas_box = async () => (await page.$(".main-canvas")).boundingBox();
	const ctx = {
		page,
		async at(x, y) {
			const box = await canvas_box();
			const scale = box.width / (await page.evaluate(() => main_canvas.width));
			return [box.x + (x + 0.5) * scale, box.y + (y + 0.5) * scale];
		},
		async tool(name) {
			await page.click(`.tools-component .tool[title="${name}"]`);
		},
		async drag(points, { button = "left", steps = 3, hold = 0 } = {}) {
			const [x0, y0] = await ctx.at(...points[0]);
			await page.mouse.move(x0, y0);
			await page.mouse.down({ button });
			if (hold) await page.waitForTimeout(hold);
			for (const point of points.slice(1)) {
				const [x, y] = await ctx.at(...point);
				await page.mouse.move(x, y, { steps });
			}
			await page.mouse.up({ button });
		},
		async click(x, y, options = {}) {
			const [cx, cy] = await ctx.at(x, y);
			await page.mouse.click(cx, cy, options);
		},
		async color(index, button = "left") {
			const swatches = await page.$$(".colors-component .swatch:not(.current-colors *)");
			await swatches[index].click({ button });
		},
		async option(index) {
			// click the nth option in the tool options box (brush shapes, sizes, fill styles...)
			const box = await (await page.$(".tool-options")).boundingBox();
			const rows = 4;
			await page.mouse.click(box.x + box.width / 2, box.y + 4 + (box.height - 8) * (index + 0.5) / rows);
		},
		async menu(top, item) {
			await page.click(`.menus .menu-button:has-text("${top}")`);
			await page.click(`.menu-popup:visible .menu-item[aria-label="${item}"]`);
		},
	};
	await script(ctx);
	await page.waitForTimeout(100);
	if (process.env.P95_SAVE) {
		await page.screenshot({ path: path.join(process.env.P95_SAVE, `editor-${width}x${height}-${Date.now()}.png`) });
	}
	return page.evaluate(async () => {
		const blob = window.P95.recorder.finalize();
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let binary = "";
		for (let i = 0; i < bytes.length; i += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		}
		const image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
		const png_base64 = main_canvas.toDataURL("image/png").split(",")[1];
		const events = window.P95.recorder.segment.events;
		return {
			base64: btoa(binary),
			png_base64,
			size: bytes.length,
			events: events.length,
			truncated: !!window.P95.recorder.segment.truncated,
			width: image_data.width,
			height: image_data.height,
			pixels: Array.from(image_data.data),
			counts: events.reduce((counts, event) => { counts[event[0]] = (counts[event[0]] || 0) + 1; return counts; }, {}),
		};
	});
}

/**
 * Replays with player.js in a same-origin host page; returns the final pixels.
 */
async function replay_session(page, recording, { seek_back = false, final_image_url = null } = {}) {
	await page.route(`${base}/__test_host.html`, (route) => route.fulfill({
		contentType: "text/html",
		body: `<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root" style="width:400px;height:300px"></div><script src="player.js"></script>`,
	}));
	await page.goto(`${base}/__test_host.html`, { waitUntil: "load" });
	return page.evaluate(async ({ base64, seek_back, final_image_url }) => {
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		const url = URL.createObjectURL(new Blob([bytes]));
		const drifts = [];
		let ended = false;
		const player = new window.Paint95Player({
			domRoot: document.getElementById("root"),
			lsaUrl: url,
			finalImageUrl: final_image_url,
			controls: true,
			fit: "contain",
			onDrift: (drift) => drifts.push(drift),
			onEnd: () => { ended = true; },
		});
		window.__p95_test_player = player;
		await player.ready;
		const wait_caught_up = async () => {
			for (let i = 0; i < 2000; i++) {
				await new Promise((resolve) => requestAnimationFrame(resolve));
				if (player._caught_up && !player._restarting) return;
			}
			throw new Error("replay did not catch up");
		};
		if (seek_back) {
			player.seek(player.duration);
			await wait_caught_up();
			player.seek(player.duration / 2);
			await wait_caught_up();
		}
		// play at max speed to the end
		player.setSpeed(64);
		player.play();
		for (let i = 0; i < 20000 && !ended; i++) {
			await new Promise((resolve) => requestAnimationFrame(resolve));
		}
		const canvas = player._controller.get_document_canvas();
		const image_data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
		return {
			ended,
			duration: player.duration,
			drifts,
			width: image_data.width,
			height: image_data.height,
			pixels: Array.from(image_data.data),
		};
	}, { base64: recording.base64, seek_back, final_image_url });
}

function compare(label, recording, replay) {
	check(replay.ended, `${label}: playback reached the end`);
	check(replay.drifts.length === 0, `${label}: no drift (${JSON.stringify(replay.drifts).slice(0, 300)})`);
	const same_size = recording.width === replay.width && recording.height === replay.height;
	let diff = 0;
	if (same_size) {
		for (let i = 0; i < recording.pixels.length; i++) {
			if (recording.pixels[i] !== replay.pixels[i]) diff++;
		}
	}
	check(same_size && diff === 0, `${label}: replayed canvas is pixel-identical (${replay.width}x${replay.height} vs ${recording.width}x${recording.height}, ${diff} differing bytes)`);
}

const test_png = make_test_png();

const sessions = {
	async all_tools(t) {
		const { page } = t;
		// pencil + colors
		await t.tool("Pencil");
		await t.color(4);
		await t.drag([[10, 10], [60, 20], [40, 50]]);
		// brush with a different shape/size, right button (secondary color)
		await t.tool("Brush");
		await t.option(1);
		await t.color(16, "right");
		await t.drag([[20, 70], [90, 80], [120, 60]], { button: "right" });
		// a stroke that leaves the canvas (negative coordinates; the engine truncates toward zero)
		await t.drag([[30, 30], [10, 12], [-12, -8], [-20, 40], [5, 60]], { button: "right" });
		// airbrush, held still for a while (timer ticks)
		await t.tool("Airbrush");
		await t.color(20);
		await t.drag([[150, 30], [150, 30], [170, 40]], { hold: 250 });
		// line, thicker
		await t.tool("Line");
		await t.option(2);
		await t.drag([[10, 120], [110, 150]]);
		// curve: drag, then two bends
		await t.tool("Curve");
		await t.drag([[130, 120], [220, 120]]);
		await t.drag([[160, 100], [160, 90]]);
		await t.drag([[200, 150], [200, 160]]);
		// rectangle (filled with outline)
		await t.tool("Rectangle");
		await t.option(1);
		await t.drag([[230, 10], [290, 60]]);
		// ellipse (fill only)
		await t.tool("Ellipse");
		await t.option(2);
		await t.color(17);
		await t.drag([[230, 70], [300, 110]]);
		// rounded rectangle
		await t.tool("Rounded Rectangle");
		await t.option(0);
		await t.drag([[240, 120], [300, 170]]);
		// polygon: drag first edge, click points, double click to finish
		await t.tool("Polygon");
		await t.option(1);
		await t.drag([[20, 180], [70, 175]]);
		await t.click(80, 220);
		await t.click(40, 230);
		await t.click(15, 210, { clickCount: 2 });
		await page.waitForTimeout(50);
		// fill
		await t.tool("Fill With Color");
		await t.color(18);
		await t.click(270, 40);
		// pick color, then draw with it
		await t.tool("Pick Color");
		await t.click(270, 40);
		await t.tool("Pencil");
		await t.drag([[100, 190], [140, 200]]);
		// eraser
		await t.tool("Eraser/Color Eraser");
		await t.drag([[30, 15], [50, 25]]);
		// magnifier (zoom in), draw zoomed, zoom back out
		await t.tool("Magnifier");
		await t.click(60, 60);
		await t.tool("Pencil");
		await t.drag([[55, 55], [70, 60]]);
		await t.tool("Magnifier");
		await t.click(60, 60);
		// text
		await t.tool("Text");
		await t.drag([[150, 175], [260, 200]]);
		await page.keyboard.type("Hello 2draw");
		await t.tool("Pencil"); // commits the text
		// rectangular selection: select, move, resize via handle, nudge
		await t.tool("Select");
		await t.drag([[10, 60], [100, 110]]);
		await t.drag([[50, 85], [70, 95]]);
		const handle = await page.$(".on-canvas-object .handle:nth-of-type(8)");
		if (handle) {
			const b = await handle.boundingBox();
			await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
			await page.mouse.down();
			await page.mouse.move(b.x + 20, b.y + 10, { steps: 3 });
			await page.mouse.up();
		}
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("ArrowDown");
		await t.click(5, 235); // deselect
		// free-form select and drag it
		await t.tool("Free-Form Select");
		await t.drag([[200, 60], [240, 70], [230, 110], [195, 100], [200, 60]]);
		await t.drag([[215, 85], [180, 95]]);
		await page.keyboard.press("Delete"); // clear selection
		// paste an image (Edit > Paste From...)
		const [chooser] = await Promise.all([
			page.waitForEvent("filechooser"),
			t.menu("Edit", "Paste From..."),
		]);
		await chooser.setFiles({ name: "paste.png", mimeType: "image/png", buffer: test_png });
		await page.waitForTimeout(300);
		await t.drag([[8, 8], [100, 30]]); // move the pasted selection (it's at the top left)
		await t.tool("Pencil");
		// undo / redo
		await t.drag([[5, 5], [300, 230]]);
		await page.keyboard.press("Control+z");
		await page.keyboard.press("Control+z");
		await page.keyboard.press("Control+y");
	},
	async image_menu(t) {
		const { page } = t;
		await t.tool("Brush");
		await t.color(16);
		await t.drag([[10, 10], [80, 60], [150, 20]]);
		await t.tool("Rectangle");
		await t.drag([[100, 80], [180, 140]]);
		// Image > Flip/Rotate: flip vertical
		await t.menu("Image", "Flip/Rotate");
		await page.click(".window label[for='flip-vertical']");
		await page.click(".window button:has-text('OK')");
		// Flip/Rotate: rotate 90
		await t.menu("Image", "Flip/Rotate");
		await page.click(".window label[for='rotate-by-angle']");
		await page.click(".window label:has-text('90')");
		await page.click(".window button:has-text('OK')");
		// Stretch/Skew: 80% x 120%, skew 10 degrees
		await t.menu("Image", "Stretch/Skew");
		const inputs = await page.$$(".window input");
		await inputs[0].fill("80");
		await inputs[1].fill("120");
		await inputs[2].fill("10");
		await page.click(".window button:has-text('OK')");
		// invert colors
		await page.keyboard.press("Control+i");
		// select a region and rotate the selection by an arbitrary angle
		await t.tool("Select");
		await t.drag([[20, 20], [90, 90]]);
		await t.menu("Image", "Flip/Rotate");
		await page.click(".window label[for='rotate-by-angle']");
		await page.fill(".window input[name='rotate-by-arbitrary-angle']", "30");
		await page.click(".window button:has-text('OK')");
		await page.keyboard.press("Enter"); // deselect
		// clear image, then draw again
		await t.menu("Image", "Clear Image");
		await t.tool("Pencil");
		await t.drag([[30, 30], [120, 90]]);
		await page.keyboard.press("Control+z");
		await page.keyboard.press("Control+y");
	},
};

if (process.argv.includes("--typical")) {
	// About a minute of mixed drawing at a realistic pointer rate, to measure file size.
	sessions.typical = async (t) => {
		const { page } = t;
		const tool_cycle = ["Pencil", "Brush", "Airbrush", "Brush", "Line", "Ellipse", "Pencil", "Fill With Color"];
		for (let stroke = 0; stroke < 40; stroke++) {
			await t.tool(tool_cycle[stroke % tool_cycle.length]);
			await t.color(stroke % 28);
			const cx = 40 + (stroke * 37) % 240;
			const cy = 30 + (stroke * 53) % 180;
			if (tool_cycle[stroke % tool_cycle.length] === "Fill With Color") {
				await t.click(cx, cy);
				continue;
			}
			const [x0, y0] = await t.at(cx, cy);
			await page.mouse.move(x0, y0);
			await page.mouse.down();
			for (let i = 1; i <= 80; i++) {
				const [x, y] = await t.at(cx + Math.sin(i / 9 + stroke) * 30 + i / 3, cy + Math.cos(i / 7) * 25);
				await page.mouse.move(x, y);
				await page.waitForTimeout(16);
			}
			await page.mouse.up();
			await page.waitForTimeout(150);
		}
	};
}

/** canvas size per session (default 320x240) */
const session_sizes = {};
if (process.argv.includes("--long")) {
	// A long behavior-4 session on a big canvas (scripts/fixtures/long-v2.p95 was recorded with this): every tool,
	// whole-canvas fills (so the history gets trimmed by memory), undo/redo bursts that branch the history, and
	// selections moved around.
	session_sizes.long = [800, 600];
	sessions.long = async (t) => {
		const { page } = t;
		const tool_cycle = ["Pencil", "Brush", "Fill With Color", "Airbrush", "Line", "Rectangle", "Eraser/Color Eraser", "Ellipse", "Brush", "Fill With Color", "Rounded Rectangle", "Pencil"];
		for (let stroke = 0; stroke < 180; stroke++) {
			const tool = tool_cycle[stroke % tool_cycle.length];
			await t.tool(tool);
			await t.color((stroke * 5) % 28, stroke % 7 === 3 ? "right" : "left");
			const cx = 60 + (stroke * 137) % 680;
			const cy = 50 + (stroke * 89) % 500;
			if (tool === "Fill With Color") {
				await t.click(cx, cy);
			} else {
				const points = [];
				for (let i = 0; i <= 24; i++) {
					points.push([cx + Math.sin(i / 4 + stroke) * (40 + stroke % 50) + i * 2, cy + Math.cos(i / 5) * 35]);
				}
				await t.drag(points, { steps: 1, button: stroke % 7 === 3 ? "right" : "left", hold: tool === "Airbrush" ? 120 : 0 });
			}
			if (stroke % 11 === 10) {
				for (let i = 0; i < 3; i++) await page.keyboard.press("Control+z");
				await page.keyboard.press("Control+y");
			}
			if (stroke % 23 === 22) {
				await t.tool("Select");
				await t.drag([[cx - 40, cy - 30], [cx + 40, cy + 30]]);
				await t.drag([[cx, cy], [cx + 30, cy + 20], [cx + 60, cy - 10]]);
				await page.keyboard.press("Enter");
			}
		}
	};
}

if (process.argv.includes("--slow")) {
	for (const tool of ["Airbrush", "Brush", "Pencil"]) {
		sessions[`slow_${tool}`] = async (t) => {
			const { page } = t;
			await t.tool(tool);
			for (let stroke = 0; stroke < 3; stroke++) {
				const [x0, y0] = await t.at(50 + stroke * 60, 50);
				await page.mouse.move(x0, y0);
				await page.mouse.down();
				for (let i = 1; i <= 30; i++) {
					const [x, y] = await t.at(50 + stroke * 60 + i, 50 + Math.sin(i / 5) * 20);
					await page.mouse.move(x, y);
					await page.waitForTimeout(16);
				}
				await page.mouse.up();
				await page.waitForTimeout(100);
			}
		};
	}
}
const only_list = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length).split(",");
/** --only=a,b: run only the sessions/tests whose names contain one of these */
const wanted = (name) => !only_list || only_list.some((part) => name.includes(part));
const only = only_list ? only_list.join(",") : null;

/**
 * The 2draw contract end to end: the editor in a host page submits (png, { animation }) with the Submit button;
 * then a second editor continues it (&load= the png, &anim= the .p95), and the result replays to the same picture.
 */
async function test_host_submit_and_continue() {
	const files = {};
	const host_html = (query) => `<!doctype html><meta charset="utf-8"><body style="margin:0">
		<script>
			window.submissions = [];
			window.paint95Host = {
				async submit(png, extra) {
					const read = (blob) => blob.arrayBuffer().then((b) => Array.from(new Uint8Array(b)));
					window.submissions.push({ png: await read(png), p95: extra && extra.animation ? await read(extra.animation) : null });
				},
			};
		</script>
		<iframe src="index.html?${query}" style="border:0;width:1000px;height:680px"></iframe>`;
	const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
	watch(page, "continue");
	await page.route((url) => /\/__(host\d|prev\.png|prev\.p95)$/.test(url.pathname), (route) => {
		const name = new URL(route.request().url()).pathname.split("/").pop();
		if (name === "__prev.png") return route.fulfill({ contentType: "image/png", body: files.png });
		if (name === "__prev.p95") return route.fulfill({ contentType: "application/octet-stream", body: files.p95 });
		const anim = name === "__host3" ? `${base}/__missing.p95` : `${base}/__prev.p95`;
		const query = name === "__host1" ? "w=200&h=150" : `w=200&h=150&load=${encodeURIComponent(`${base}/__prev.png`)}&anim=${encodeURIComponent(anim)}`;
		return route.fulfill({ contentType: "text/html", body: host_html(query) });
	});
	const draw_in_frame = async (frame, points, tool) => {
		await wait_until(frame, () => !!(window.P95 && window.P95.recorder));
		await frame.click(`.tools-component .tool[title="${tool}"]`);
		const box = await (await frame.$(".main-canvas")).boundingBox();
		const scale = box.width / 200;
		await page.mouse.move(box.x + points[0][0] * scale, box.y + points[0][1] * scale);
		await page.mouse.down();
		for (const [x, y] of points.slice(1)) {
			await page.mouse.move(box.x + x * scale, box.y + y * scale, { steps: 4 });
		}
		await page.mouse.up();
	};
	const submit = async (frame) => {
		await frame.click(".paint95-submit-button");
		await page.waitForFunction(() => window.submissions.length > 0);
		return page.evaluate(() => window.submissions[0]);
	};
	const frame_of = async () => (await page.waitForSelector("iframe")).contentFrame();

	// session 1
	await page.goto(`${base}/__host1`);
	let frame = await frame_of();
	await draw_in_frame(frame, [[20, 20], [120, 60], [60, 120]], "Brush");
	await draw_in_frame(frame, [[150, 20], [180, 120]], "Airbrush");
	const first = await submit(frame);
	check(!!first.p95, "continue: host received an animation with the first submit");
	check(first.p95 && String.fromCharCode(...first.p95.slice(0, 4)) === "P95A", "continue: animation has the P95A magic");
	files.png = Buffer.from(first.png);
	// serve the previous recording as a v1 file (production has those): continuing must convert it to v2 losslessly
	const first_v1 = await with_format((format, b64, base64) => {
		const file = format.decode_p95(b64.decode(base64));
		return { base64: b64.encode(format.encode_p95(file, 1)), events: JSON.stringify(file.header.segments.map((x) => x.events)) };
	}, Buffer.from(first.p95).toString("base64"));
	files.p95 = Buffer.from(first_v1.base64, "base64");
	check(files.p95[4] === 1 && first.p95[4] === 2, `continue: the editor writes v2 (${first.p95[4]}); the previous file is served as v1 (${files.p95[4]})`);

	// session 2, continuing: the undo history of session 1 is restored; undo past the session boundary, then draw
	const restore_log = [];
	page.on("console", (message) => { if (/Restored the undo history|Couldn't restore/.test(message.text())) restore_log.push(message.text()); });
	await page.goto(`${base}/__host2`);
	frame = await frame_of();
	await wait_until(frame, () => !!(window.P95 && window.P95.recorder));
	const restored = await frame.evaluate(() => ({ undos: undos.length, url: location.search }));
	check(restored.undos >= 2 && !/p95nohistory/.test(restored.url), `continue: session 1's undo history was restored (${restored.undos} undo steps; ${restore_log.join("; ")})`);
	await draw_in_frame(frame, [[60, 60], [70, 70]], "Pencil");
	for (let i = 0; i < 3; i++) {
		await page.keyboard.press("Control+z"); // the pencil stroke, then session 1's airbrush and brush strokes
	}
	const after_undo = await frame.evaluate(() => {
		const data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data;
		let non_white = 0;
		for (let i = 0; i < data.length; i += 4) if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) non_white++;
		return non_white;
	});
	check(after_undo === 0, `continue: undoing past the session boundary removes session 1's strokes (${after_undo} non-white pixels left)`);
	await page.keyboard.press("Control+y"); // redo session 1's brush stroke
	await draw_in_frame(frame, [[30, 100], [190, 140]], "Line");
	await draw_in_frame(frame, [[100, 10], [190, 80]], "Ellipse");
	const second = await submit(frame);
	const editor_pixels = await frame.evaluate(() => Array.from(main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data));

	// session 3: the previous animation can't be loaded -> fresh recording starting from the load image
	await page.goto(`${base}/__host3`);
	frame = await frame_of();
	await draw_in_frame(frame, [[10, 140], [190, 10]], "Pencil");
	const third = await submit(frame);
	const p95_3 = Buffer.from(third.p95);
	const header_3 = JSON.parse(zlib.inflateSync(p95_3.subarray(12, 12 + p95_3.readUInt32LE(8))).toString());
	check(header_3.segments.length === 1 && header_3.segments[0].start.type === "image", `continue: missing previous animation -> fresh recording with the load image (${header_3.segments.map((x) => x.start.type)})`);
	await page.close();
	check(!!second.p95, "continue: host received an animation with the second submit");
	const p95 = Buffer.from(second.p95);
	const header = JSON.parse(zlib.inflateSync(p95.subarray(12, 12 + p95.readUInt32LE(8))).toString());
	check(header.segments.length === 2 && header.segments[1].start.type === "continue" && header.segments[1].start.history === true, `continue: the new file holds both sessions (${header.segments.map((x) => x.start.type)})`);
	console.log(`continue: ${p95.length} bytes for 2 sessions`);
	const continued = await with_format((format, b64, base64) => {
		const file = format.decode_p95(b64.decode(base64));
		return { version: file.version, first_segment: JSON.stringify([file.header.segments[0].events]) };
	}, p95.toString("base64"));
	check(continued.version === 2 && continued.first_segment === first_v1.events, "continue: continuing a v1 file wrote v2 with the old session's events unchanged");

	const player_page = await browser.newPage({ viewport: { width: 800, height: 600 } });
	watch(player_page, "continue/player");
	const replay = await replay_session(player_page, { base64: p95.toString("base64") });
	await player_page.close();
	compare("continue", { width: 200, height: 150, pixels: editor_pixels }, replay);
	return { png: files.png, p95_v2: Buffer.from(first.p95) };
}

/**
 * Revising always resumes from the recording; only a missing (404) or unreadable file starts over from the picture.
 * A drifting replay (wrong seed) or a truncated log still resumes with history and ends exactly on the posted picture.
 */
async function test_resume_cases(session1) {
	const variants = {
		corrupt: Buffer.concat([Buffer.from("P95A"), Buffer.from([2, 0, 0, 0, 0xff, 0xff, 0xff, 0x7f, 1, 2, 3])]),
		...await with_format((format, b64, base64) => {
			const seed = format.decode_p95(b64.decode(base64));
			seed.header.segments[0].seed ^= 0x5a5a5a5a; // the airbrush sprays differently: the replay drifts
			const truncated = format.decode_p95(b64.decode(base64));
			const events = truncated.header.segments[0].events;
			truncated.header.segments[0].events = events.slice(0, events.findIndex((e) => e[0] === "u") + 1);
			truncated.header.segments[0].truncated = true;
			truncated.header.truncated = true;
			return { seed: b64.encode(format.encode_p95(seed)), truncated: b64.encode(format.encode_p95(truncated)) };
		}, session1.p95_v2.toString("base64")),
	};
	for (const key of ["seed", "truncated"]) variants[key] = Buffer.from(variants[key], "base64");
	for (const [name, p95] of Object.entries(variants)) {
		const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
		watch(page, `resume/${name}`);
		await page.route((url) => /\/__(resume\.html|prev\.png|var\.p95)$/.test(url.pathname), (route) => {
			const file = new URL(route.request().url()).pathname.split("/").pop();
			if (file === "__prev.png") return route.fulfill({ contentType: "image/png", body: session1.png });
			if (file === "__var.p95") return route.fulfill({ contentType: "application/octet-stream", body: p95 });
			return route.fulfill({ contentType: "text/html", body: `<!doctype html><body style="margin:0"><script>window.submissions=[];window.paint95Host={async submit(png,extra){const r=(b)=>b.arrayBuffer().then((x)=>Array.from(new Uint8Array(x)));window.submissions.push({png:await r(png),p95:extra&&extra.animation?await r(extra.animation):null});}};</script><iframe src="index.html?w=200&h=150&load=${encodeURIComponent(`${base}/__prev.png`)}&anim=${encodeURIComponent(`${base}/__var.p95`)}" style="border:0;width:1000px;height:680px"></iframe>` });
		});
		await page.goto(`${base}/__resume.html`);
		const frame = await (await page.waitForSelector("iframe")).contentFrame();
		for (let i = 0; i < 200; i++) {
			if (await frame.evaluate(() => !!(window.P95 && window.P95.recorder)).catch(() => false)) break;
			await page.waitForTimeout(100);
		}
		const state = await frame.evaluate((png_bytes) => ({
			start: window.P95.recorder.segment.start,
			url: location.search,
			undos: undos.length,
			pixels_hash: (() => { const d = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data; let h = 0; for (let i = 0; i < d.length; i++) h = (Math.imul(h, 31) + d[i]) | 0; return h; })(),
		}));
		const posted = await frame.evaluate(async () => {
			// hash of the posted picture, decoded the way the editor loads it
			const { load_picture_image_data } = await import("./src/paint95-fetch.js");
			const d = (await load_picture_image_data(window.paint95_load_url, 200, 150)).data;
			let h = 0;
			for (let i = 0; i < d.length; i++) h = (Math.imul(h, 31) + d[i]) | 0;
			return h;
		});
		if (name === "corrupt") {
			check(state.start.type === "image" && !state.start.history, `resume: an unreadable recording starts over from the picture (${JSON.stringify(state.start).slice(0, 80)})`);
			await page.close();
			continue;
		}
		check(state.start.type === "continue" && state.start.history && state.start.snap === true && !/p95nohistory/.test(state.url),
			`resume: ${name}: resumes with history, then sets the posted picture (${JSON.stringify({ ...state.start, hash: undefined })}; ${state.undos} undo steps)`);
		check(state.pixels_hash === posted, `resume: ${name}: the canvas is exactly the posted picture`);
		// draw, undo once (keeps the snap step), draw, submit; the combined file replays to the same picture
		const box = await (await frame.$(".main-canvas")).boundingBox();
		const scale = box.width / 200;
		await frame.click(`.tools-component .tool[title="Line"]`);
		await page.mouse.move(box.x + 10 * scale, box.y + 140 * scale);
		await page.mouse.down();
		await page.mouse.move(box.x + 190 * scale, box.y + 100 * scale, { steps: 4 });
		await page.mouse.up();
		await frame.click(".paint95-submit-button");
		await page.waitForFunction(() => window.submissions.length > 0);
		const submitted = await page.evaluate(() => window.submissions[0]);
		const editor_pixels = await frame.evaluate(() => Array.from(main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data));
		await page.close();
		const player_page = await browser.newPage({ viewport: { width: 800, height: 600 } });
		watch(player_page, `resume/${name}/player`);
		const replay = await replay_session(player_page, { base64: Buffer.from(submitted.p95).toString("base64") });
		await player_page.close();
		check(replay.ended, `resume: ${name}: the combined recording plays to the end (drift reports: ${replay.drifts.map((d) => d.type).join(",") || "none"})`);
		const same = replay.pixels.length === editor_pixels.length && replay.pixels.every((v, i) => v === editor_pixels[i]);
		check(same, `resume: ${name}: the combined recording replays to exactly the submitted picture`);
	}
}

/**
 * Revising with this recording: how long the editor takes to restore the undo history.
 */
async function measure_restore(name, recording, width, height) {
	const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
	watch(page, `${name}/restore`);
	const log = [];
	page.on("console", (message) => { if (/Restored the undo history|Couldn't restore/.test(message.text())) log.push(message.text()); });
	await page.route((url) => /\/__r\.(png|p95|html)$/.test(url.pathname), (route) => {
		const name = new URL(route.request().url()).pathname.split("/").pop();
		if (name === "__r.png") return route.fulfill({ contentType: "image/png", body: Buffer.from(recording.png_base64, "base64") });
		if (name === "__r.p95") return route.fulfill({ contentType: "application/octet-stream", body: Buffer.from(recording.base64, "base64") });
		return route.fulfill({ contentType: "text/html", body: `<!doctype html><body style="margin:0"><iframe src="index.html?w=${width}&h=${height}&load=${encodeURIComponent(`${base}/__r.png`)}&anim=${encodeURIComponent(`${base}/__r.p95`)}" style="border:0;width:1000px;height:680px"></iframe>` });
	});
	await page.goto(`${base}/__r.html`);
	const frame = await (await page.waitForSelector("iframe")).contentFrame();
	for (let i = 0; i < 600; i++) {
		const ready = await frame.evaluate(() => !!(window.P95 && window.P95.recorder)).catch(() => false);
		if (ready) break;
		await page.waitForTimeout(100);
	}
	const state = await frame.evaluate(() => ({ undos: undos.length, url: location.search, start: window.P95.recorder.segment.start }));
	await page.close();
	check(state.start.history === true && !/p95nohistory/.test(state.url), `${name}: revising restores the undo history (${state.undos} undo steps; ${log.join("; ")})`);
}

/**
 * Polls fn in a frame or page (frame.waitForFunction can fall back to string evaluation, which the app's CSP blocks).
 */
async function wait_until(frame, fn, timeout = 30000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await frame.evaluate(fn).catch(() => false)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("wait_until: timed out");
}

/**
 * Runs fn(format_module, arg) in a page that has the app's .p95 format module (src/paint95-format.js) loaded.
 */
async function with_format(fn, arg) {
	const page = await browser.newPage();
	watch(page, "format");
	await page.route(`${base}/__format_host.html`, (route) => route.fulfill({
		contentType: "text/html",
		body: `<!doctype html><meta charset="utf-8"><script src="lib/pako-2.0.3.min.js"></script><script src="lib/UPNG.js"></script>`,
	}));
	await page.goto(`${base}/__format_host.html`, { waitUntil: "load" });
	try {
		return await page.evaluate(async ({ source, arg }) => {
			const format = await import("./src/paint95-format.js");
			const b64 = {
				decode: (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
				encode: (bytes) => {
					let binary = "";
					for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
					return btoa(binary);
				},
			};
			// eslint-disable-next-line no-new-func
			return new Function("format", "b64", "arg", `return (${source})(format, b64, arg);`)(format, b64, arg);
		}, { source: fn.toString(), arg });
	} finally {
		await page.close();
	}
}

/**
 * Playback timing: long pauses between strokes are skipped (a 10 s gap plays in at most 250 ms),
 * strokes keep their recorded timing, and the replayed picture doesn't depend on any of it.
 */
async function test_playback_timing() {
	const editor = await browser.newPage({ viewport: { width: 1024, height: 700 } });
	watch(editor, "timing/editor");
	const recording = await record_session(editor, {
		width: 320, height: 240, script: async (t) => {
			await t.tool("Pencil");
			for (const y of [60, 140]) {
				const [x0, y0] = await t.at(30, y);
				await t.page.mouse.move(x0, y0);
				await t.page.mouse.down();
				for (let i = 1; i <= 30; i++) {
					const [x, yy] = await t.at(30 + i * 8, y + Math.sin(i / 4) * 20);
					await t.page.mouse.move(x, yy);
					await t.page.waitForTimeout(15);
				}
				await t.page.mouse.up();
				await t.page.waitForTimeout(100);
			}
		},
	});
	await editor.close();
	// insert an artificial 10 s pause before the second stroke
	const { base64, downs, ups, first_stroke_recorded } = await with_format(async (format, b64, base64) => {
		const file = format.decode_p95(b64.decode(base64));
		const events = file.header.segments[0].events;
		const downs = events.map((event, i) => (event[0] === "d" ? i : -1)).filter((i) => i >= 0);
		const ups = events.map((event, i) => (event[0] === "u" ? i : -1)).filter((i) => i >= 0);
		events[downs[1]][1] += 10000;
		const first_stroke_recorded = events.slice(downs[0] + 1, ups[0] + 1).reduce((sum, event) => sum + event[1], 0);
		return { base64: b64.encode(format.encode_p95(file)), downs, ups, first_stroke_recorded };
	}, recording.base64);
	const modified = { ...recording, base64 };

	const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
	watch(page, "timing/player");
	await page.route(`${base}/__test_host.html`, (route) => route.fulfill({
		contentType: "text/html",
		body: `<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root" style="width:320px;height:240px"></div><script src="player.js"></script>`,
	}));
	await page.goto(`${base}/__test_host.html`, { waitUntil: "load" });
	const timing = await page.evaluate(async ({ base64, downs, ups }) => {
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		const player = new window.Paint95Player({ domRoot: document.getElementById("root"), lsaUrl: URL.createObjectURL(new Blob([bytes])) });
		await player.ready;
		const at = (index) => player._controller.timeline.find((entry) => entry.index === index).t;
		return { gap: at(downs[1]) - at(ups[0]), first_stroke: at(ups[0]) - at(downs[0]), duration: player.duration };
	}, { base64: modified.base64, downs, ups });
	await page.close();
	check(timing.gap <= 250, `timing: a 10 s pause between strokes plays in ${timing.gap} ms (<= 250)`);
	check(timing.first_stroke === first_stroke_recorded, `timing: a slow stroke keeps its recorded duration (${timing.first_stroke} ms, recorded ${first_stroke_recorded} ms)`);
	check(timing.duration < 2 * first_stroke_recorded + 1000, `timing: total playback ${timing.duration} ms`);

	const player_page = await browser.newPage({ viewport: { width: 800, height: 600 } });
	watch(player_page, "timing/replay");
	const replay = await replay_session(player_page, modified);
	await player_page.close();
	compare("timing", recording, replay);
}

/**
 * Regression: the player must show strokes progressively (in-progress strokes live on mask/preview canvases until the
 * pointer is released). Seeks to the middle of long pencil, brush and rectangle drags and checks for ink in the
 * player's output canvas.
 */
async function test_mid_stroke_ink() {
	const strokes = [
		{ tool: "Pencil", y: 40 },
		{ tool: "Brush", y: 100 },
		{ tool: "Rectangle", y: 160 },
	];
	const editor = await browser.newPage({ viewport: { width: 1024, height: 700 } });
	watch(editor, "midstroke/editor");
	const recording = await record_session(editor, {
		width: 320, height: 240, script: async (t) => {
			for (const { tool, y } of strokes) {
				await t.tool(tool);
				const [x0, y0] = await t.at(20, y);
				await t.page.mouse.move(x0, y0);
				await t.page.mouse.down();
				for (let i = 1; i <= 40; i++) {
					const [x, yy] = await t.at(20 + i * 7, y + (tool === "Rectangle" ? 30 : 0));
					await t.page.mouse.move(x, yy);
					await t.page.waitForTimeout(10);
				}
				await t.page.mouse.up();
				await t.page.waitForTimeout(50);
			}
		},
	});
	await editor.close();
	const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
	watch(page, "midstroke/player");
	await page.route(`${base}/__test_host.html`, (route) => route.fulfill({
		contentType: "text/html",
		body: `<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root" style="width:320px;height:240px"></div><script src="player.js"></script>`,
	}));
	await page.goto(`${base}/__test_host.html`, { waitUntil: "load" });
	const results = await page.evaluate(async ({ base64, strokes }) => {
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		const player = new window.Paint95Player({ domRoot: document.getElementById("root"), lsaUrl: URL.createObjectURL(new Blob([bytes])), fit: "contain" });
		await player.ready;
		const controller = player._controller;
		const events = controller.file.header.segments[0].events;
		// playback times of each stroke's pointerdown and pointerup
		const downs = [];
		const ups = [];
		for (const entry of controller.timeline) {
			if (entry.index < 0) continue;
			const type = events[entry.index][0];
			if (type === "d") downs.push(entry.t);
			if (type === "u") ups.push(entry.t);
		}
		const out = [];
		for (let i = 0; i < strokes.length; i++) {
			const mid = (downs[i] + ups[i]) / 2;
			player.seek(mid);
			for (let n = 0; n < 500 && !(player._caught_up && !player._restarting); n++) {
				await new Promise((resolve) => requestAnimationFrame(resolve));
			}
			await new Promise((resolve) => requestAnimationFrame(resolve));
			const ctx = player._canvas.getContext("2d");
			const band = ctx.getImageData(0, strokes[i].y - 6, 320, strokes[i].tool === "Rectangle" ? 44 : 12).data;
			let ink = 0;
			let ink_right_half = 0;
			for (let p = 0; p < band.length; p += 4) {
				if (band[p] < 128 && band[p + 1] < 128 && band[p + 2] < 128) {
					ink++;
					if ((p / 4) % 320 >= 240) ink_right_half++; // the stroke goes from x=20 to x=300
				}
			}
			const document_ink = (() => {
				const doc = controller.get_document_canvas().getContext("2d").getImageData(0, strokes[i].y - 6, 320, 12).data;
				let count = 0;
				for (let p = 0; p < doc.length; p += 4) if (doc[p] < 128) count++;
				return count;
			})();
			out.push({ tool: strokes[i].tool, mid, ink, ink_right_half, document_ink });
		}
		return out;
	}, { base64: recording.base64, strokes });
	await page.close();
	for (const result of results) {
		check(result.ink > 0 && result.ink_right_half === 0, `midstroke: ${result.tool} shows partial ink halfway through the stroke (${result.ink} dark pixels, ${result.ink_right_half} past three quarters of the way; document canvas has ${result.document_ink})`);
	}
}

/**
 * v1 <-> v2 round trip on the test logs and a real production v1 file: events decode identically,
 * and the v2 conversion replays to the same picture. Reports sizes.
 */
async function test_format_v1_v2(recordings) {
	const logs = { ...recordings };
	try {
		const response = await fetch("https://s3.amazonaws.com/zoraw.2draw.net/data/13/132726/132726-v1.p95");
		if (response.ok) {
			logs["132726"] = { base64: Buffer.from(await response.arrayBuffer()).toString("base64") };
		} else {
			console.log(`format: couldn't fetch 132726-v1.p95 (HTTP ${response.status}); skipping it`);
		}
	} catch (error) {
		console.log(`format: couldn't fetch 132726-v1.p95 (${error.message}); skipping it`);
	}
	for (const [name, log] of Object.entries(logs)) {
		const result = await with_format((format, b64, base64) => {
			const original = format.decode_p95(b64.decode(base64));
			const events_json = JSON.stringify(original.header.segments.map((x) => x.events));
			const header_json = (file) => JSON.stringify({ ...file.header, segments: file.header.segments.map((x) => ({ ...x, events: undefined })) });
			const v1 = format.encode_p95(original, 1);
			const v2 = format.encode_p95(original, 2);
			const from_v1 = format.decode_p95(v1);
			const from_v2 = format.decode_p95(v2);
			// and back: v2 -> v1
			const back_to_v1 = format.decode_p95(format.encode_p95(from_v2, 1));
			const same = (file) => JSON.stringify(file.header.segments.map((x) => x.events)) === events_json && header_json(file) === header_json(original) &&
				file.blobs.length === original.blobs.length && file.blobs.every((blob, i) => blob.length === original.blobs[i].length && blob.every((byte, j) => byte === original.blobs[i][j]));
			const sizes = (bytes) => format.p95_section_sizes(bytes);
			const s1 = sizes(v1);
			const s2 = sizes(v2);
			return {
				original_version: original.version,
				ok: same(from_v1) && same(from_v2) && same(back_to_v1),
				events: original.header.segments.reduce((n, x) => n + x.events.length, 0),
				v1: { total: s1.total, events_and_header: s1.header, blobs: s1.blobs },
				v2: { total: s2.total, header: s2.header, events: s2.events, blobs: s2.blobs },
				v2_base64: b64.encode(v2),
			};
		}, log.base64);
		check(result.ok, `format: ${name} (v${result.original_version}, ${result.events} events) decodes identically from v1 and v2, and v2 -> v1`);
		console.log(`format: ${name}: v1 ${result.v1.total} bytes (events+header ${result.v1.events_and_header}, blobs ${result.v1.blobs}); v2 ${result.v2.total} bytes (header ${result.v2.header}, events ${result.v2.events}, blobs ${result.v2.blobs})`);
		if (name === "132726") {
			const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
			watch(page, "format/132726");
			const replay_v1 = await replay_session(page, log);
			const replay_v2 = await replay_session(page, { base64: result.v2_base64 });
			await page.close();
			check(replay_v1.drifts.length === 0 && replay_v2.drifts.length === 0, `format: 132726 replays without drift from v1 and v2 (${replay_v1.drifts.length}, ${replay_v2.drifts.length})`);
			compare("format: 132726 v2 vs v1 replay", replay_v1, replay_v2);
		}
	}
}

/**
 * The Local Font Access API (queryLocalFonts) shows a permission prompt: it must never be called on its own,
 * neither by the player (text in a recording) nor by the editor's text tool.
 */
async function test_no_font_permission(recording_with_text) {
	const spy = () => {
		window.__query_local_fonts_calls = 0;
		window.queryLocalFonts = async () => {
			window.__query_local_fonts_calls++;
			return [];
		};
	};
	// editor: use the text tool
	const editor = await browser.newPage({ viewport: { width: 1024, height: 700 } });
	watch(editor, "fonts/editor");
	await editor.addInitScript(spy);
	await record_session(editor, {
		width: 320, height: 240, script: async (t) => {
			await t.tool("Text");
			await t.drag([[20, 20], [200, 60]]);
			await t.page.keyboard.type("fonts");
			await t.page.waitForTimeout(500);
			await t.tool("Pencil");
		},
	});
	const editor_state = await editor.evaluate(() => ({
		calls: window.__query_local_fonts_calls,
		more_fonts: !!document.querySelector(".font-box select option[value='more-fonts']"),
	}));
	await editor.close();
	check(editor_state.calls === 0, `fonts: the editor's text tool doesn't call queryLocalFonts (${editor_state.calls} calls)`);
	check(editor_state.more_fonts, "fonts: the font list offers \"More fonts…\" instead");
	if (!recording_with_text) return;
	// player: a recording with text
	const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
	watch(page, "fonts/player");
	await page.addInitScript(spy);
	const replay = await replay_session(page, recording_with_text, { keep_page: true });
	const calls = await page.evaluate(() => window.__p95_test_player._frame.iframe.contentWindow.__query_local_fonts_calls);
	await page.close();
	check(replay.ended && calls === 0, `fonts: playing a recording with text doesn't call queryLocalFonts (${calls} calls)`);
}

/**
 * Libraries for rarer formats (bmp.js, UTIF.js, AnyPalette, gif.js) load on first use: pasting a BMP works.
 */
async function test_lazy_libraries() {
	// a 4x2 24-bit BMP
	const width = 4;
	const height = 2;
	const row = Math.ceil(width * 3 / 4) * 4;
	const bmp = Buffer.alloc(54 + row * height);
	bmp.write("BM", 0);
	bmp.writeUInt32LE(bmp.length, 2);
	bmp.writeUInt32LE(54, 10);
	bmp.writeUInt32LE(40, 14);
	bmp.writeInt32LE(width, 18);
	bmp.writeInt32LE(height, 22);
	bmp.writeUInt16LE(1, 26);
	bmp.writeUInt16LE(24, 28);
	bmp.writeUInt32LE(row * height, 34);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const o = 54 + y * row + x * 3;
		bmp[o] = 255; bmp[o + 1] = x * 60; bmp[o + 2] = y * 200; // BGR
	}
	const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
	watch(page, "lazy");
	await page.goto(`${base}/index.html?w=100&h=80`);
	await wait_until(page, () => !!(window.P95 && window.P95.recorder));
	const before = await page.evaluate(() => [typeof window.decodeBMP, typeof window.AnyPalette, typeof window.GIF, typeof window.UTIF]);
	await page.click(`.menus .menu-button:has-text("Edit")`);
	const [chooser] = await Promise.all([
		page.waitForEvent("filechooser"),
		page.click(`.menu-popup:visible .menu-item[aria-label="Paste From..."]`),
	]);
	await chooser.setFiles({ name: "paste.bmp", mimeType: "image/bmp", buffer: bmp });
	await wait_until(page, () => !!selection);
	const after = await page.evaluate(() => ({ decoder: typeof window.decodeBMP, size: [selection.width, selection.height] }));
	await page.close();
	check(before.every((t) => t === "undefined"), `lazy: bmp.js, AnyPalette, gif.js and UTIF.js aren't loaded at startup (${before})`);
	check(after.decoder === "function" && after.size.join() === "4,2", `lazy: pasting a BMP loads its decoder (${JSON.stringify(after)})`);
}

/**
 * History steps are stored as patches: going to every step of a varied session must give exactly the picture
 * that step had when it was made (hashes taken at the time, with &p95debug=1).
 */
async function test_history_patches() {
	for (const name of ["all_tools", "image_menu"]) {
		await test_history_patches_with(name);
	}
}
async function test_history_patches_with(name) {
	const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
	watch(page, `patches/${name}`);
	await record_session(page, { width: 320, height: 240, script: sessions[name], debug: true });
	// the history window (Edit > History) lists the steps and jumps to them
	await page.keyboard.press("Control+Shift+Y");
	await page.waitForSelector(".history-window .history-entry");
	const entries = await page.$$(".history-window .history-entry");
	const window_check = { entries: entries.length, ok: 0, bad: 0 };
	for (const index of [1, Math.floor(entries.length / 2), entries.length - 1]) {
		const entry = (await page.$$(".history-window .history-entry"))[index];
		if (!entry) continue;
		await entry.click();
		const ok = await page.evaluate(() => {
			const expected = window.P95.debug_history_hashes.get(current_history_node.id);
			if (expected === undefined) return null;
			const d = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
			const words = new Uint32Array(d.data.buffer);
			let h = 0x811c9dc5 ^ d.width ^ (d.height << 16);
			for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 0x01000193);
			return (h >>> 0) === expected;
		});
		if (ok === true) window_check.ok++;
		if (ok === false) window_check.bad++;
	}
	check(window_check.entries > 5 && window_check.ok > 0 && window_check.bad === 0, `patches: ${name}: the history window jumps to steps with their exact pictures (${JSON.stringify(window_check)})`);
	await page.keyboard.press("Escape");
	const result = await page.evaluate(() => {
		const hash = () => {
			const d = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
			const words = new Uint32Array(d.data.buffer);
			let h = 0x811c9dc5 ^ d.width ^ (d.height << 16);
			for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 0x01000193);
			return h >>> 0;
		};
		const expected = window.P95.debug_history_hashes;
		const ids = [...expected.keys()];
		let checked = 0;
		const mismatches = [];
		// visit in a scrambled order, so pictures are rebuilt from all directions of the tree
		const order = ids.map((id, i) => ids[(i * 7) % ids.length]);
		for (const id of [...order, ...ids.reverse()]) {
			window.P95.commands.go_to_history_node(id, false);
			if (current_history_node.id !== id) continue; // (pruned or discarded)
			checked++;
			if (hash() !== expected.get(id)) mismatches.push(id);
		}
		return { steps: ids.length, checked, mismatches, stats: window.P95.history_stats(), anchor_mismatches: window.P95.debug_anchor_mismatches || 0, captures: window.P95.debug_captures };
	});
	await page.close();
	check(result.anchor_mismatches === 0 && result.captures.incremental > 5, `patches: ${name}: steps read back only the changed rectangle, and it always matches the canvas (${JSON.stringify(result.captures)}; ${result.anchor_mismatches} mismatches)`);
	check(result.stats.bytes === result.stats.running_total, `patches: ${name}: the running memory total matches the steps (${result.stats.bytes} vs ${result.stats.running_total})`);
	check(result.checked > 10 && result.mismatches.length === 0, `patches: ${name}: every history step rebuilds its exact picture (${result.checked} visits of ${result.steps} steps; mismatches ${JSON.stringify(result.mismatches)}; ${(result.stats.bytes / result.stats.steps / 1024).toFixed(1)} KB per step)`);
}

/**
 * The history limit. ENGINE_BEHAVIOR 3 (recordings from before patches): by step count, as if each step were a full
 * snapshot. ENGINE_BEHAVIOR 4: by the memory the steps hold. Both replay identically, undoing past the limit.
 */
async function test_history_cap() {
	const width = 1600;
	const height = 1600; // 10 MB per full picture: behavior 3 keeps 13 steps, pruning at 27
	for (const behavior of [3, 4]) {
		for (const kind of behavior === 4 ? ["strokes", "fills"] : ["strokes"]) {
			const editor = await browser.newPage({ viewport: { width: 1024, height: 700 } });
			watch(editor, `historycap/${behavior}/${kind}`);
			const recording = await record_session(editor, {
				width, height, script: async (t) => {
					await t.page.evaluate((behavior) => {
						window.P95.behavior = behavior;
						window.P95.recorder.segment.engine.behavior = behavior;
					}, behavior);
					if (kind === "strokes") {
						await t.tool("Pencil");
						for (let i = 0; i < 30; i++) {
							await t.drag([[5 + i * 3, 5], [5 + i * 3, 40]]);
						}
					} else {
						// every fill changes the whole canvas: 20 MB patches, past the 96 MB budget
						await t.tool("Fill With Color");
						for (let i = 0; i < 12; i++) {
							await t.page.evaluate((i) => {
								selected_colors.foreground = i % 2 ? "rgb(255,0,0)" : "rgb(0,0,255)";
								$(window).trigger("option-changed");
							}, i);
							await t.click(50, 50);
						}
					}
					for (let i = 0; i < 20; i++) {
						await t.page.keyboard.press("Control+z");
					}
					await t.tool("Pencil");
					await t.drag([[10, 60], [100, 60]]);
				},
			});
			const stats = await editor.evaluate(() => window.P95.history_stats()).catch(() => null);
			if (process.argv.includes("--verbose")) console.log("DBG", kind, behavior, await editor.evaluate(() => JSON.stringify(window.P95.history_stats())));
			await editor.close();
			if (behavior === 4) {
				check(stats && stats.bytes === stats.running_total, `historycap: the running memory total matches the steps (${stats && stats.bytes} vs ${stats && stats.running_total})`);
			}
			if (behavior === 3) {
				check(stats && stats.steps <= 2 * 13 + 1, `historycap: behavior 3 caps the history by step count (${stats && stats.steps} steps kept)`);
			} else if (kind === "strokes") {
				check(stats && stats.steps >= 31, `historycap: behavior 4 keeps every small step (${stats && stats.steps} steps, ${stats && (stats.bytes / 1024).toFixed(0)} KB)`);
			} else {
				check(stats && stats.steps < 14 && stats.bytes <= 96 * 1024 * 1024, `historycap: behavior 4 trims by memory (${stats && stats.steps} steps, ${stats && (stats.bytes / 1048576).toFixed(0)} MB)`);
			}
			const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
			watch(page, `historycap/${behavior}/${kind}/player`);
			const replay = await replay_session(page, recording);
			await page.close();
			compare(`historycap behavior ${behavior} ${kind}`, recording, replay);
		}
	}
}

/** Recordings made with ENGINE_BEHAVIOR 1 (transforms stored as pixels, v1 container) still replay exactly. */
async function test_behavior1_fixtures() {
	for (const name of ["image_menu-behavior1-v1", "all_tools-behavior1-v1"]) {
		const base64 = fs.readFileSync(path.join(repo_root, "scripts", "fixtures", `${name}.p95`)).toString("base64");
		const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
		watch(page, name);
		const replay = await replay_session(page, { base64 });
		await page.close();
		check(replay.ended && replay.drifts.length === 0, `behavior1: ${name} replays without drift (${JSON.stringify(replay.drifts).slice(0, 200)})`);
	}
}

/**
 * Pictures by reference: a revision without a usable recording stores the starting picture's URL (and hash),
 * and the player fetches it; with a drifting replay, the player snaps to finalImageUrl at the end.
 */
async function test_references() {
	const width = 200;
	const height = 150;
	const start_png = make_test_png(); // 24x16, drawn at the top left of a white 200x150 canvas
	const editor = await browser.newPage({ viewport: { width: 1024, height: 700 } });
	watch(editor, "references/editor");
	const start_url = `${base}/data/1/77/77-v1.png`;
	await editor.route((url) => url.pathname.endsWith("/data/1/77/77-v1.png"), (route) => route.fulfill({ contentType: "image/png", body: start_png }));
	await editor.goto(`${base}/index.html?w=${width}&h=${height}&load=${encodeURIComponent(start_url)}`, { waitUntil: "networkidle" });
	for (let i = 0; i < 100 && !(await editor.evaluate(() => !!(window.P95 && window.P95.recorder))); i++) await editor.waitForTimeout(100);
	const box = await (await editor.$(".main-canvas")).boundingBox();
	await editor.click(`.tools-component .tool[title="Brush"]`);
	await editor.mouse.move(box.x + 30, box.y + 30);
	await editor.mouse.down();
	for (let i = 0; i < 12; i++) await editor.mouse.move(box.x + 30 + i * 10, box.y + 30 + i * 6);
	await editor.mouse.up();
	const recording = await editor.evaluate(async () => {
		const bytes = new Uint8Array(await window.P95.recorder.finalize().arrayBuffer());
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		const image_data = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height);
		return { base64: btoa(binary), size: bytes.length, start: window.P95.recorder.segment.start, width: image_data.width, height: image_data.height, pixels: Array.from(image_data.data), png_base64: main_canvas.toDataURL("image/png").split(",")[1] };
	});
	await editor.close();
	check(recording.start.type === "image" && recording.start.url === start_url && typeof recording.start.hash === "number" && recording.start.blob === undefined,
		`references: the starting picture is stored by URL (${JSON.stringify(recording.start)}); file ${recording.size} bytes`);

	// replay: fetches the starting picture
	let page = await browser.newPage({ viewport: { width: 800, height: 600 } });
	watch(page, "references/player");
	await page.route((url) => url.pathname.endsWith("/data/1/77/77-v1.png"), (route) => route.fulfill({ contentType: "image/png", body: start_png }));
	let replay = await replay_session(page, recording);
	await page.close();
	compare("references: replay with the starting picture by URL", recording, replay);

	// starting picture unavailable, with the final picture from the page: drift, then the end snaps to it
	page = await browser.newPage({ viewport: { width: 800, height: 600 } });
	watch(page, "references/player-missing");
	await page.route((url) => url.pathname.endsWith("/__final.png"), (route) => route.fulfill({ contentType: "image/png", body: Buffer.from(recording.png_base64, "base64") }));
	replay = await replay_session(page, recording, { final_image_url: `${base}/__final.png` });
	await page.close();
	check(replay.drifts.length > 0, `references: a missing starting picture is reported as drift (${replay.drifts.map((d) => d.type)})`);
	const same = replay.pixels.length === recording.pixels.length && replay.pixels.every((v, i) => v === recording.pixels[i]);
	check(same, "references: after drifting, the end shows the final picture from finalImageUrl");
}

/**
 * Seeking backwards shows no catch-up frames: the output canvas keeps the last frame until the target frame is drawn,
 * and `seeking` goes true, then false with an onTimeUpdate (anim-strip.ts holds the frame on it).
 */
async function test_seek_hold(recording) {
	if (!recording) return;
	const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
	watch(page, "seekhold");
	await page.route(`${base}/__test_host.html`, (route) => route.fulfill({
		contentType: "text/html",
		body: `<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root" style="width:320px;height:240px"></div><script src="player.js"></script>`,
	}));
	await page.goto(`${base}/__test_host.html`, { waitUntil: "load" });
	const result = await page.evaluate(async (base64) => {
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		const updates = [];
		const player = new window.Paint95Player({
			domRoot: document.getElementById("root"),
			lsaUrl: URL.createObjectURL(new Blob([bytes])),
			onTimeUpdate: (info) => updates.push({ seeking: info.seeking, time: info.currentTime }),
		});
		await player.ready;
		const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
		player.seek(player.duration);
		while (player.seeking) await frame();
		// count paints of the output canvas during the backward seek
		let paints = 0;
		let paints_while_seeking = 0;
		const draw = player._ctx.drawImage.bind(player._ctx);
		player._ctx.drawImage = (...args) => {
			paints++;
			if (player.seeking && args[0] === player._controller.get_frame().canvas) paints_while_seeking++;
			return draw(...args);
		};
		updates.length = 0;
		player.seek(player.duration / 2);
		const seeking_right_after = player.seeking;
		while (player.seeking) await frame();
		await frame();
		return {
			seeking_right_after,
			seeking_after: player.seeking,
			paints, paints_while_seeking,
			cleared_update: updates.some((u) => u.seeking === true) && updates.length > 0 && updates[updates.length - 1].seeking === false,
			speeds: [0.5, 1, 2, 4, 8, 16, 64, 1000, 0].map((x) => { player.setSpeed(x); return player._speed; }),
		};
	}, recording.base64);
	await page.close();
	check(result.seeking_right_after && !result.seeking_after && result.cleared_update, `seekhold: seeking goes true on seek() and false (with an onTimeUpdate) when the target is drawn (${JSON.stringify(result)})`);
	check(result.paints_while_seeking === 0 && result.paints > 0, `seekhold: no catch-up frames are painted during a backward seek (${result.paints_while_seeking} while seeking, ${result.paints} paints in all)`);
	check(result.speeds.join() === "0.5,1,2,4,8,16,64,64,1", `seekhold: the strip's speeds (0.5…16, max = 64) are accepted (${result.speeds})`);
}

/** mulberry32, for reproducible random seeks */
function seeded_random(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Opens a replay engine page (index.html?replay=1) with the recording loaded and prepared. */
async function open_replay_engine(label, base64) {
	const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
	watch(page, label);
	await page.goto(`${base}/index.html?replay=1`, { waitUntil: "load" });
	await wait_until(page, () => !!window.paint95Replay);
	const info = await page.evaluate(async (base64) => {
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		const controller = window.paint95Replay;
		const info = controller.load(bytes.buffer);
		await controller.prepare({});
		// what a seek must reproduce: the frame the player shows, and the undo history behind it
		window.__p95_state_hash = () => {
			const view = controller.get_frame().canvas;
			const image_data = view.getContext("2d").getImageData(0, 0, view.width, view.height);
			const words = new Uint32Array(image_data.data.buffer);
			let h = 0x811c9dc5 ^ view.width ^ (view.height << 16);
			for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 0x01000193);
			const stats = window.P95.history_stats();
			return `${(h >>> 0).toString(16)} ${view.width}x${view.height} steps=${stats.steps} bytes=${stats.running_total} undos=${undos.length} redos=${redos.length} at=${current_history_node.id}`;
		};
		return { duration: info.duration, entries: controller.timeline.length, times: controller.timeline.map((entry) => entry.t) };
	}, base64);
	return { page, info };
}

/**
 * Random seeks with in-memory checkpoints (src/paint95-checkpoint.js) land on exactly the frame (and undo history)
 * of a straight replay to that time, for every fixture and engine behavior; also with a memory budget so small that
 * checkpoints get thinned out.
 */
async function test_checkpoint_seeks(recordings) {
	const logs = {};
	for (const name of ["132730-v1", "typical-v2", "image_menu-behavior1-v1", "all_tools-behavior1-v1", "long-v2"]) {
		const file = path.join(repo_root, "scripts", "fixtures", `${name}.p95`);
		if (fs.existsSync(file)) logs[name] = fs.readFileSync(file).toString("base64");
	}
	for (const name of ["all_tools", "image_menu"]) {
		if (recordings[name]) logs[`${name} (recorded now)`] = recordings[name].base64;
	}
	try {
		const response = await fetch("https://s3.amazonaws.com/zoraw.2draw.net/data/13/132726/132726-v1.p95");
		if (response.ok) logs["132726-v1"] = Buffer.from(await response.arrayBuffer()).toString("base64");
	} catch (error) {
		console.log(`checkpoints: couldn't fetch 132726-v1.p95 (${error.message}); skipping it`);
	}
	const per_log = Number(process.env.P95_SEEKS || 2400);
	let total_seeks = 0;
	for (const [name, base64] of Object.entries(logs)) {
		const started = Date.now();
		const reference = await open_replay_engine(`checkpoints/${name}/reference`, base64);
		const { duration, times: entry_times } = reference.info;
		const random = seeded_random(name.length * 7919 + 1);
		// seeks: anywhere, a little before or after the last one (scrubbing, replaying a bit), exactly on an event's
		// time, and the ends
		const seeks = [];
		let last = duration / 2;
		for (let i = 0; i < per_log; i++) {
			const r = random();
			let t;
			if (r < 0.4) t = random() * duration;
			else if (r < 0.7) t = last + (random() - 0.6) * duration * 0.04;
			else if (r < 0.92) t = entry_times[Math.floor(random() * entry_times.length)];
			else t = random() < 0.5 ? 0 : duration;
			t = Math.max(0, Math.min(duration, Math.round(t * 1000) / 1000));
			seeks.push(t);
			last = t;
		}
		const expected = await reference.page.evaluate((times) => {
			const controller = window.paint95Replay;
			const out = {};
			for (const t of [...new Set(times)].sort((a, b) => a - b)) {
				controller.advance_to(t);
				out[t] = window.__p95_state_hash();
			}
			return out;
		}, seeks);
		await reference.page.close();
		// two runs: plenty of checkpoints; then a budget that keeps thinning them out
		for (const [variant, options, count] of [["many", { memory: 256 * 1024 * 1024, interval: 10 }, Math.ceil(per_log * 0.75)], ["thinned", { memory: 8 * 1024 * 1024, interval: 5 }, Math.floor(per_log * 0.25)]]) {
			const engine = await open_replay_engine(`checkpoints/${name}/${variant}`, base64);
			const list = variant === "many" ? seeks.slice(0, count) : seeks.slice(seeks.length - count);
			const result = await engine.page.evaluate(({ list, expected, options }) => {
				const controller = window.paint95Replay;
				controller.enable_checkpoints(options);
				const store = controller.checkpoints;
				let restores = 0;
				const restore = store.restore.bind(store);
				store.restore = (...args) => { restores++; return restore(...args); };
				const mismatches = [];
				let refused = 0;
				let peak_bytes = 0;
				let peak_count = 0;
				for (const t of list) {
					if (!controller.seek(t)) {
						refused++;
						continue;
					}
					controller.advance_to(t);
					const actual = window.__p95_state_hash();
					if (actual !== expected[t] && mismatches.length < 5) {
						mismatches.push({ t, actual, expected: expected[t] });
					}
					peak_bytes = Math.max(peak_bytes, store.bytes);
					peak_count = Math.max(peak_count, store.list.length);
				}
				return { mismatches, refused, restores, peak_mb: Math.round(peak_bytes / 1048576 * 10) / 10, peak_count, final_count: store.list.length, interval: store.interval, disabled: store.disabled };
			}, { list, expected, options });
			await engine.page.close();
			total_seeks += list.length;
			check(result.mismatches.length === 0 && result.refused === 0 && result.restores > 0 && !result.disabled,
				`checkpoints: ${name} (${variant}, ${Math.round((Date.now() - started) / 1000)} s): ${list.length} random seeks land exactly on the straight replay's frame and history (${result.restores} restores, up to ${result.peak_count} checkpoints / ${result.peak_mb} MB${variant === "thinned" ? `, thinned to every ${result.interval} ms of work` : ""}${result.mismatches.length ? `; MISMATCH ${JSON.stringify(result.mismatches).slice(0, 600)}` : ""}${result.refused ? `; ${result.refused} refused` : ""})`);
		}
	}
	console.log(`checkpoints: ${total_seeks} random seeks in all`);
}

/**
 * 132730 (a 100,000-event drawing): dragging the strip's scrubber backwards used to start a fresh replay engine (an
 * iframe) for every backward seek, dozens at once, each replaying from the start; it never caught up. Now a burst of
 * backward seeks stays in the one engine (restoring checkpoints) and lands on the straight replay's frame.
 */
async function test_scrub_132730() {
	const base64 = fs.readFileSync(path.join(repo_root, "scripts", "fixtures", "132730-v1.p95")).toString("base64");
	const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
	watch(page, "scrub");
	await page.route(`${base}/__test_host.html`, (route) => route.fulfill({
		contentType: "text/html",
		body: `<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root" style="width:400px;height:300px"></div><script src="player.js"></script>`,
	}));
	await page.goto(`${base}/__test_host.html`, { waitUntil: "load" });
	const result = await page.evaluate(async (base64) => {
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		const player = new window.Paint95Player({ domRoot: document.getElementById("root"), lsaUrl: URL.createObjectURL(new Blob([bytes])) });
		await player.ready;
		const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
		const land = async () => {
			const start = performance.now();
			while (player.seeking && performance.now() - start < 60000) await frame();
			return performance.now() - start;
		};
		player.seek(player.duration * 0.9);
		const forward_ms = await land();
		// drag from 90% back to 10% over ~60 frames, like the strip does on pointermove
		let max_iframes = 0;
		for (let i = 0; i <= 60; i++) {
			player.seek(player.duration * (0.9 - 0.8 * i / 60));
			max_iframes = Math.max(max_iframes, document.querySelectorAll("iframe").length);
			await frame();
		}
		const land_ms = await land();
		// then back and forth around 30%
		for (let i = 0; i < 30; i++) {
			player.seek(player.duration * (0.3 + 0.1 * Math.sin(i)));
			max_iframes = Math.max(max_iframes, document.querySelectorAll("iframe").length);
			await frame();
		}
		const land2_ms = await land();
		const view = player._controller.get_frame().canvas;
		const image_data = view.getContext("2d").getImageData(0, 0, view.width, view.height);
		const words = new Uint32Array(image_data.data.buffer);
		let h = 0x811c9dc5;
		for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 0x01000193);
		return { forward_ms, land_ms, land2_ms, max_iframes, time: player.currentTime, hash: h >>> 0, checkpoints: player._controller.checkpoints ? player._controller.checkpoints.list.length : 0 };
	}, base64);
	await page.close();
	const reference = await open_replay_engine("scrub/reference", base64);
	const expected = await reference.page.evaluate((time) => {
		window.paint95Replay.advance_to(time);
		const view = window.paint95Replay.get_frame().canvas;
		const image_data = view.getContext("2d").getImageData(0, 0, view.width, view.height);
		const words = new Uint32Array(image_data.data.buffer);
		let h = 0x811c9dc5;
		for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 0x01000193);
		return h >>> 0;
	}, result.time);
	await reference.page.close();
	check(result.max_iframes === 1, `scrub: 132730: dragging backwards stays in one replay engine (${result.max_iframes} iframes at most)`);
	check(result.land_ms < 3000 && result.land2_ms < 3000, `scrub: 132730: the drag lands quickly (${Math.round(result.land_ms)} ms, then ${Math.round(result.land2_ms)} ms; the first seek to 90% took ${Math.round(result.forward_ms)} ms; ${result.checkpoints} checkpoints)`);
	check(result.hash === expected, `scrub: 132730: it lands on the straight replay's frame (${result.hash.toString(16)} vs ${expected.toString(16)})`);
}

const recordings = {};

try {
	for (const [name, script] of Object.entries(sessions)) {
		if (!wanted(name)) continue;
		const editor = await browser.newPage({ viewport: { width: 1024, height: 700 } });
		watch(editor, `${name}/editor`);
		const [width, height] = session_sizes[name] || [320, 240];
		const recording = await record_session(editor, { width, height, script });
		await editor.close();
		console.log(`${name}: ${recording.events} events, ${recording.size} bytes, event counts ${JSON.stringify(recording.counts)}`);
		check(!recording.truncated, `${name}: recording not truncated`);
		const player_page = await browser.newPage({ viewport: { width: 800, height: 600 } });
		watch(player_page, `${name}/player`);
		const replay = await replay_session(player_page, recording, { seek_back: name === "all_tools" });
		await player_page.close();
		compare(name, recording, replay);
		recordings[name] = recording;
		if (name === "image_menu") {
			check(!recording.counts.b && !recording.counts.p, `image_menu: rotate/stretch/skew store no pixels, and there are no picture keyframes (${JSON.stringify(recording.counts)})`);
		}
		if (name === "all_tools" || name === "typical") {
			await measure_restore(name, recording, 320, 240);
		}
		if (process.env.P95_SAVE) {
			fs.writeFileSync(path.join(process.env.P95_SAVE, `${name}.p95`), Buffer.from(recording.base64, "base64"));
		}
	}
	if (wanted("continue") || wanted("resume")) {
		const session1 = await test_host_submit_and_continue();
		await test_resume_cases(session1);
	}
	if (wanted("midstroke")) {
		await test_mid_stroke_ink();
	}
	if (wanted("timing")) {
		await test_playback_timing();
	}
	if (wanted("seekhold")) {
		// (a longer log, so the catch-up after a backward seek takes several frames)
		await test_seek_hold({ base64: fs.readFileSync(path.join(repo_root, "scripts", "fixtures", "typical-v2.p95")).toString("base64") });
	}
	if (wanted("fonts")) {
		await test_no_font_permission(recordings.all_tools);
	}
	if (wanted("lazy")) {
		await test_lazy_libraries();
	}
	if (wanted("patches")) {
		await test_history_patches();
	}
	if (wanted("historycap")) {
		await test_history_cap();
	}
	if (wanted("behavior1")) {
		await test_behavior1_fixtures();
	}
	if (wanted("references")) {
		await test_references();
	}
	if (wanted("format")) {
		await test_format_v1_v2(recordings);
	}
	if (wanted("scrub")) {
		await test_scrub_132730();
	}
	if (wanted("checkpoints")) {
		await test_checkpoint_seeks(recordings);
	}
} finally {
	await browser.close();
	server.close();
}
console.log(failures ? `${failures} FAILURE(S)` : "ALL PASS");
process.exit(failures ? 1 : 0);
