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
const app_root = use_dist ? path.join(repo_root, "dist-2draw") : repo_root;
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
async function record_session(page, { width, height, script }) {
	await page.goto(`${base}/index.html?w=${width}&h=${height}${process.argv.includes("--debug") ? "&p95debug=1" : ""}`, { waitUntil: "networkidle" });
	await page.waitForFunction(() => window.P95 && window.P95.recorder);
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
async function replay_session(page, recording, { seek_back = false } = {}) {
	await page.route(`${base}/__test_host.html`, (route) => route.fulfill({
		contentType: "text/html",
		body: `<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root" style="width:400px;height:300px"></div><script src="player.js"></script>`,
	}));
	await page.goto(`${base}/__test_host.html`, { waitUntil: "load" });
	return page.evaluate(async ({ base64, seek_back }) => {
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		const url = URL.createObjectURL(new Blob([bytes]));
		const drifts = [];
		let ended = false;
		const player = new window.Paint95Player({
			domRoot: document.getElementById("root"),
			lsaUrl: url,
			controls: true,
			fit: "contain",
			onDrift: (drift) => drifts.push(drift),
			onEnd: () => { ended = true; },
		});
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
	}, { base64: recording.base64, seek_back });
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
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);

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
		await frame.waitForFunction(() => window.P95 && window.P95.recorder);
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
	files.p95 = Buffer.from(first.p95);

	// session 2, continuing: the undo history of session 1 is restored; undo past the session boundary, then draw
	const restore_log = [];
	page.on("console", (message) => { if (/Restored the undo history|Couldn't restore/.test(message.text())) restore_log.push(message.text()); });
	await page.goto(`${base}/__host2`);
	frame = await frame_of();
	await frame.waitForFunction(() => window.P95 && window.P95.recorder);
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

	const player_page = await browser.newPage({ viewport: { width: 800, height: 600 } });
	watch(player_page, "continue/player");
	const replay = await replay_session(player_page, { base64: p95.toString("base64") });
	await player_page.close();
	compare("continue", { width: 200, height: 150, pixels: editor_pixels }, replay);
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

try {
	for (const [name, script] of Object.entries(sessions)) {
		if (only && !name.includes(only)) continue;
		const editor = await browser.newPage({ viewport: { width: 1024, height: 700 } });
		watch(editor, `${name}/editor`);
		const recording = await record_session(editor, { width: 320, height: 240, script });
		await editor.close();
		console.log(`${name}: ${recording.events} events, ${recording.size} bytes, event counts ${JSON.stringify(recording.counts)}`);
		check(!recording.truncated, `${name}: recording not truncated`);
		const player_page = await browser.newPage({ viewport: { width: 800, height: 600 } });
		watch(player_page, `${name}/player`);
		const replay = await replay_session(player_page, recording, { seek_back: name === "all_tools" });
		await player_page.close();
		compare(name, recording, replay);
		if (name === "all_tools" || name === "typical") {
			await measure_restore(name, recording, 320, 240);
		}
		if (process.env.P95_SAVE) {
			fs.writeFileSync(path.join(process.env.P95_SAVE, `${name}.p95`), Buffer.from(recording.base64, "base64"));
		}
	}
	if (!only || "continue".includes(only)) {
		await test_host_submit_and_continue();
	}
	if (!only || "midstroke".includes(only)) {
		await test_mid_stroke_ink();
	}
} finally {
	await browser.close();
	server.close();
}
console.log(failures ? `${failures} FAILURE(S)` : "ALL PASS");
process.exit(failures ? 1 : 0);
