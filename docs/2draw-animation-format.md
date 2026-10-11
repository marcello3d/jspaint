# JSPaint.exe animation format (`.p95`)

JSPaint.exe (the 2draw fork of JS Paint) records a drawing session as **input**, not pixels, and replays it by feeding
the input back into the same engine. This file is what 2draw stores as `<entry>-v<ver>.p95` and what `player.js` plays.

## Container

All integers little-endian.

| Offset | Size | Contents |
| --- | --- | --- |
| 0 | 4 | magic `P95A` (ASCII) |
| 4 | 1 | container version (`1`) |
| 5 | 3 | reserved (0) |
| 8 | 4 | `J` = byte length of the compressed header |
| 12 | `J` | header: UTF-8 JSON, zlib-compressed (pako `deflate`) |
| 12+`J` | 4 | `N` = number of blobs |
| … | | `N` × (u32 length, bytes): blobs, referenced by index from the header. Every blob is a PNG. |

PNGs are encoded and decoded byte-exactly (UPNG.js, RGBA, no premultiplication or color management), so their pixels
can be compared and restored exactly.

## Header

```js
{
  format: 1,                      // header format version
  engine: { sha, behavior },      // of the newest segment (see below)
  width, height,                  // required canvas size of the newest segment
  truncated: false,               // true if any segment lost events (size cap)
  segments: [Segment, ...],       // one per editing session; a continued drawing appends a segment
}
```

### Segment

```js
{
  seed,                           // u32 seed of the drawing PRNG (mulberry32), e.g. for the airbrush
  engine: { sha, behavior },      // git SHA of the build that recorded it, and ENGINE_BEHAVIOR (integer)
  width, height,                  // canvas size the session was required to submit
  start: { type: "blank" }        // white width×height canvas
       | { type: "image", blob }  // the starting picture (e.g. the `load` image), exact pixels
       | { type: "continue", hash }, // continue from the previous segment's result, cropped/padded onto
                                  //   white width×height (as it was submitted); hash = expected start pixels
  events: [Event, ...],
  duration,                       // ms of recording
  truncated?: true,               // events stop early (size cap); the end picture still exists
  end: { hash, width, height, blob }, // the final canvas (exact PNG) and its hash
}
```

`ENGINE_BEHAVIOR` is bumped whenever the fork changes what a recorded input does (`src/paint95-core.js`).
Behavior changes must stay version-gated (`P95.behavior` is set to the segment's value during replay), so old files keep
replaying the old way; anything that still diverges is caught by the hashes below.

## Events

Each event is a JSON array `[type, dt, ...args]`; `dt` is milliseconds since the previous event (integers; the first
event of a segment is relative to the session start). The running sum is the event's time on the session's *virtual
clock*: when replaying, time-dependent code (polygon double-click, two-finger quick undo) sees this recorded time.

Coordinates are integer **canvas pixels** (what the engine computes from the pointer; zoom, scroll and window size don't
matter).

| Type | Args | Meaning |
| --- | --- | --- |
| `d` | `id, target, x, y, button, buttons, mods, ptype, pressure, primary` | pointerdown in the canvas area. `target`: `"c"` canvas, `"a"` canvas area (outside the canvas), `["s", n]` / `["t", n]` the floating selection / text box (`n` = index among its descendant elements, `-1` = itself, e.g. a resize handle). `mods`: 1 ctrl, 2 shift, 4 alt, 8 meta. `ptype`: 0 mouse, 1 pen, 2 touch. `pressure`: 0–255. |
| `M` | `id, x, y, button, buttons, mods, pressure` | pointermove of an active pointer |
| `m` | `id, x, y` | pointermove with the same other fields as the previous move of that pointer |
| `u` | `id, x, y, button, buttons, mods` | pointerup |
| `c` | `id, x, y` | pointercancel |
| `k` | | airbrush timer tick (spraying while the pointer is held still is a function of these ticks, not of real time) |
| `s` | `{changes}` | tool state changes: `bs` brush shape, `b` brush size, `e` eraser size, `a` airbrush size, `p` pencil size, `w` line width, `tm` transparent selection mode, `fg`/`bg`/`tc` colors (left/right/ctrl-click), `pal` palette (28 colors), `font` text tool font, `z` zoom, `so` `{toolId: bits}` fill style (1 outline, 2 fill), and in a segment's first event `tools` (selected tool ids) |
| `t` | `text` | the text tool's box now contains `text` |
| `f` | `name, ...args` | a command from the menus/keyboard/dialogs, with dialog results as values: `undo`, `redo`, `cancel(going_to_history_node, discard)`, `deselect(going_to_history_node)`, `delete_selection(name)`, `select_all`, `clear`, `invert_colors`, `flip_horizontal`, `flip_vertical`, `rotate(radians)`, `stretch_and_skew(x_scale, y_scale, h_skew, v_skew)`, `paste(blob, x, y)`, `select_tool(toolId, toggle)`, `go_to_history_node(id, canceling)`, `new_document`, `nudge_selection(dx, dy)`, `scale_selection(factor)` |
| `b` | `kind, blob, ...` | out-of-band pixels for the preceding action: `"text", blob, x, y` (the canvas area under a committed text box: fonts differ between machines) and `"transform", blob` (result of rotate/stretch/skew, whose resampling differs between browsers) |
| `h` | `hash, width, height` | keyframe: hash of the canvas at this point |
| `p` | `blob, hash, width, height` | keyframe with the full canvas as a PNG (about every 2 minutes) |

Commands are recorded only when they come from the UI. When they happen as a consequence of a recorded pointer event
(e.g. the pick-color tool switching back to the previous tool), they're reproduced by replaying that event.

### Hash

FNV-1a (32-bit) over the canvas width, the height, then the RGBA bytes read as 32-bit little-endian words:
`h = 0x811c9dc5; for each word w: h = Math.imul(h ^ w, 0x01000193)`; the result is unsigned.

## Recording

`src/paint95-record.js`. The recorder listens (capture phase) to pointer events that start in the canvas area and to
input in the text box, and gets UI commands from `P95.cmd()` wrappers around the engine's command functions. Tool state is
diffed whenever options change and before each event.

Determinism measures in the engine (ENGINE_BEHAVIOR 1):

- polygons, ellipses, rounded rectangles, curves and brush shapes are rasterized in software (`software_fill_polygon`,
  even-odd, pixel centers; Bresenham outlines) instead of WebGL, so results don't depend on the GPU, and replay works
  without WebGL;
- the airbrush uses `P95.random()` (seeded) and timer ticks are events;
- pasted/dropped images are stored as PNG (and the recorder pastes the same normalized pixels the replay will);
- text and rotate/stretch/skew results are stored as pixels (`b` events);
- time-dependent code reads `P95.now()`.

### Size cap

The recorder stops adding events past 500,000 events or ~40 MB of estimated data (`truncated`). When building the file,
if it's over **8 MB**, the new session's events are dropped (keeping its start and final picture), then all sessions'
events; if it's still too big, no animation is submitted. Submitting the drawing never fails because of the animation.

## Continuing a drawing

The editor gets `&anim=<previous .p95>` along with `&load=<previous png>`. If the file loads (CORS fetch) and its
format/behavior are known, the new file contains all previous segments plus a new `continue` segment. Otherwise the new
file starts fresh with the `load` image as an `image` start.

## Replay

`index.html?replay=1` (`src/paint95-replay.js`) hides the UI, never shows message boxes and never touches
localStorage. `player.js` creates it as a hidden same-origin iframe and drives `window.paint95Replay`:

- each event is executed by calling the engine: pointer events are dispatched through the engine's own (jQuery) handlers on
  the recorded target, at the client position of the recorded canvas pixel's center; `s` events set the state;
  `f` events call the command implementations; `k` ticks run the airbrush; hooks consume `b` data;
- playback time is recorded time with idle gaps capped at 1 s, times the speed; seeking backwards replays from the start
  in a fresh iframe;
- on a hash mismatch the player reports `onDrift` and snaps to the next PNG keyframe or, at the end of a segment, the final
  picture, and keeps going.
