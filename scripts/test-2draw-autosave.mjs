#!/usr/bin/env node
// Device autosave test for JSPaint.exe (src/paint95-draft.js).
//
//   npm run test:2draw-autosave            (tests the source tree)
//   npm run test:2draw-autosave -- --dist  (tests dist-2draw/, run npm run build:2draw first)
//
// In a same-origin host page like 2draw's draw page (index.html?draft=<key> in an iframe, window.paint95Host):
// draws, waits for the save, reloads, opens the draft in a fresh tab, checks the picture and undo history come back
// and the recording carries on; submits and checks the device copy is gone and the .p95 replays in player.js to the
// submitted picture. Also: a revision (load= + anim=) draft, a size mismatch, a drifting replay (snapshot fallback),
// expiry, and save time and size on a long drawing. And: the leave question (drawGuard, drawPersists, drawUnchanged),
// a save mid-stroke when the page is hidden, a failing store ("Not saved", retried), and one editor per draft (two
// tabs: the newer takes over, the older says so and can take it back). And iOS (WebKit's back/forward cache): drawing
// without a pause still saves, and a page going into that cache starts no transaction until it is shown again.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const use_dist = process.argv.includes("--dist");
const app_root = use_dist ? path.join(repo_root, "dist-2draw") : repo_root;

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
		throw new Error("playwright-core not found; run via `npm run test:2draw-autosave`");
	}
}

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".wav": "audio/wav", ".json": "application/json", ".cur": "image/x-icon" };
/** Extra routes: path -> { type, body } */
const extra = new Map();
function serve(root) {
	const server = http.createServer((req, res) => {
		let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
		if (extra.has(p)) {
			const { type, body } = extra.get(p);
			res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
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

const { chromium } = await load_playwright();
const server = await serve(app_root);
const base = `http://127.0.0.1:${server.address().port}/app`;
const browser = await chromium.launch({
	channel: process.env.PLAYWRIGHT_CHANNEL === "chromium" ? undefined : (process.env.PLAYWRIGHT_CHANNEL || "chrome"),
	headless: true,
});
// one context: IndexedDB persists across its pages, like one browser profile
const context = await browser.newContext({ viewport: { width: 1024, height: 700 } });

let failures = 0;
const check = (condition, message) => {
	console.log(`${condition ? "PASS" : "FAIL"} ${message}`);
	if (!condition) failures++;
};

function watch(page, label) {
	page.on("pageerror", (error) => { console.log(`[${label}] PAGEERROR ${error.message}`); failures++; });
	page.on("console", (message) => {
		const text = message.text();
		if (message.type() === "error" || /\[autosave\]|Restored the undo history|\[replay\] drift/.test(text)) {
			console.log(`[${label}] ${message.type()}: ${text.slice(0, 300)}`);
		}
	});
}

async function wait_until(frame, fn, arg, timeout = 60000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await frame.evaluate(fn, arg).catch(() => false)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`wait_until: timed out: ${fn}`);
}

/** The host page: like 2draw's draw page (lib/applet.ts paint95EmbedHtml, client/applet-boot.ts) */
function host_html(query) {
	return `<!doctype html><meta charset="utf-8"><body style="margin:0">
	<script>
		window.submissions = [];
		window.saves = [];
		window.fails = 0;
		window.guards = [];
		window.drawGuard = (on) => { window.guards.push(on); };
		window.paint95Host = {
			async submit(png, extra) {
				const read = (blob) => blob.arrayBuffer().then((b) => Array.from(new Uint8Array(b)));
				const entry = { png: await read(png), p95: extra && extra.animation ? await read(extra.animation) : null };
				// like applet-boot.ts upload(): the server accepted it; let the editor delete its copy, then leave
				if (extra && extra.uploaded) await extra.uploaded();
				window.submissions.push(entry);
			},
			draftSaved(info) { if (info.failed) window.fails++; else window.saves.push(info.at); },
		};
	</script>
	<iframe src="/app/index.html?${query}" style="border:0;width:1000px;height:680px"></iframe>`;
}
let host_count = 0;
function host_url(query) {
	const p = `/__host${++host_count}.html`;
	extra.set(p, { type: "text/html", body: host_html(query) });
	return `http://127.0.0.1:${server.address().port}${p}`;
}

async function open_editor(page, url) {
	await page.goto(url);
	const frame = await (await page.waitForSelector("iframe")).contentFrame();
	await wait_until(frame, () => !!(window.P95 && window.P95.recorder && window.paint95_autosaver));
	return frame;
}

async function draw(page, frame, tool, points, width) {
	await frame.click(`.tools-component .tool[title="${tool}"]`);
	const box = await (await frame.$(".main-canvas")).boundingBox();
	const scale = box.width / width;
	await page.mouse.move(box.x + points[0][0] * scale, box.y + points[0][1] * scale);
	await page.mouse.down();
	for (const [x, y] of points.slice(1)) {
		await page.mouse.move(box.x + x * scale, box.y + y * scale, { steps: 5 });
	}
	await page.mouse.up();
}

const editor_state = (frame) => frame.evaluate(() => {
	const d = main_ctx.getImageData(0, 0, main_canvas.width, main_canvas.height).data;
	let h = 0;
	for (let i = 0; i < d.length; i++) h = (Math.imul(h, 31) + d[i]) | 0;
	return { hash: h, undos: undos.length, redos: redos.length, width: main_canvas.width, height: main_canvas.height, start: window.P95.recorder.segment.start, segments: window.P95.recorder.previous_segments.length };
});

/** Waits for the next save announced to the host page */
async function wait_saved(page, after) {
	await wait_until(page, (n) => window.saves.length > n, after, 15000);
	return page.evaluate(() => window.saves.length);
}

const draft_record = (frame, key) => frame.evaluate((key) => new Promise((resolve, reject) => {
	const request = indexedDB.open("2draw-paint95-drafts");
	request.onsuccess = () => {
		const db = request.result;
		const tx = db.transaction(["drafts", "parts"], "readonly");
		const get = tx.objectStore("drafts").get(key);
		const parts = tx.objectStore("parts").getAllKeys(IDBKeyRange.bound([key, ""], [key, "￿"]));
		tx.oncomplete = () => { resolve(get.result ? { saved: get.result.saved, events: get.result.events, segments: get.result.segments.length, parts: parts.result.length } : { none: true, parts: parts.result.length }); db.close(); };
		tx.onerror = () => reject(tx.error);
	};
	request.onerror = () => reject(request.error);
}), key);

async function submit(page, frame) {
	const before = await page.evaluate(() => window.submissions.length);
	await frame.click(".paint95-submit-button");
	await wait_until(page, (n) => window.submissions.length > n, before);
	return page.evaluate(() => window.submissions[window.submissions.length - 1]);
}

async function replay(p95_bytes) {
	const page = await context.newPage({ viewport: { width: 800, height: 600 } });
	watch(page, "player");
	extra.set("/app/__player.html", { type: "text/html", body: `<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root" style="width:400px;height:300px"></div><script src="player.js"></script>` });
	await page.goto(`${base}/__player.html`);
	const result = await page.evaluate(async (bytes) => {
		const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
		const drifts = [];
		let ended = false;
		const player = new window.Paint95Player({ domRoot: document.getElementById("root"), lsaUrl: url, controls: false, fit: "contain", onDrift: (d) => drifts.push(d), onEnd: () => { ended = true; } });
		await player.ready;
		player.setSpeed(64);
		player.play();
		for (let i = 0; i < 20000 && !ended; i++) await new Promise((r) => requestAnimationFrame(r));
		const canvas = player._controller.get_document_canvas();
		const d = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
		let h = 0;
		for (let i = 0; i < d.length; i++) h = (Math.imul(h, 31) + d[i]) | 0;
		return { ended, drifts, hash: h };
	}, p95_bytes);
	await page.close();
	return result;
}

try {
	// ---- 1. a new drawing: save, reload, back/forward, fresh tab, submit ----------------------------------------------
	{
		const key = "autosavetest1";
		const W = 200, H = 150;
		const url = host_url(`w=${W}&h=${H}&draft=${key}`);
		let page = await context.newPage();
		watch(page, "new");
		let frame = await open_editor(page, url);
		await draw(page, frame, "Brush", [[20, 20], [120, 60], [60, 120]], W);
		await draw(page, frame, "Airbrush", [[150, 20], [180, 120]], W);
		const two_strokes = await editor_state(frame);
		await draw(page, frame, "Line", [[10, 140], [190, 100]], W);
		await draw(page, frame, "Ellipse", [[100, 10], [190, 80]], W);
		const t0 = Date.now();
		let saves = await wait_saved(page, 0);
		const waited = Date.now() - t0;
		check(waited < 5000, `new: saved soon after drawing (${waited} ms)`);
		const before = await editor_state(frame);
		const record = await draft_record(frame, key);
		check(!record.none && record.events > 10, `new: the device copy is in IndexedDB (${JSON.stringify(record)})`);
		const stats = await frame.evaluate(() => window.paint95_autosaver.last_stats);
		console.log(`new: save stats ${JSON.stringify(stats)}`);

		// reload
		await page.reload();
		frame = await (await page.waitForSelector("iframe")).contentFrame();
		await wait_until(frame, () => !!(window.P95 && window.P95.recorder && window.paint95_autosaver));
		let after = await editor_state(frame);
		check(after.hash === before.hash, "reload: the picture is restored");
		check(after.undos === before.undos && after.undos >= 4, `reload: the undo history is back (${after.undos} vs ${before.undos} steps)`);
		check(after.start.type === "continue" && after.start.history && !after.start.snap, `reload: the recording continues the saved one (${JSON.stringify(after.start)})`);
		check(await page.evaluate(() => window.saves.length >= 1), "reload: the page is told about the saved copy right away");
		// undo works: two undos give the two-stroke picture
		await frame.evaluate(() => window.focus());
		await page.keyboard.press("Control+z");
		await page.keyboard.press("Control+z");
		const undone = await editor_state(frame);
		check(undone.hash === two_strokes.hash, "reload: undoing twice gives the picture after the first two strokes");
		await page.keyboard.press("Control+y");
		await page.keyboard.press("Control+y");
		check((await editor_state(frame)).hash === before.hash, "reload: redo brings the last two strokes back");

		// draw, save, then navigate away and back (and forward)
		await draw(page, frame, "Pencil", [[30, 30], [170, 30], [170, 130]], W);
		saves = await wait_saved(page, await page.evaluate(() => window.saves.length));
		const before_nav = await editor_state(frame);
		await page.goto("about:blank");
		await page.goBack();
		frame = await (await page.waitForSelector("iframe")).contentFrame();
		await wait_until(frame, () => !!(window.P95 && window.P95.recorder && window.paint95_autosaver));
		after = await editor_state(frame);
		check(after.hash === before_nav.hash && after.undos === before_nav.undos, `back: restored after leaving and coming back (${after.undos} steps)`);
		await page.goForward();
		await page.goBack();
		frame = await (await page.waitForSelector("iframe")).contentFrame();
		await wait_until(frame, () => !!(window.P95 && window.P95.recorder && window.paint95_autosaver));
		after = await editor_state(frame);
		check(after.hash === before_nav.hash && after.undos === before_nav.undos, "forward/back: restored again");

		// a stroke, then hide the page (no 1.5 s wait): saved right away
		await draw(page, frame, "Rectangle", [[40, 40], [90, 90]], W);
		const n = await page.evaluate(() => window.saves.length);
		await frame.evaluate(() => {
			Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await wait_until(page, (n) => window.saves.length > n, n, 1000);
		check(true, "hidden: saved right away when the page is hidden");
		const before_close = await editor_state(frame);
		await page.close();

		// a fresh tab
		page = await context.newPage();
		watch(page, "new/fresh");
		frame = await open_editor(page, url);
		after = await editor_state(frame);
		check(after.hash === before_close.hash && after.undos === before_close.undos, `fresh tab: restored (${after.undos} steps, ${after.segments} earlier sessions)`);

		// submit: the copy goes, and the .p95 replays to the submitted picture
		await draw(page, frame, "Brush", [[20, 130], [180, 20]], W);
		const final = await editor_state(frame);
		const submitted = await submit(page, frame);
		const gone = await draft_record(frame, key);
		check(gone.none && gone.parts === 0, `submit: the device copy is deleted (${JSON.stringify(gone)})`);
		check(!!submitted.p95, `submit: a recording was submitted (${submitted.p95 && submitted.p95.length} bytes)`);
		const played = await replay(submitted.p95);
		check(played.ended && played.drifts.length === 0, `submit: the .p95 plays to the end without drift (${JSON.stringify(played.drifts).slice(0, 200)})`);
		check(played.hash === final.hash, "submit: the replayed picture is exactly the submitted one");
		await page.close();

		// submitted: a reopened editor starts blank
		page = await context.newPage();
		frame = await open_editor(page, url);
		after = await editor_state(frame);
		check(after.undos === 0 && after.start.type === "blank", "after submit: reopening starts a new drawing");
		await page.close();
		globalThis.first_submission = submitted;
	}

	// ---- 2. a revision: the device copy beats the previous version's files ------------------------------------------------
	{
		const key = "autosavetest2";
		const W = 200, H = 150;
		extra.set("/__prev.png", { type: "image/png", body: Buffer.from(globalThis.first_submission.png) });
		extra.set("/__prev.p95", { type: "application/octet-stream", body: Buffer.from(globalThis.first_submission.p95) });
		const origin = `http://127.0.0.1:${server.address().port}`;
		const url = host_url(`w=${W}&h=${H}&load=${encodeURIComponent(`${origin}/__prev.png`)}&anim=${encodeURIComponent(`${origin}/__prev.p95`)}&draft=${key}`);
		let page = await context.newPage();
		watch(page, "revise");
		let frame = await open_editor(page, url);
		const opened = await editor_state(frame);
		check(opened.start.history && opened.undos > 3, `revise: the previous version's history is restored (${opened.undos} steps)`);
		await draw(page, frame, "Line", [[0, 0], [200, 150]], W);
		await wait_saved(page, 0);
		const before = await editor_state(frame);
		await page.reload();
		frame = await (await page.waitForSelector("iframe")).contentFrame();
		await wait_until(frame, () => !!(window.P95 && window.P95.recorder && window.paint95_autosaver));
		const after = await editor_state(frame);
		check(after.hash === before.hash && after.undos === before.undos, `revise: reload restores the device copy, not the previous version (${after.undos} vs ${opened.undos} steps)`);
		await draw(page, frame, "Pencil", [[100, 20], [20, 100]], W);
		const final = await editor_state(frame);
		const submitted = await submit(page, frame);
		const played = await replay(submitted.p95);
		check(played.ended && played.drifts.length === 0 && played.hash === final.hash, `revise: the submitted .p95 replays exactly (${JSON.stringify(played.drifts).slice(0, 200)})`);
		check((await draft_record(frame, key)).none, "revise: the device copy is deleted after submitting");
		await page.close();
	}

	// ---- 3. a drifting replay: the snapshot is set, and the result still replays ------------------------------------------
	{
		const key = "autosavetest3";
		const W = 200, H = 150;
		const url = host_url(`w=${W}&h=${H}&draft=${key}`);
		let page = await context.newPage();
		watch(page, "drift");
		let frame = await open_editor(page, url);
		await draw(page, frame, "Airbrush", [[20, 20], [180, 130]], W);
		await wait_saved(page, 0);
		// the snapshot is written after the recording
		await wait_until(frame, () => !!window.paint95_autosaver.snapshot);
		const before = await editor_state(frame);
		// change the airbrush seed in the stored copy: its replay sprays differently
		await frame.evaluate((key) => new Promise((resolve, reject) => {
			const request = indexedDB.open("2draw-paint95-drafts");
			request.onsuccess = () => {
				const tx = request.result.transaction("drafts", "readwrite");
				const store = tx.objectStore("drafts");
				const get = store.get(key);
				get.onsuccess = () => { const meta = get.result; meta.segments[meta.segments.length - 1].info.seed ^= 0x5a5a5a5a; store.put(meta); };
				tx.oncomplete = () => { request.result.close(); resolve(); };
				tx.onerror = () => reject(tx.error);
			};
		}), key);
		await page.reload();
		frame = await (await page.waitForSelector("iframe")).contentFrame();
		await wait_until(frame, () => !!(window.P95 && window.P95.recorder && window.paint95_autosaver));
		const after = await editor_state(frame);
		check(after.hash === before.hash && after.start.snap === true, `drift: the saved snapshot is set after a drifting replay (${JSON.stringify(after.start)})`);
		await draw(page, frame, "Line", [[10, 140], [190, 10]], W);
		const final = await editor_state(frame);
		const submitted = await submit(page, frame);
		const played = await replay(submitted.p95);
		check(played.ended && played.hash === final.hash, `drift: the submitted .p95 still replays to the submitted picture (drifts: ${played.drifts.map((d) => d.type)})`);
		await page.close();
	}

	// ---- 4. size mismatch: asks; Start over sets the copy aside -----------------------------------------------------------
	{
		const key = "autosavetest4";
		let page = await context.newPage();
		watch(page, "size");
		let frame = await open_editor(page, host_url(`w=200&h=150&draft=${key}`));
		await draw(page, frame, "Brush", [[20, 20], [120, 60]], 200);
		await wait_saved(page, 0);
		await page.goto(host_url(`w=240&h=150&draft=${key}`));
		frame = await (await page.waitForSelector("iframe")).contentFrame();
		await wait_until(frame, () => !!document.querySelector(".window .window-content button"), undefined, 15000);
		const message = await frame.evaluate(() => [...document.querySelectorAll(".window")].map((w) => w.textContent).find((t) => /saved on this device/.test(t)) || "");
		check(/200×150/.test(message) && /240×150/.test(message), `size: asks when the saved size differs (${message.replace(/\s+/g, " ").slice(0, 120)})`);
		await frame.click(".window button:has-text('Restore')");
		await wait_until(frame, () => !!(window.P95 && window.P95.recorder && window.paint95_autosaver));
		const restored = await editor_state(frame);
		check(restored.undos >= 1 && restored.start.type === "continue", "size: Restore restores it");
		await page.goto(host_url(`w=200&h=160&draft=${key}`));
		frame = await (await page.waitForSelector("iframe")).contentFrame();
		await wait_until(frame, () => !!document.querySelector(".window .window-content button"), undefined, 15000);
		await frame.click(".window button:has-text('Start over')");
		await wait_until(frame, () => !!(window.P95 && window.P95.recorder && window.paint95_autosaver));
		const fresh = await editor_state(frame);
		const aside = await frame.evaluate(() => new Promise((resolve) => {
			const request = indexedDB.open("2draw-paint95-drafts");
			request.onsuccess = () => { const get = request.result.transaction("drafts").objectStore("drafts").getAllKeys(); get.onsuccess = () => resolve(get.result); };
		}));
		check(fresh.undos === 0 && fresh.start.type === "blank" && aside.some((k) => k.startsWith(`${key}~unreadable`)) && !aside.includes(key), `size: Start over starts blank and keeps the copy aside (${aside})`);
		await page.close();
	}

	// ---- 5. expiry ---------------------------------------------------------------------------------------------------
	{
		const page = await context.newPage();
		watch(page, "expire");
		let frame = await open_editor(page, host_url("w=100&h=100&draft=autosaveold"));
		await frame.evaluate(() => new Promise((resolve) => {
			const request = indexedDB.open("2draw-paint95-drafts");
			request.onsuccess = () => {
				const tx = request.result.transaction(["drafts", "parts"], "readwrite");
				const day = 24 * 60 * 60 * 1000;
				tx.objectStore("drafts").put({ key: "old31days", v: 1, saved: Date.now() - 31 * day, segments: [], blobs: [] });
				tx.objectStore("parts").put({ key: "old31days", name: "x:c0", data: new Uint8Array(10) });
				tx.objectStore("drafts").put({ key: "recent29days", v: 1, saved: Date.now() - 29 * day, segments: [], blobs: [] });
				tx.objectStore("drafts").put({ key: "aside~unreadable-1", v: 1, saved: Date.now() - 31 * day, aside_at: Date.now() - day, set_aside: true, segments: [], blobs: [] });
				tx.oncomplete = () => { request.result.close(); resolve(); };
			};
		}));
		await page.reload();
		frame = await (await page.waitForSelector("iframe")).contentFrame();
		await wait_until(frame, () => !!(window.P95 && window.P95.recorder && window.paint95_autosaver));
		// (old copies go after the drawing's own copy is read, not before)
		for (let i = 0; i < 40 && !(await draft_record(frame, "old31days")).none; i++) await new Promise((r) => setTimeout(r, 50));
		const old = await draft_record(frame, "old31days");
		const recent = await draft_record(frame, "recent29days");
		const aside = await draft_record(frame, "aside~unreadable-1");
		check(old.none && old.parts === 0 && !recent.none, "expire: copies older than 30 days are deleted when the editor loads, newer ones kept");
		check(!aside.none, "expire: a copy set aside a day ago is kept, though last saved 31 days ago");
		await page.close();
	}

	// ---- 6. no draft key: nothing new happens --------------------------------------------------------------------------
	{
		const page = await context.newPage();
		watch(page, "nokey");
		await page.goto(host_url("w=100&h=100"));
		const frame = await (await page.waitForSelector("iframe")).contentFrame();
		await wait_until(frame, () => !!(window.P95 && window.P95.recorder));
		check(await frame.evaluate(() => !window.paint95_autosaver), "no key: no autosave");
		await page.close();
	}

	// ---- 8. the leave question, mid-stroke saves, a failing store -------------------------------------------------------
	{
		const W = 200, H = 150;
		const key = "autosavetest8";
		const url = host_url(`w=${W}&h=${H}&draft=${key}`);
		let page = await context.newPage();
		watch(page, "leave");
		let frame = await open_editor(page, url);
		const leave = () => page.evaluate(() => ({ persists: window.drawPersists, unchanged: window.drawUnchanged, guard: window.guards[window.guards.length - 1], flush: typeof window.drawFlush }));
		let state = await leave();
		check(state.persists === false && state.unchanged === true && state.guard === false && state.flush === "function", `leave: nothing drawn: no question (${JSON.stringify(state)})`);
		await draw(page, frame, "Pencil", [[20, 20], [60, 40], [100, 30]], W);
		state = await leave();
		check(state.guard === true && state.unchanged === false, `leave: a change not saved yet asks (${JSON.stringify(state)})`);
		await wait_saved(page, 0);
		await wait_until(page, () => window.drawPersists === true && window.guards[window.guards.length - 1] === false, null, 3000);
		check(true, "leave: saved: persists, and the warning is off");

		// mid-stroke: press, move, hide the page without letting go
		const box = await (await frame.$(".main-canvas")).boundingBox();
		const scale = box.width / W;
		await frame.click(`.tools-component .tool[title="Pencil"]`);
		await page.mouse.move(box.x + 30 * scale, box.y + 100 * scale);
		await page.mouse.down();
		await page.mouse.move(box.x + 150 * scale, box.y + 120 * scale, { steps: 8 });
		check((await leave()).guard === true, "leave: a stroke under way asks");
		let n = await page.evaluate(() => window.saves.length);
		await frame.evaluate(() => {
			Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await wait_saved(page, n);
		const open_stats = await frame.evaluate(() => window.paint95_autosaver.last_stats);
		check(open_stats.open_stroke === true, `hidden mid-stroke: saved up to the stroke under way (${JSON.stringify(open_stats)})`);
		// what the picture is with that stroke ended there (no more saves from this page)
		await frame.evaluate(() => { window.paint95_autosaver.disabled = true; });
		await page.mouse.up();
		const expected = await editor_state(frame);
		await page.close();
		page = await context.newPage();
		watch(page, "leave/mid-stroke");
		frame = await open_editor(page, url);
		let after = await editor_state(frame);
		check(after.hash === expected.hash && after.undos === expected.undos, `hidden mid-stroke: a fresh tab restores the stroke as far as it went (${after.undos} vs ${expected.undos} steps)`);
		state = await leave();
		check(state.persists === true && state.guard === false, `leave: a restored copy persists (${JSON.stringify(state)})`);

		// a failing store: "Not saved", the warning stays on; it works again once the store does
		await frame.evaluate(() => {
			window.__put = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = function () { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); };
		});
		n = await page.evaluate(() => window.saves.length);
		await draw(page, frame, "Pencil", [[20, 130], [180, 130]], W);
		await wait_until(page, () => window.fails > 0, null, 5000);
		state = await leave();
		check(state.persists === false && state.guard === true, `failing store: the host hears "not saved", and the leave warning stays on (${JSON.stringify(state)})`);
		await new Promise((r) => setTimeout(r, 2500));
		check((await page.evaluate(() => window.saves.length)) === n, "failing store: no \"saved\" while it fails");
		await frame.evaluate(() => { IDBObjectStore.prototype.put = window.__put; });
		await wait_saved(page, n);
		await wait_until(page, () => window.drawPersists === true && window.guards[window.guards.length - 1] === false, null, 3000);
		const expected2 = await editor_state(frame);
		await page.close();
		page = await context.newPage();
		watch(page, "leave/after-failure");
		frame = await open_editor(page, url);
		after = await editor_state(frame);
		check(after.hash === expected2.hash && after.undos === expected2.undos, `failing store: the retried save holds everything (${after.undos} vs ${expected2.undos} steps)`);
		await frame.evaluate(() => window.paint95_autosaver.delete());
		await page.close();
	}

	// ---- 9. one editor per draft: two tabs ----------------------------------------------------------------------------
	{
		const W = 200, H = 150;
		const key = "autosavetest9";
		const url = host_url(`w=${W}&h=${H}&draft=${key}`);
		const a = await context.newPage();
		watch(a, "tabs/A");
		let fa = await open_editor(a, url);
		await draw(a, fa, "Pencil", [[20, 20], [100, 60]], W);
		await wait_saved(a, 0);
		// a stroke not saved yet (no wait for its save), then the second tab
		await draw(a, fa, "Pencil", [[20, 100], [150, 100]], W);
		const a_state = await editor_state(fa);
		const b = await context.newPage();
		watch(b, "tabs/B");
		const t0 = Date.now();
		const fb = await open_editor(b, url);
		const b_state = await editor_state(fb);
		check(b_state.hash === a_state.hash && b_state.undos === a_state.undos, `tabs: the new tab starts from everything the old one drew (${b_state.undos} vs ${a_state.undos} steps, ${Date.now() - t0} ms)`);
		await wait_until(fa, () => !!document.getElementById("paint95-taken") && window.paint95_autosaver.yielded, null, 5000);
		check(await a.evaluate(() => window.drawPersists === true && window.guards[window.guards.length - 1] === false), "tabs: the old tab is covered, stops saving, and asks nothing on leaving");
		// the old tab can't draw under its cover
		const undos_before = await fa.evaluate(() => undos.length);
		const box = await (await fa.$(".main-canvas")).boundingBox();
		await a.mouse.click(box.x + 10, box.y + 10);
		check((await fa.evaluate(() => undos.length)) === undos_before, "tabs: the cover blocks drawing");
		// the new tab draws; Continue here in the old one takes it back, with that stroke
		await draw(b, fb, "Pencil", [[20, 140], [180, 10]], W);
		const b_state2 = await editor_state(fb);
		await fa.click("#paint95-taken button");
		await a.waitForLoadState("load");
		fa = await (await a.waitForSelector("iframe")).contentFrame();
		await wait_until(fa, () => !!(window.P95 && window.P95.recorder && window.paint95_autosaver), null, 15000);
		const a_state2 = await editor_state(fa);
		check(a_state2.hash === b_state2.hash && a_state2.undos === b_state2.undos, `tabs: Continue here takes it back with the other tab's strokes (${a_state2.undos} vs ${b_state2.undos} steps)`);
		await wait_until(fb, () => !!document.getElementById("paint95-taken"), null, 5000);
		check(true, "tabs: and the other tab is covered now");
		await fa.evaluate(() => window.paint95_autosaver.delete());
		await a.close();
		await b.close();
	}

	// ---- 10. iOS: saves while drawing without a pause; nothing starts in the back/forward cache ------------------------
	{
		const W = 200, H = 150;
		const key = "autosavetest10";
		const url = host_url(`w=${W}&h=${H}&draft=${key}`);
		let page = await context.newPage();
		watch(page, "ios");
		let frame = await open_editor(page, url);
		await frame.click(`.tools-component .tool[title="Pencil"]`);
		const box = await (await frame.$(".main-canvas")).boundingBox();
		const scale = box.width / W;
		// strokes back to back for 3 s, never pausing: a save is due 0.7 s after the first one, and isn't put off
		const t0 = Date.now();
		let first_save_at = 0;
		for (let s = 0; Date.now() - t0 < 3000; s++) {
			const y = 10 + (s * 13) % (H - 20);
			await page.mouse.move(box.x + 10 * scale, box.y + y * scale);
			await page.mouse.down();
			await page.mouse.move(box.x + 190 * scale, box.y + ((y + 40) % H) * scale, { steps: 6 });
			await page.mouse.up();
			if (!first_save_at && (await page.evaluate(() => window.saves.length)) > 0) first_save_at = Date.now() - t0;
		}
		check(first_save_at > 0 && first_save_at < 1800, `ios: drawing without a pause still saves, ${first_save_at} ms after the first stroke`);
		const saves_while_drawing = await page.evaluate(() => window.saves.length);
		check(saves_while_drawing >= 2, `ios: and keeps saving while drawing goes on (${saves_while_drawing} saves in 3 s)`);
		await wait_until(frame, () => !window.paint95_autosaver.state().pending, null, 5000);

		// the page goes into the back/forward cache (a swipe back): nothing new starts, the connection is closed
		await frame.evaluate(() => {
			window.__tx_started = 0;
			const transaction = IDBDatabase.prototype.transaction;
			IDBDatabase.prototype.transaction = function (...args) {
				window.__tx_started++;
				return transaction.apply(this, args);
			};
			dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
			Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		// a change that would be saved (as a stroke would be, if the page went before its save)
		await frame.evaluate(() => window.paint95_autosaver.changed());
		await new Promise((r) => setTimeout(r, 1500));
		let away = await frame.evaluate(() => ({ started: window.__tx_started, dirty: window.paint95_autosaver.dirty, failed: window.paint95_autosaver.failed }));
		check(away.started === 0 && away.dirty && !away.failed, `ios: in the back/forward cache no transaction starts, and nothing fails (${JSON.stringify(away)})`);
		const n = await page.evaluate(() => window.saves.length);
		await frame.evaluate(() => {
			Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
			dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
		});
		await wait_saved(page, n);
		away = await frame.evaluate(() => ({ started: window.__tx_started, dirty: window.paint95_autosaver.dirty }));
		check(away.started > 0 && !away.dirty, `ios: shown again, what it held is saved (${JSON.stringify(away)})`);
		const expected = await editor_state(frame);
		await page.close();
		page = await context.newPage();
		watch(page, "ios/reopen");
		frame = await open_editor(page, url);
		const after = await editor_state(frame);
		check(after.hash === expected.hash && after.undos === expected.undos, `ios: reopened, everything is back (${after.undos} vs ${expected.undos} steps)`);
		await frame.evaluate(() => window.paint95_autosaver.delete());
		await page.close();
	}

	// ---- 7. save time and size on a long drawing ------------------------------------------------------------------------
	{
		const W = 800, H = 600;
		const page = await context.newPage();
		watch(page, "long");
		const frame = await open_editor(page, host_url(`w=${W}&h=${H}&draft=autosavelong`));
		// real strokes: 120 brush strokes of 60 moves each
		await frame.click(`.tools-component .tool[title="Brush"]`);
		const box = await (await frame.$(".main-canvas")).boundingBox();
		const scale = box.width / W;
		for (let s = 0; s < 120; s++) {
			const y = 10 + (s * 37) % (H - 20);
			await page.mouse.move(box.x + 10 * scale, box.y + y * scale);
			await page.mouse.down();
			await page.mouse.move(box.x + (W - 10) * scale, box.y + ((y + 200) % H) * scale, { steps: 60 });
			await page.mouse.up();
		}
		await wait_saved(page, 0);
		await wait_until(frame, () => !!window.paint95_autosaver.last_snapshot_stats);
		const real = await frame.evaluate(() => ({ stats: window.paint95_autosaver.last_stats, snapshot: window.paint95_autosaver.last_snapshot_stats, events: window.P95.recorder.segment.events.length }));
		console.log(`long: ${real.events} recorded events: ${JSON.stringify(real.stats)}; snapshot ${JSON.stringify(real.snapshot)}`);
		// then a 100,000-event session (production drawing 132730's events appended to this one), to time saves at that size
		const fixture = fs.readFileSync(path.join(repo_root, "scripts", "fixtures", "132730-v1.p95")).toString("base64");
		const result = await frame.evaluate(async (base64) => {
			const { decode_p95 } = await import("./src/paint95-format.js");
			const file = decode_p95(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
			const events = file.header.segments.flatMap((s) => s.events).filter((e) => e[0] !== "s" && e[0] !== "f" && e[0] !== "b" && e[0] !== "p");
			const saver = window.paint95_autosaver;
			const recorder = window.P95.recorder;
			recorder.onchange = null; // measuring by hand
			await saver.flush(); // (nothing of the strokes' own saves still under way)
			clearTimeout(saver.timer);
			saver.timer = 0;
			recorder.segment.events.push(...events);
			const runs = [];
			const t_first = performance.now();
			await saver.save();
			runs.push({ what: "first save with +100k events", ...saver.last_stats, wall: Math.round(performance.now() - t_first) });
			for (let i = 0; i < 5; i++) {
				recorder.segment.events.push(...events.slice(i * 300, i * 300 + 300));
				await saver.save();
				runs.push({ what: "+300 events", ...saver.last_stats });
			}
			const t_full = performance.now();
			const blob = recorder.finalize();
			const full_ms = performance.now() - t_full;
			return { runs, finalize_ms: Math.round(full_ms), finalize_bytes: blob ? blob.size : null, total_events: recorder.segment.events.length };
		}, fixture);
		for (const run of result.runs) console.log(`long: ${JSON.stringify(run)}`);
		console.log(`long: for comparison, finalize() of all ${result.total_events} events: ${result.finalize_ms} ms, ${result.finalize_bytes} bytes`);
		const steady = result.runs.slice(1);
		check(steady.every((r) => r.bytes < 20000), `long: a save after a few strokes writes only the tail (${steady.map((r) => r.bytes).join(", ")} bytes)`);
		await page.close();
	}
} finally {
	await context.close();
	await browser.close();
	server.close();
}
console.log(failures ? `${failures} FAILURE(S)` : "ALL PASS");
process.exit(failures ? 1 : 0);
