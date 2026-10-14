// JSPaint.exe animation player (classic script; no modules needed by the host page).
//
//   new Paint95Player({ domRoot, lsaUrl /* .p95 URL */, finalImageUrl? /* the entry's picture, for the end snap if the
//     replay drifts */, width?, height?, autoplay?, speed?, controls?, fit?: "box" | "contain", checkpointMemory? /* bytes,
//     default Paint95Player.defaultCheckpointMemory() */, onTimeUpdate?, onError?, onEnd?, onDrift? })
//   members: ready (Promise), duration (ms), currentTime (ms), isPlaying, seeking, play(), pause(), seek(ms),
//   setSpeed(multiplier 0.5..64; 64 = the strip's "max"), destroy()
//
// It replays the recorded input in the same engine: a hidden same-origin iframe of index.html?replay=1
// (next to this script) runs the drawing, and this copies its canvas into a <canvas> in domRoot. Seeking restores the
// nearest in-memory checkpoint of the replay (src/paint95-checkpoint.js) and replays from there.
// See docs/2draw-animation-format.md
(function () {
	"use strict";

	var script = document.currentScript;
	var base_url = new URL(".", (script && script.src) || location.href).href;

	var FRAME_BUDGET_MS = 12;

	function clamp(value, min, max) {
		return Math.max(min, Math.min(max, value));
	}

	var MB = 1024 * 1024;
	/**
	 * Memory for seeking checkpoints on this device: 16 MB per GB of navigator.deviceMemory, at most 128 MB; without
	 * it, 32 MB on phones and 64 MB otherwise. (They come on top of the replay engine itself, and phone browsers close
	 * tabs that use much more than a few hundred MB.)
	 */
	function defaultCheckpointMemory() {
		var device_memory = typeof navigator !== "undefined" && navigator.deviceMemory;
		if (device_memory > 0) {
			return clamp(device_memory * 16 * MB, 4 * MB, 128 * MB);
		}
		var phone = typeof screen !== "undefined" && Math.min(screen.width, screen.height) < 600;
		return phone ? 32 * MB : 64 * MB;
	}

	function Paint95Player(options) {
		if (!(this instanceof Paint95Player)) {
			return new Paint95Player(options);
		}
		var self = this;
		self._options = options || {};
		self._speed = clamp(Number(self._options.speed) || 1, 0.5, 64);
		self._time = 0;
		self._playing = false;
		self._duration = 0;
		self._destroyed = false;
		self._frame = null;
		self._controller = null;
		self._caught_up = true;
		self._raf = 0;
		self._last_tick = 0;
		self._restarting = null;
		self._ended = false;
		self._seeking = false;
		self._seek_pending = false;

		var root = self._options.domRoot;
		if (!root) {
			throw new Error("Paint95Player: domRoot is required");
		}
		self._root = root;
		self._container = document.createElement("div");
		self._container.className = "paint95-player";
		self._container.style.cssText = "position:relative;overflow:hidden;width:100%;height:100%;";
		if (self._options.fit === "box" && self._options.width && self._options.height) {
			self._container.style.width = self._options.width + "px";
			self._container.style.height = self._options.height + "px";
		}
		self._stage = document.createElement("div");
		self._stage.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0;";
		self._canvas = document.createElement("canvas");
		self._canvas.style.cssText = "position:absolute;display:block;";
		self._ctx = self._canvas.getContext("2d");
		self._stage.appendChild(self._canvas);
		self._container.appendChild(self._stage);
		if (self._options.controls) {
			self._build_controls();
		}
		root.appendChild(self._container);

		if (typeof ResizeObserver !== "undefined") {
			self._resize_observer = new ResizeObserver(function () { self._layout(); });
			self._resize_observer.observe(self._container);
		}

		self.ready = self._init();
		self.ready.catch(function (error) {
			if (self._options.onError) {
				self._options.onError(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	Object.defineProperties(Paint95Player.prototype, {
		duration: { get: function () { return this._duration; } },
		currentTime: { get: function () { return this._time; } },
		isPlaying: { get: function () { return this._playing; } },
		/** true from seek() until the target frame is drawn (catch-up frames aren't drawn meanwhile) */
		seeking: { get: function () { return this._seeking; } },
	});

	Paint95Player.prototype._init = function () {
		var self = this;
		return fetch(self._options.lsaUrl, { mode: "cors", credentials: "omit" })
			.then(function (response) {
				if (!response.ok) {
					throw new Error("Failed to load animation (HTTP " + response.status + ")");
				}
				return response.arrayBuffer();
			})
			.then(function (buffer) {
				self._buffer = buffer;
				return self._create_frame();
			})
			.then(function (frame) {
				self._install(frame);
				self._advance(Infinity);
				self._render();
				self._emit_time();
				if (self._options.autoplay) {
					self.play();
				}
			});
	};

	/** Creates the hidden replay iframe and loads the animation into it. */
	Paint95Player.prototype._create_frame = function () {
		var self = this;
		return new Promise(function (resolve, reject) {
			var iframe = document.createElement("iframe");
			iframe.setAttribute("aria-hidden", "true");
			iframe.tabIndex = -1;
			iframe.title = "";
			// Must be laid out (not display:none) for the engine's coordinate mapping; kept offscreen.
			iframe.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;height:1000px;border:0;visibility:hidden;pointer-events:none;";
			iframe.onload = function () {
				try {
					var controller = iframe.contentWindow.paint95Replay;
					if (!controller) {
						throw new Error("Replay engine failed to start");
					}
					var info = controller.load(self._buffer.slice(0));
					// fetch the pictures the file refers to (starting picture by URL; the final picture for the end snap)
					controller.prepare({ final_image_url: self._options.finalImageUrl || null }).then(function () {
						resolve({ iframe: iframe, controller: controller, info: info });
					}, function () {
						resolve({ iframe: iframe, controller: controller, info: info });
					});
				} catch (error) {
					iframe.remove();
					reject(error);
				}
			};
			iframe.onerror = function () {
				iframe.remove();
				reject(new Error("Failed to load the replay engine"));
			};
			iframe.src = base_url + "index.html?replay=1";
			document.body.appendChild(iframe);
		});
	};

	Paint95Player.prototype._install = function (frame) {
		var self = this;
		if (self._frame && self._frame.iframe !== frame.iframe) {
			self._frame.iframe.remove();
		}
		self._frame = frame;
		self._controller = frame.controller;
		self._duration = frame.info.duration;
		self._width = frame.info.width;
		self._height = frame.info.height;
		self._seek_pending = false;
		if (self._controller.enable_checkpoints) {
			var memory = self._options.checkpointMemory;
			self._controller.enable_checkpoints({ memory: memory == null ? defaultCheckpointMemory() : memory });
		}
		self._controller.ondrift = function (drift) {
			if (self._options.onDrift) {
				try { self._options.onDrift(drift); } catch (error) { console.error(error); }
			}
		};
		self._layout();
	};

	/** Processes events up to the current time within the frame budget. */
	Paint95Player.prototype._advance = function (budget) {
		if (!this._controller) {
			return;
		}
		this._caught_up = this._controller.advance_to(this._time, budget === undefined ? FRAME_BUDGET_MS : budget);
	};

	/** Gets the engine ready to replay to the seek's time: restores a checkpoint, or starts over in a fresh engine. */
	Paint95Player.prototype._apply_seek = function () {
		this._seek_pending = false;
		var ok = this._controller.seek ? this._controller.seek(this._time) : false;
		if (!ok) {
			this._restart();
		}
	};

	/** Replays from the start in a fresh engine (only one at a time; seeks meanwhile just move the target). */
	Paint95Player.prototype._restart = function () {
		var self = this;
		if (self._restarting) {
			return;
		}
		var restart = self._create_frame().then(function (frame) {
			if (self._destroyed || self._restarting !== restart) {
				frame.iframe.remove();
				return;
			}
			self._restarting = null;
			self._install(frame);
			self._caught_up = false;
			self._schedule();
		}, function (error) {
			self._restarting = null;
			self._seeking = false;
			if (self._options.onError) {
				self._options.onError(error);
			}
		});
		self._restarting = restart;
	};

	Paint95Player.prototype._schedule = function () {
		var self = this;
		if (self._raf || self._destroyed) {
			return;
		}
		self._last_tick = performance.now();
		self._raf = requestAnimationFrame(function tick(now) {
			self._raf = 0;
			if (self._destroyed) {
				return;
			}
			var dt = now - self._last_tick;
			self._last_tick = now;
			if (self._playing && !self._restarting && self._caught_up) {
				self._time = Math.min(self._duration, self._time + dt * self._speed);
			}
			if (!self._restarting && self._seek_pending) {
				self._apply_seek();
			}
			if (!self._restarting) {
				self._advance();
				// while seeking, keep the last frame until the target is reached
				var landed = self._seeking && self._caught_up;
				if (landed) {
					self._seeking = false;
				}
				if (!self._seeking) {
					self._render();
				}
				if (landed) {
					self._emit_time();
				}
			}
			if (self._playing) {
				self._emit_time();
			}
			if (self._playing && self._caught_up && self._time >= self._duration && self._controller && self._controller.done) {
				self._playing = false;
				self._ended = true;
				self._update_controls();
				self._emit_time();
				if (self._options.onEnd) {
					self._options.onEnd();
				}
			}
			if (self._playing || !self._caught_up || self._restarting) {
				self._last_tick = now;
				self._raf = requestAnimationFrame(tick);
			}
		});
	};

	Paint95Player.prototype.play = function () {
		var self = this;
		if (self._destroyed) {
			return;
		}
		if (self._time >= self._duration && self._duration > 0) {
			self.seek(0);
		}
		self._playing = true;
		self._ended = false;
		self._update_controls();
		self._schedule();
	};

	Paint95Player.prototype.pause = function () {
		this._playing = false;
		this._update_controls();
		this._emit_time();
	};

	Paint95Player.prototype.seek = function (ms) {
		var self = this;
		if (self._destroyed) {
			return;
		}
		ms = clamp(Number(ms) || 0, 0, self._duration);
		self._seeking = true;
		self._time = ms;
		// (applied on the next frame, so a burst of seeks while dragging costs one)
		self._seek_pending = true;
		self._caught_up = false;
		self._emit_time();
		self._schedule();
	};

	Paint95Player.prototype.setSpeed = function (multiplier) {
		this._speed = clamp(Number(multiplier) || 1, 0.5, 64);
	};

	Paint95Player.prototype.destroy = function () {
		this._destroyed = true;
		this._playing = false;
		if (this._raf) {
			cancelAnimationFrame(this._raf);
		}
		if (this._resize_observer) {
			this._resize_observer.disconnect();
		}
		if (this._frame) {
			this._frame.iframe.remove();
		}
		this._container.remove();
	};

	Paint95Player.prototype._emit_time = function () {
		this._update_controls();
		if (this._options.onTimeUpdate) {
			this._options.onTimeUpdate({
				currentTime: this._time,
				duration: this._duration,
				isPlaying: this._playing,
				progress: this._duration ? this._time / this._duration : 0,
				seeking: this._seeking,
			});
		}
	};

	Paint95Player.prototype._layout = function () {
		if (!this._width) {
			return;
		}
		var box_width = this._stage.clientWidth || this._width;
		var box_height = this._stage.clientHeight || this._height;
		var scale = Math.min(box_width / this._width, box_height / this._height);
		if (!isFinite(scale) || scale <= 0) {
			scale = 1;
		}
		this._scale = scale;
		var css_width = this._width * scale;
		var css_height = this._height * scale;
		this._canvas.style.width = css_width + "px";
		this._canvas.style.height = css_height + "px";
		this._canvas.style.left = (box_width - css_width) / 2 + "px";
		this._canvas.style.top = (box_height - css_height) / 2 + "px";
		this._canvas.style.imageRendering = scale >= 1 ? "pixelated" : "auto";
	};

	Paint95Player.prototype._render = function () {
		if (!this._controller) {
			return;
		}
		// nothing happened since the last frame: keep it (most frames, between strokes and while paused)
		var key = this._controller.version + ":" + (this._time < this._duration);
		if (this._rendered_key === key && this._rendered_frame === this._frame) {
			return;
		}
		this._rendered_key = key;
		this._rendered_frame = this._frame;
		var frame = this._controller.get_frame();
		var source = frame.canvas;
		if (this._canvas.width !== source.width || this._canvas.height !== source.height) {
			this._canvas.width = source.width;
			this._canvas.height = source.height;
			this._width = source.width;
			this._height = source.height;
			this._layout();
		}
		var ctx = this._ctx;
		ctx.imageSmoothingEnabled = false;
		ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
		ctx.drawImage(source, 0, 0);
		if (frame.selection) {
			ctx.drawImage(frame.selection.canvas, frame.selection.x, frame.selection.y);
		}
		if (frame.textbox) {
			ctx.drawImage(frame.textbox.canvas, frame.textbox.x, frame.textbox.y);
		}
		// recorded pointer
		if (frame.cursor && frame.cursor.visible && this._time < this._duration) {
			var r = Math.max(1.5, 4 / (this._scale || 1));
			ctx.beginPath();
			ctx.arc(frame.cursor.x + 0.5, frame.cursor.y + 0.5, r, 0, Math.PI * 2);
			ctx.lineWidth = Math.max(1, 1.5 / (this._scale || 1));
			ctx.strokeStyle = frame.cursor.down ? "rgba(255,0,0,0.9)" : "rgba(0,0,0,0.6)";
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(frame.cursor.x + 0.5, frame.cursor.y + 0.5, r + ctx.lineWidth, 0, Math.PI * 2);
			ctx.strokeStyle = "rgba(255,255,255,0.7)";
			ctx.lineWidth = Math.max(0.5, 1 / (this._scale || 1));
			ctx.stroke();
		}
	};

	Paint95Player.prototype._build_controls = function () {
		var self = this;
		var bar = document.createElement("div");
		bar.style.cssText = "position:absolute;left:0;right:0;bottom:0;height:28px;display:flex;align-items:center;gap:6px;padding:0 6px;background:rgba(192,192,192,0.95);font:12px sans-serif;box-sizing:border-box;";
		self._stage.style.bottom = "28px";
		var button = document.createElement("button");
		button.type = "button";
		button.style.cssText = "min-width:56px;";
		button.onclick = function () {
			if (self._playing) { self.pause(); } else { self.play(); }
		};
		var range = document.createElement("input");
		range.type = "range";
		range.min = "0";
		range.max = "1000";
		range.value = "0";
		range.style.cssText = "flex:1;min-width:0;";
		range.oninput = function () {
			self.seek(Number(range.value) / 1000 * self._duration);
		};
		bar.appendChild(button);
		bar.appendChild(range);
		self._container.appendChild(bar);
		self._controls = { button: button, range: range };
		self._update_controls();
	};

	Paint95Player.prototype._update_controls = function () {
		if (!this._controls) {
			return;
		}
		this._controls.button.textContent = this._playing ? "Pause" : "Play";
		if (document.activeElement !== this._controls.range) {
			this._controls.range.value = String(this._duration ? Math.round(this._time / this._duration * 1000) : 0);
		}
	};

	Paint95Player.defaultCheckpointMemory = defaultCheckpointMemory;
	window.Paint95Player = Paint95Player;
})();
