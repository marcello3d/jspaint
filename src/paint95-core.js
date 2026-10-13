// @ts-check
// JSPaint.exe: shared hooks for recording and replaying drawings (classic script, loaded before the app).
//
// The app calls into window.P95 at a few places:
// - P95.cmd(name, args, fn): wraps "commands" (undo, flip, paste...). Records them when they come straight from the UI,
//   i.e. not from inside a recorded canvas pointer event (those are reproduced by replaying the pointer events).
// - P95.now(): virtual clock for timing-dependent behavior (double clicks, quick-undo period).
// - P95.random(): seeded PRNG for drawing (airbrush).
// - P95.put(kind, ...) / P95.take(kind): out-of-band data (pixel snapshots) needed where rendering isn't portable.
// See docs/2draw-animation-format.md

(() => {
	/**
	 * Bump this whenever recorded input would replay differently (and keep the old behavior reachable via P95.behavior).
	 * 1: initial (software polygon rasterizer instead of WebGL, seeded airbrush, text/transform snapshots)
	 * 2: rotate and stretch/skew are software nearest-neighbor (no stored pixels); behavior-1 recordings still
	 *    replay the old way, using their stored pixels
	 */
	const ENGINE_BEHAVIOR = 2;

	/** mulberry32 */
	function make_prng(seed) {
		let a = seed >>> 0;
		return () => {
			a = (a + 0x6D2B79F5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	const P95 = {
		ENGINE_BEHAVIOR,
		/** behavior version being executed (replays of old files may set an older one) */
		behavior: ENGINE_BEHAVIOR,
		/** "edit" | "replay" */
		mode: new URLSearchParams(location.search).has("replay") ? "replay" : "edit",
		get replaying() { return P95.mode === "replay"; },
		/** &p95debug=1: hash the canvas before every recorded event, to find where a replay diverges */
		debug: new URLSearchParams(location.search).has("p95debug"),
		/** set by the recorder while it is active */
		recorder: null,
		/** nesting depth of P95.cmd calls */
		depth: 0,
		/** true while a recorded canvas pointer event (or airbrush tick) is being dispatched */
		in_dispatch: false,
		/** time (ms) of the event being dispatched, if any (recording: recorded time; replay: replayed time) */
		event_time: null,
		/** @type {() => number} */
		random: make_prng(1),
		make_prng,
		seed(seed) {
			P95.random = make_prng(seed);
		},
		now() {
			if (P95.event_time != null) {
				return P95.event_time;
			}
			if (P95.recorder) {
				return P95.recorder.now();
			}
			return performance.now();
		},
		/** command implementations by name, for replay: name -> (...decoded_args) => void */
		commands: {},
		register(commands) {
			Object.assign(P95.commands, commands);
		},
		/**
		 * @template T
		 * @param {string} name
		 * @param {any[]} args
		 * @param {(...args: any[]) => T} fn
		 * @returns {T}
		 */
		cmd(name, args, fn) {
			if (P95.recorder && P95.depth === 0 && !P95.in_dispatch && !P95.replaying) {
				const new_args = P95.recorder.command(name, args);
				if (new_args) {
					args = new_args;
				}
			}
			P95.depth++;
			try {
				return fn(...args);
			} finally {
				P95.depth--;
			}
		},
		/** Airbrush timer tick (recorded; when replaying, recorded ticks drive the airbrush instead of a timer) */
		tick(fn) {
			if (P95.recorder && !P95.replaying) {
				P95.recorder.tick(fn);
			} else {
				fn();
			}
		},
		/** Recording: stores out-of-band data. Replay: no-op. */
		put(kind, data) {
			if (P95.recorder && !P95.replaying) {
				P95.recorder.put(kind, data);
			}
		},
		/** Replay: returns the next recorded out-of-band data of this kind (or undefined). */
		take(kind) {
			return P95.player?.take(kind);
		},
		/** set by the replay controller */
		player: null,
	};
	window.P95 = P95;

	if (P95.replaying) {
		// Replay must never show dialogs or touch storage.
		window.showMessageBox = (options) => {
			console.warn("[replay] suppressed message box:", options && (options.message || options.messageHTML));
			const promise = Promise.resolve("cancel");
			return Object.assign(promise, { $window: $(), $message: $(), promise });
		};
		try {
			const memory = {};
			const fake_storage = {
				getItem: (k) => (k in memory ? memory[k] : null),
				setItem: (k, v) => { memory[k] = String(v); },
				removeItem: (k) => { delete memory[k]; },
				clear: () => { for (const k in memory) delete memory[k]; },
				key: (i) => Object.keys(memory)[i] ?? null,
				get length() { return Object.keys(memory).length; },
			};
			Object.defineProperty(window, "localStorage", { value: fake_storage, configurable: true });
		} catch (_error) { /* ignore */ }
		document.documentElement.classList.add("paint95-replay");
	}
})();
