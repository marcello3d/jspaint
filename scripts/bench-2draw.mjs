#!/usr/bin/env node
// Performance benchmark for JSPaint.exe (the 2draw build): player, editor and history restore.
//
//   npm run bench:2draw                     (source tree)
//   npm run bench:2draw -- --dist           (dist-2draw/)
//   options: --throttle=4 (CPU slowdown, default 4: a mid-range phone), --profile (top functions per scenario),
//            --json (machine-readable), --only=player,editor,restore
//
// Uses playwright-core with the installed Google Chrome, like test:2draw-replay.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
	const found = process.argv.find((a) => a.startsWith(`--${name}=`));
	return found ? found.slice(name.length + 3) : (process.argv.includes(`--${name}`) ? true : fallback);
};
const app_root = process.env.P95_APP_ROOT ? path.resolve(process.env.P95_APP_ROOT) : arg("dist", false) ? path.join(repo_root, "dist-2draw") : repo_root;
const throttle = Number(arg("throttle", 4));
const profile = !!arg("profile", false);
const only = arg("only", null);
const want = (name) => !only || String(only).split(",").includes(name);

async function load_playwright() {
	try {
		return await import("playwright-core");
	} catch {
		for (const dir of (process.env.PATH || "").split(path.delimiter)) {
			const candidate = path.join(dir, "..", "playwright-core");
			if (fs.existsSync(path.join(candidate, "package.json"))) {
				return createRequire(path.join(candidate, "package.json"))("./index.js");
			}
		}
		throw new Error("playwright-core not found; run via `npm run bench:2draw`");
	}
}

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".wav": "audio/wav", ".p95": "application/octet-stream", ".map": "application/json" };
const extra_files = new Map();
function serve(root) {
	const server = http.createServer((req, res) => {
		let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
		if (extra_files.has(p)) {
			const { type, body } = extra_files.get(p);
			res.writeHead(200, { "content-type": type });
			res.end(body);
			return;
		}
		if (!p.startsWith("/app/")) {
			res.writeHead(404);
			res.end();
			return;
		}
		p = p.slice("/app".length);
		if (p.endsWith("/")) p += "index.html";
		const file = path.join(root, p);
		fs.readFile(file, (error, data) => {
			if (error) {
				res.writeHead(404);
				res.end();
				return;
			}
			const type = types[path.extname(file).toLowerCase()] || "application/octet-stream";
			// compress text like the CDN does, so load-time numbers are realistic
			if (/text|javascript|json|svg/.test(type) && /gzip/.test(req.headers["accept-encoding"] || "")) {
				res.writeHead(200, { "content-type": type, "content-encoding": "gzip" });
				res.end(zlib.gzipSync(data));
				return;
			}
			res.writeHead(200, { "content-type": type });
			res.end(data);
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const { chromium } = await load_playwright();
const server = await serve(app_root);
const base = `http://127.0.0.1:${server.address().port}/app`;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
const results = {};
const record = (key, value) => {
	results[key] = value;
	if (!arg("json", false)) console.log(`${key.padEnd(52)} ${typeof value === "number" ? value.toFixed(1) : value}`);
};

async function new_page(viewport = { width: 1280, height: 900 }) {
	const page = await browser.newPage({ viewport });
	const cdp = await page.context().newCDPSession(page);
	if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
	page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
	return { page, cdp };
}

/** Runs fn with the CDP profiler and prints the top self-time functions. */
async function profiled(label, cdp, fn) {
	if (!profile) return fn();
	await cdp.send("Profiler.enable");
	await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
	await cdp.send("Profiler.start");
	const out = await fn();
	const { profile: p } = await cdp.send("Profiler.stop");
	const self = new Map();
	const dt = p.timeDeltas || [];
	const by_id = new Map(p.nodes.map((n) => [n.id, n]));
	p.samples.forEach((id, i) => {
		const node = by_id.get(id);
		const f = node.callFrame;
		const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
		self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000);
	});
	const total = [...self.values()].reduce((a, b) => a + b, 0);
	const top = [...self.entries()].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 8);
	console.log(`  profile ${label}: ${total.toFixed(0)} ms sampled`);
	const parent_of = new Map();
	for (const n of p.nodes) for (const c of n.children || []) parent_of.set(c, n);
	const name_of = (n) => `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}`;
	for (const [k, ms] of top) {
		console.log(`    ${ms.toFixed(1).padStart(8)} ms  ${k}`);
		if (arg("callers", false)) {
			// who calls it (two levels up), by time
			const callers = new Map();
			p.samples.forEach((id, i) => {
				const node = by_id.get(id);
				if (name_of(node) !== k) return;
				const p1 = parent_of.get(node.id);
				const p2 = p1 && parent_of.get(p1.id);
				const key = `${p1 ? name_of(p1) : "?"} <- ${p2 ? name_of(p2) : "?"}`;
				callers.set(key, (callers.get(key) || 0) + (dt[i] || 0) / 1000);
			});
			for (const [c, cms] of [...callers].sort((a, b) => b[1] - a[1]).slice(0, 4)) console.log(`               ${cms.toFixed(1).padStart(8)} ms  ${c}`);
		}
	}
	return out;
}

// --- inputs -------------------------------------------------------------------
const logs = {};
logs.typical = fs.readFileSync(path.join(repo_root, "scripts", "fixtures", "typical-v2.p95"));
try {
	const response = await fetch("https://s3.amazonaws.com/zoraw.2draw.net/data/13/132726/132726-v1.p95");
	if (response.ok) logs["132726"] = Buffer.from(await response.arrayBuffer());
} catch { /* offline */ }
for (const [name, bytes] of Object.entries(logs)) extra_files.set(`/app/__bench_${name}.p95`, { type: "application/octet-stream", body: bytes });
extra_files.set("/app/__bench_player.html", { type: "text/html", body: `<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root" style="width:600px;height:450px"></div><script>window.__t0 = performance.now();</script><script src="player.js"></script>` });

// --- player -------------------------------------------------------------------
async function bench_player(name) {
	const { page, cdp } = await new_page();
	await page.goto(`${base}/__bench_player.html`, { waitUntil: "load" });
	const out = await profiled(`player ${name}`, cdp, () => page.evaluate(async (name) => {
		const long_tasks = [];
		new PerformanceObserver((list) => long_tasks.push(...list.getEntries().map((e) => e.duration))).observe({ type: "longtask", buffered: true });
		const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
		const player = new window.Paint95Player({ domRoot: document.getElementById("root"), lsaUrl: `__bench_${name}.p95`, fit: "contain" });
		await player.ready;
		await frame();
		const first_frame = performance.now() - window.__t0;
		// per-frame cost of the player's own work (advance + render), at a given speed, over a few seconds of wall time
		const proto = Object.getPrototypeOf(player);
		const costs = [];
		const wrap = (method) => {
			const original = proto[method];
			proto[method] = function (...args) {
				const t = performance.now();
				const r = original.apply(this, args);
				this.__frame_cost = (this.__frame_cost || 0) + performance.now() - t;
				return r;
			};
		};
		wrap("_advance");
		wrap("_render");
		const run = async (speed, ms) => {
			costs.length = 0;
			let gaps = 0;
			let last = performance.now();
			player.setSpeed(speed);
			player.play();
			const end = performance.now() + ms;
			while (performance.now() < end && player.isPlaying) {
				player.__frame_cost = 0;
				await frame();
				const now = performance.now();
				if (now - last > 34) gaps++;
				last = now;
				costs.push(player.__frame_cost);
			}
			player.pause();
			costs.sort((a, b) => a - b);
			return { avg: costs.reduce((a, b) => a + b, 0) / Math.max(1, costs.length), p95: costs[Math.floor(costs.length * 0.95)] || 0, frames: costs.length, dropped: gaps };
		};
		const at1 = await run(1, 3000);
		player.seek(0);
		while (!player._caught_up || player._restarting) await frame();
		const at8 = await run(8, 3000);
		// seek backwards to the middle (from the end)
		player.seek(player.duration);
		while (!player._caught_up || player._restarting) await frame();
		const t = performance.now();
		player.seek(player.duration / 2);
		while (!player._caught_up || player._restarting) await frame();
		const seek_back = performance.now() - t;
		return {
			first_frame, at1, at8, seek_back,
			long_tasks: long_tasks.filter((d) => d > 50).length,
			heap: performance.memory ? performance.memory.usedJSHeapSize / 1e6 : 0,
		};
	}, name));
	await page.close();
	record(`player ${name}: time to first frame (ms)`, out.first_frame);
	record(`player ${name}: frame cost 1x avg / p95 (ms)`, `${out.at1.avg.toFixed(2)} / ${out.at1.p95.toFixed(2)} (${out.at1.dropped} slow frames of ${out.at1.frames})`);
	record(`player ${name}: frame cost 8x avg / p95 (ms)`, `${out.at8.avg.toFixed(2)} / ${out.at8.p95.toFixed(2)} (${out.at8.dropped} slow frames of ${out.at8.frames})`);
	record(`player ${name}: seek back to the middle (ms)`, out.seek_back);
	record(`player ${name}: long tasks > 50 ms`, out.long_tasks);
	record(`player ${name}: JS heap (MB)`, out.heap);
}

// --- editor -------------------------------------------------------------------
async function bench_editor(width, height) {
	const { page, cdp } = await new_page();
	const t0 = Date.now();
	await page.goto(`${base}/index.html?w=${width}&h=${height}`);
	for (let i = 0; i < 300 && !(await page.evaluate(() => !!(window.P95 && window.P95.recorder)).catch(() => false)); i++) await page.waitForTimeout(20);
	record(`editor ${width}x${height}: startup to interactive (ms)`, Date.now() - t0);
	const scenario = async (label, tool, fn_name, options = {}) => {
		const out = await profiled(`editor ${width}x${height} ${label}`, cdp, () => page.evaluate(async ({ tool, fn_name, width, height, options }) => {
			const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
			document.querySelector(`.tools-component .tool[title="${tool}"]`).click();
			if (options.stroke) {
				window.P95.recorder; // (recording stays on)
			}
			const rect = main_canvas.getBoundingClientRect();
			const sx = rect.width / main_canvas.width;
			const client = (x, y) => ({ clientX: rect.left + (x + 0.5) * sx, clientY: rect.top + (y + 0.5) * sx });
			const ev = (type, x, y, buttons) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons, ...client(x, y) });
			const points = [];
			const n = options.moves || 120;
			for (let i = 0; i <= n; i++) {
				const a = i / n * Math.PI * 2;
				if (fn_name === "circle") points.push([width / 2 + Math.cos(a) * width * 0.35, height / 2 + Math.sin(a) * height * 0.35]);
				else points.push([width * 0.1 + (width * 0.8) * i / n, height * 0.5 + Math.sin(a * 2) * height * 0.3]);
			}
			const handler = [];
			const frames = [];
			let last = performance.now();
			main_canvas.dispatchEvent(ev("pointerdown", points[0][0] | 0, points[0][1] | 0, 1));
			for (const [x, y] of points) {
				const t = performance.now();
				window.dispatchEvent(ev("pointermove", x | 0, y | 0, 1));
				handler.push(performance.now() - t);
				await frame(); // let it paint
				const now = performance.now();
				frames.push(now - last);
				last = now;
			}
			const tu = performance.now();
			window.dispatchEvent(ev("pointerup", points[points.length - 1][0] | 0, points[points.length - 1][1] | 0, 0));
			const up = performance.now() - tu;
			await frame();
			handler.sort((a, b) => a - b);
			frames.sort((a, b) => a - b);
			return {
				move_avg: handler.reduce((a, b) => a + b, 0) / handler.length,
				move_p95: handler[Math.floor(handler.length * 0.95)],
				frame_avg: frames.reduce((a, b) => a + b, 0) / frames.length,
				frame_p95: frames[Math.floor(frames.length * 0.95)],
				up,
			};
		}, { tool, fn_name, width, height, options }));
		record(`editor ${width}x${height}: ${label} move handler avg/p95 (ms)`, `${out.move_avg.toFixed(2)} / ${out.move_p95.toFixed(2)}; frame avg/p95 ${out.frame_avg.toFixed(1)} / ${out.frame_p95.toFixed(1)}; pointerup ${out.up.toFixed(1)}`);
	};
	await scenario("pencil", "Pencil", "wave");
	await scenario("brush", "Brush", "wave");
	await scenario("airbrush", "Airbrush", "wave");
	await scenario("ellipse (large)", "Ellipse", "wave", { moves: 40 });
	await scenario("rounded rectangle (large)", "Rounded Rectangle", "wave", { moves: 40 });
	// fill a big region
	const fill = await page.evaluate(async () => {
		document.querySelector('.tools-component .tool[title="Fill With Color"]').click();
		const rect = main_canvas.getBoundingClientRect();
		const sx = rect.width / main_canvas.width;
		const e = (type, buttons) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons, clientX: rect.left + 3 * sx, clientY: rect.top + 3 * sx });
		const t = performance.now();
		main_canvas.dispatchEvent(e("pointerdown", 1));
		window.dispatchEvent(e("pointerup", 0));
		return performance.now() - t;
	});
	record(`editor ${width}x${height}: fill big region (ms)`, fill);
	// recorder cost per pointer event: same moves with the recorder stopped
	const recorder_cost = await page.evaluate(async () => {
		document.querySelector('.tools-component .tool[title="Pencil"]').click();
		const rect = main_canvas.getBoundingClientRect();
		const ev = (type, i, buttons) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons, clientX: rect.left + 5 + (i % 50), clientY: rect.top + 5 + (i % 30) });
		const time_moves = () => {
			main_canvas.dispatchEvent(ev("pointerdown", 0, 1));
			const t = performance.now();
			for (let i = 0; i < 300; i++) window.dispatchEvent(ev("pointermove", i, 1));
			const ms = performance.now() - t;
			window.dispatchEvent(ev("pointerup", 0, 0));
			return ms / 300;
		};
		const on = time_moves();
		window.P95.recorder.stopped = true;
		const off = time_moves();
		window.P95.recorder.stopped = false;
		return { on, off };
	});
	record(`editor ${width}x${height}: pointermove with/without recorder (ms)`, `${recorder_cost.on.toFixed(3)} / ${recorder_cost.off.toFixed(3)}`);
	await page.close();
}

// --- history: undo/redo, memory per step, steps kept ---------------------------------
async function bench_history(width, height) {
	const { page } = await new_page();
	await page.goto(`${base}/index.html?w=${width}&h=${height}`);
	for (let i = 0; i < 300 && !(await page.evaluate(() => !!(window.P95 && window.P95.recorder)).catch(() => false)); i++) await page.waitForTimeout(20);
	const out = await page.evaluate(async ({ width, height }) => {
		document.querySelector('.tools-component .tool[title="Brush"]').click();
		const rect = main_canvas.getBoundingClientRect();
		const sx = rect.width / main_canvas.width;
		const ev = (type, x, y, buttons) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons, clientX: rect.left + (x + 0.5) * sx, clientY: rect.top + (y + 0.5) * sx });
		const stroke = (i) => {
			const x0 = 20 + (i * 37) % (width - 80);
			const y0 = 20 + (i * 53) % (height - 60);
			main_canvas.dispatchEvent(ev("pointerdown", x0, y0, 1));
			for (let k = 1; k <= 8; k++) window.dispatchEvent(ev("pointermove", x0 + k * 6, y0 + (k % 3) * 5, 1));
			const t = performance.now();
			window.dispatchEvent(ev("pointerup", x0 + 48, y0 + 5, 0));
			return performance.now() - t;
		};
		const ups = [];
		for (let i = 0; i < 30; i++) ups.push(stroke(i));
		const stats = window.P95.history_stats();
		const time = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
		const undo_times = [];
		const redo_times = [];
		for (let i = 0; i < 10; i++) undo_times.push(time(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }))));
		for (let i = 0; i < 10; i++) redo_times.push(time(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true }))));
		// steps kept: keep drawing until the history stops growing
		let max_steps = 0;
		for (let i = 30; i < 1500; i++) {
			stroke(i);
			const steps = window.P95.history_stats().steps;
			max_steps = Math.max(max_steps, steps);
			if (i > 400 && steps < max_steps) break;
		}
		const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
		return {
			up: avg(ups), undo: avg(undo_times), redo: avg(redo_times),
			bytes_per_step: stats.bytes / stats.steps, max_steps,
			heap: performance.memory ? performance.memory.usedJSHeapSize / 1e6 : 0,
		};
	}, { width, height });
	await page.close();
	record(`history ${width}x${height}: brush stroke pointerup (ms)`, out.up);
	record(`history ${width}x${height}: undo / redo (ms)`, `${out.undo.toFixed(2)} / ${out.redo.toFixed(2)}`);
	record(`history ${width}x${height}: memory per step (KB)`, out.bytes_per_step / 1024);
	record(`history ${width}x${height}: steps kept (max)`, out.max_steps);
	record(`history ${width}x${height}: JS heap after (MB)`, out.heap);
}

// --- load time under a slow network ----------------------------------------------------
async function bench_load() {
	const conditions = { offline: false, latency: 150, downloadThroughput: 1.5e6 / 8, uploadThroughput: 0.75e6 / 8 };
	{
		const { page, cdp } = await new_page();
		await cdp.send("Network.enable");
		await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
		await cdp.send("Network.emulateNetworkConditions", conditions);
		let requests = 0;
		let bytes = 0;
		page.on("requestfinished", async (r) => { requests++; try { bytes += (await r.sizes()).responseBodySize; } catch { /* */ } });
		const t0 = Date.now();
		await page.goto(`${base}/index.html?w=600&h=450`);
		for (let i = 0; i < 3000 && !(await page.evaluate(() => !!(window.P95 && window.P95.recorder)).catch(() => false)); i++) await page.waitForTimeout(20);
		record("load (150 ms RTT, 1.5 Mbps): editor to interactive (ms)", Date.now() - t0);
		record("load: editor requests / KB transferred", `${requests} / ${(bytes / 1024).toFixed(0)}`);
		await page.close();
	}
	{
		const { page, cdp } = await new_page();
		await cdp.send("Network.enable");
		await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
		await cdp.send("Network.emulateNetworkConditions", conditions);
		await page.goto(`${base}/__bench_player.html`, { waitUntil: "load" });
		const ms = await page.evaluate(async () => {
			const name = Object.keys({ typical: 1 })[0];
			const player = new window.Paint95Player({ domRoot: document.getElementById("root"), lsaUrl: `__bench_${name}.p95`, fit: "contain" });
			await player.ready;
			await new Promise((resolve) => requestAnimationFrame(resolve));
			return performance.now() - window.__t0;
		});
		record("load (150 ms RTT, 1.5 Mbps): player first frame (ms)", ms);
		await page.close();
	}
}

// --- history restore ----------------------------------------------------------
async function bench_restore(name, bytes, width, height, reps = 1) {
	const { page } = await new_page();
	// make the posted picture (the replay's final canvas) and, for reps > 1, a longer log
	await page.goto(`${base}/index.html?replay=1`);
	const made = await page.evaluate(async ({ b64, reps }) => {
		const format = await import("./src/paint95-format.js");
		const file = format.decode_p95(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
		if (reps > 1) {
			for (const segment of file.header.segments) {
				const one = segment.events.filter((e) => e[0] !== "h" && e[0] !== "p");
				let events = [];
				for (let i = 0; i < reps; i++) events = events.concat(one.map((e) => e.slice()));
				segment.events = events;
			}
		}
		const bytes = format.encode_p95(file);
		const c = window.paint95Replay;
		c.load(bytes);
		await c.prepare();
		c.advance_to(Infinity);
		let b = "";
		for (let i = 0; i < bytes.length; i += 0x8000) b += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		const canvas = c.get_document_canvas();
		return { p95: btoa(b), png: canvas.toDataURL("image/png").split(",")[1], events: file.header.segments.reduce((n, s) => n + s.events.length, 0), w: canvas.width, h: canvas.height };
	}, { b64: bytes.toString("base64"), reps });
	await page.close();
	extra_files.set(`/app/__bench_r.p95`, { type: "application/octet-stream", body: Buffer.from(made.p95, "base64") });
	extra_files.set(`/app/__bench_r.png`, { type: "image/png", body: Buffer.from(made.png, "base64") });
	const { page: editor, cdp } = await new_page();
	const log = [];
	editor.on("console", (m) => { if (/Restored the undo history/.test(m.text())) log.push(m.text()); });
	await profiled(`restore ${name}`, cdp, async () => {
		await editor.goto(`${base}/index.html?w=${made.w}&h=${made.h}&load=${encodeURIComponent(`${base}/__bench_r.png`)}&anim=${encodeURIComponent(`${base}/__bench_r.p95`)}`);
		for (let i = 0; i < 6000 && !log.length; i++) await editor.waitForTimeout(100);
	});
	await editor.close();
	const ms = Number((log[0] || "").match(/in (\d+) ms/)?.[1] ?? NaN);
	record(`restore ${name} (${made.events} events): (ms)`, ms);
}

console.log(`JSPaint.exe benchmark — ${path.relative(repo_root, app_root) || "source"}, CPU throttle ${throttle}x`);
try {
	if (want("player")) {
		for (const name of Object.keys(logs)) await bench_player(name);
	}
	if (want("editor")) {
		await bench_editor(600, 450);
		await bench_editor(1200, 900);
	}
	if (want("history")) {
		await bench_history(600, 450);
		await bench_history(1200, 900);
	}
	if (want("load")) {
		await bench_load();
	}
	if (want("restore")) {
		for (const [name, bytes] of Object.entries(logs)) await bench_restore(name, bytes);
		if (logs["132726"]) await bench_restore("132726 ×10", logs["132726"], 600, 450, 10);
	}
} finally {
	await browser.close();
	server.close();
}
if (arg("json", false)) console.log(JSON.stringify(results, null, 2));
