# JSPaint.exe animation format (`.p95`)

JSPaint.exe (the 2draw fork of JS Paint) records a drawing session as **input**, not pixels, and replays it by feeding
the input back into the same engine. This file is what 2draw stores as `<entry>-v<ver>.p95` and what `player.js` plays.

## Container

Container integers are little-endian (u32 LE).

| Offset | Size | Contents |
| --- | --- | --- |
| 0 | 4 | magic `P95A` (ASCII) |
| 4 | 1 | container version: `2` (written now), `1` (still read) |
| 5 | 3 | reserved (0) |
| 8 | 4 | `J` = byte length of the compressed header |
| 12 | `J` | header: UTF-8 JSON, zlib-compressed (pako `deflate`) |
| | | **v2 only:** per segment, in order: u32 length + event payload (see [Events (v2 binary)](#events-v2-binary)) |
| … | 4 | `N` = number of blobs |
| … | | `N` × (u32 length, bytes): blobs, referenced by index. Every blob is a PNG. |

In v1 each segment's `events` is a JSON array inside the header; in v2 it's `null` there (with `event_count`), and the
events follow the header in binary. Decoding either gives the same in-memory events (the JSON arrays described below), so
the engine, player and history restore don't care which version a file is. Recording writes v2; continuing a v1 file
converts its segments losslessly.

PNGs are encoded and decoded byte-exactly (UPNG.js, RGBA, no premultiplication or color management), so their pixels
can be compared and restored exactly. Since ENGINE_BEHAVIOR 2 the only blobs are pasted/dropped images and text-commit
snapshots (v1 files may also have embedded starting pictures, rotate/stretch results, picture keyframes and final pictures).

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
       | { type: "image", blob }  // the starting picture (e.g. a `load` image that isn't a 2draw picture), exact pixels
       | { type: "image", url, hash } // the starting picture by reference: an immutable versioned 2draw picture
                                  //   (…/data/13/132726/132726-v1.png), drawn onto white width×height; hash = of that
       | { type: "continue", hash, url? }, // continue from the previous segment's result, cropped/padded onto
                                  //   white width×height (as it was submitted); hash = expected start pixels;
                                  //   url = that picture (the previous version's PNG), used if the replay drifted
       | { type: "continue", hash, history: true, keep, snap?, url?, blob? }, // the editor restored the previous
                                  //   sessions' undo history (see below) and continued from that exact state, after
                                  //   keeping only the last `keep` undo steps (P95.prune_history); snap: then it set
                                  //   the canvas to the posted picture (url + hash, or blob) as one more undoable step
  events: [Event, ...],
  duration,                       // ms of recording
  truncated?: true,               // events stop early (size cap); the end picture still exists
  end: { hash, width, height },   // hash of the final canvas (v1 files also have `blob`: the final picture as PNG)
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
| `b` | `kind, blob, ...` | out-of-band pixels for the preceding action: `"text", blob, x, y` (the canvas area under a committed text box: fonts differ between machines); in ENGINE_BEHAVIOR 1 recordings also `"transform", blob` (result of rotate/stretch/skew) |
| `h` | `hash, width, height` | keyframe: hash of the canvas at this point |
| `p` | `blob, hash, width, height` | keyframe with the full canvas as a PNG (v1 files only; no longer written) |

Commands are recorded only when they come from the UI. When they happen as a consequence of a recorded pointer event
(e.g. the pick-color tool switching back to the previous tool), they're reproduced by replaying that event.

### Events (v2 binary)

`src/paint95-events.js`, in the style of Lascaux `.lsa` v3 and the PaintBBS/Shi formats: LEB128 varints, zigzag
(signed) varints, per-type opcodes, and like numbers in separate streams so deflate finds the patterns.

Event payload: `u8 compression` (0 none, 1 zlib) then the streams:
`varint stream count, varint length × count, streams…` with streams in this order:

| Stream | Contents |
| --- | --- |
| `op` | one opcode byte per event: `d`1 `M`2 `m`3 `u`4 `c`5 `s`6 `k`7 `t`8 `f`9 `b`10 `h`11 `p`12, `0x3f` = JSON escape; pointer opcodes `+0x40` when the pointer id differs from the previous pointer event's |
| `dt` | zigzag varint `dt` per event |
| `dx`, `dy` | zigzag varint deltas of x/y from the previous pointer event's position (starting at 0,0), for `d M m u c` |
| `p` | pressure byte (0–255) for `d` and `M` |
| `other` | everything else, in event order |

`other` per event type:

- pointer events with `+0x40`: varint pointer id first;
- `d`: target byte (0 `"c"`, 1 `"a"`, 2 selection + zigzag n, 3 text box + zigzag n), flags byte
  (`mods` bits 0–3, pointer type bits 4–5, primary bit 6), buttons byte;
- `M`, `u`: mods byte, buttons byte; `m`, `c`, `k`: nothing;
- buttons byte = `buttons` (bits 0–4) `| (button + 1) << 5`; `0xff` = escape: zigzag `button`, varint `buttons`;
- `s`: varint field count, then per field an id byte (`bs b e a p w tm fg bg tc pal font z so tools` = 0–14, 255 + string
  for an unknown name) and the value: `bs` an enum byte (circle, square, reverse_diagonal, diagonal), colours (below),
  `pal` a byte 0 = JS Paint's default palette (only in a segment's first `s`) or 1 + varint count + colours, `font`
  varint count + (key id: family size line_scale bold italic underline vertical color background) + value,
  `so`/`tools` tool ids as enum bytes (the 16 tools in toolbox order), others a generic value;
- colour: tag byte 0 null, 1 `""`, 2 + varint palette index (the palette current in the stream), 3 + r g b (`#rrggbb`),
  4 + r g b (`rgb(r,g,b)`), 5 + string;
- `t`: string; `f`: command id byte (the command list above, in order; 255 + string) + varint arg count + args
  (`select_tool` ids as `0x80` + tool enum byte, otherwise generic values); `b`: kind byte + varint blob + varint count +
  values; `h`: u32 hash (big-endian) + varint width, height; `p`: varint blob + u32 hash + varint width, height;
- JSON escape: string with the v1 JSON array (anything that doesn't fit its compact form exactly);
- generic value: tag byte 0 null, 1 false, 2 true, 3 + varint, 4 + varint (negative), 5 + f64 (big-endian), 6 + string,
  7 array (varint count + values), 8 object (varint count + (string key, value)); strings are varint length + UTF-8.

The enum tables only grow; never reorder them.

### Hash

FNV-1a (32-bit) over the canvas width, the height, then the RGBA bytes read as 32-bit little-endian words:
`h = 0x811c9dc5; for each word w: h = Math.imul(h ^ w, 0x01000193)`; the result is unsigned.

## Recording

`src/paint95-record.js`. The recorder listens (capture phase) to pointer events that start in the canvas area and to
input in the text box, and gets UI commands from `P95.cmd()` wrappers around the engine's command functions. Tool state is
diffed whenever options change and before each event.

ENGINE_BEHAVIOR changes so far:

- 1: software polygon rasterizer, seeded airbrush, text and transform results stored as pixels
- 2: rotate and stretch/skew are software nearest-neighbor (no stored pixels)
- 3: the history is capped by step count (pruned to `P95.history_keep_for(w, h)` steps, about 128 MB of full
  snapshots, once it holds twice that)
- 4: history steps are patches (the changed rectangle before/after); the history is trimmed by the memory its steps
  hold (over 96 MB: first branches abandoned by undoing then doing something else, then the oldest steps, keeping
  half the budget and at least 10 steps)

Determinism measures in the engine (ENGINE_BEHAVIOR 1):

- polygons, ellipses, rounded rectangles, curves and brush shapes are rasterized in software (`software_fill_polygon`,
  even-odd, pixel centers; Bresenham outlines) instead of WebGL, so results don't depend on the GPU, and replay works
  without WebGL;
- the airbrush uses `P95.random()` (seeded) and timer ticks are events;
- pasted/dropped images are stored as PNG (and the recorder pastes the same normalized pixels the replay will);
- text results are stored as pixels (`b` events); rotate and stretch/skew are software nearest-neighbor (ENGINE_BEHAVIOR 2;
  in behavior 1 they were canvas transforms, stored as pixels);
- time-dependent code reads `P95.now()`.

### Size cap

The recorder stops adding events past 500,000 events or ~40 MB of estimated data (`truncated`). When building the file,
if it's over **8 MB**, the new session's events are dropped, then all sessions' events (the player then shows the start
and snaps to the final picture); if it's still too big, no animation is submitted. Submitting the drawing never fails because of the animation.

## Continuing a drawing

The editor gets `&anim=<previous .p95>` along with `&load=<previous png>`. If the file loads (CORS fetch) and its
format/behavior are known, the new file contains all previous segments plus a new `continue` segment. Otherwise the new
file starts fresh with the `load` image as an `image` start.

### Restoring the undo history

When revising, the editor always resumes from the previous recording: it replays the file's segments itself
(`src/paint95-restore.js`, time-sliced, with a "Restoring history" progress box that can't be skipped), so undo can step
back into earlier sessions, then prunes the history to the last `keep` steps (behavior 3: about 128 MB of snapshots, 10–100 steps; behavior 4, where steps are patches and the engine trims the history by the memory its steps hold: 10,000).
The new segment is `continue` with `history: true`; replay does the same prune at that point instead of resetting the
history.

If the replayed picture isn't exactly the posted one (the replay drifted, the log is truncated, a newer engine recorded it,
or the size changed), the history is still kept and one more undoable step ("Previous Version", `P95.snap_to_picture`)
sets the canvas to the posted picture. The segment records it as `snap: true`, with the picture by `url` (a 2draw
picture, verified by `hash`) or embedded as `blob`, and replay performs the same step.

Only a missing (404, network error) or unreadable (corrupt, unknown container) file starts over from the picture: a
`continue` segment without `history`, or an `image` start if the file couldn't be loaded at all. (`&p95nohistory=1`, set
by a reload if replaying throws, does the same.)

### Loading `load` and `anim`

Both are fetched with CORS, `cache: "no-store"`, and an extra `p95load=1` query parameter (falling back to an
`<img crossorigin>` with a unique parameter): S3 only sends CORS headers and `Vary: Origin` when a request has an Origin,
so a response cached from a plain `<img>` on the view page could otherwise be reused for the CORS request and fail.

## Replay

`index.html?replay=1` (`src/paint95-replay.js`) hides the UI, never shows message boxes and never touches
localStorage. `player.js` creates it as a hidden same-origin iframe and drives `window.paint95Replay`:

- each event is executed by calling the engine: pointer events are dispatched through the engine's own (jQuery) handlers on
  the recorded target, at the client position of the recorded canvas pixel's center; `s` events set the state;
  `f` events call the command implementations; `k` ticks run the airbrush; hooks consume `b` data;
- playback time (display only; the engine always sees the recorded times): while a pointer is down, recorded timing
  (a pointer held still counts at most 1 s); pauses before a stroke or a picture-changing command count at most 250 ms;
  events that don't change the picture (`s`, `h`, `p`, `b`, `select_tool`) take no time. Times the speed. Constants at the
  top of `src/paint95-replay.js`. Seeking restores an in-memory checkpoint (see Seeking);
- pictures by reference (starting pictures, and the final picture passed as `finalImageUrl` by the page) are fetched
  before playing (with the same cache-busting CORS fetch as the editor) and checked against their hashes;
- on a hash mismatch the player reports `onDrift` and keeps going; at the end it snaps to the final picture (a v1 file's
  stored one, or `finalImageUrl`). A missing starting picture means replaying from white.

### Seeking

The player keeps in-memory checkpoints of the replay (`src/paint95-checkpoint.js`; nothing is stored in the file), and a
seek restores the latest one at or before the target and replays from there in the same engine (a forward seek too,
when a checkpoint ahead saves enough replay work). There's always one right after the start, so a seek never needs a
fresh engine; one is created only if checkpoints are off (no memory) or a restore fails.

- Taken as the replay goes, about every 250 ms of replay work, and only between strokes: no pointer down, no floating
  selection or text box, no polygon or curve in progress, nothing to cancel back to. That works the same for every
  engine behavior (1–4), since all of them keep their history as patches and get their randomness from the seeded PRNG.
- A checkpoint holds the canvas (and the history anchor's picture, usually the same pixels) in 64 KB bands, run-length
  encoded, sharing bands that didn't change with the previous checkpoint; the whole undo history as immutable records
  (step ids, links, patches and selections shared with the live history and with the previous checkpoint; only the
  anchor's picture, which changes in place, is copied); tool and option state (sizes, colors, palette, font, selected
  tools, tools' own state and canvases, the canvas context's state); the PRNG state; the replay position, consumed
  `b` data and drift state. Because it holds the whole history, a replay from a checkpoint never needs anything from
  before it (an undo reaches exactly the steps the straight replay has).
- Restoring first lets go of a gesture in progress (its handlers, floating selection or text box), then puts all of that
  back.
- Memory (`checkpointMemory`, default `Paint95Player.defaultCheckpointMemory()`): 16 MB per GB of
  `navigator.deviceMemory`, at most 128 MB; without it, 32 MB on phones and 64 MB otherwise. It counts the bands, the
  history records, and pixels that only checkpoints still keep (steps the live history has trimmed). Over budget every
  other checkpoint is dropped (the first is kept) and they're taken half as often.
- `seeking` stays true from `seek()` until the target frame is drawn, and no frames are drawn on the way.

`npm run test:2draw-replay -- --only=checkpoints` checks thousands of random seeks (on the fixtures and the recordings,
every engine behavior, with plenty of checkpoints and with a budget small enough to keep thinning them) against a
straight replay: the frame and the history must be the same.
