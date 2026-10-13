// @ts-check
// JSPaint.exe animation format v2: binary event streams.
// Same primitives as the Lascaux .lsa v3 and PaintBBS/Shi formats: LEB128 varints, zigzag deltas,
// per-type opcodes, and like numbers split into separate streams (opcodes, times, dx, dy, pressure, other)
// so deflate finds them. Decoding gives back exactly the v1 JSON events (see docs/2draw-animation-format.md);
// anything that doesn't fit the compact forms is stored as a JSON escape, so the conversion is lossless.

// #region Bytes

const utf8_encoder = new TextEncoder();
const utf8_decoder = new TextDecoder("utf-8");

export class ByteWriter {
	constructor(initial = 1024) {
		this.buf = new Uint8Array(initial);
		this.length = 0;
	}
	ensure(n) {
		if (this.length + n <= this.buf.length) return;
		let size = this.buf.length * 2;
		while (size < this.length + n) size *= 2;
		const next = new Uint8Array(size);
		next.set(this.buf.subarray(0, this.length));
		this.buf = next;
	}
	u8(v) {
		this.ensure(1);
		this.buf[this.length++] = v & 0xff;
	}
	/** big-endian, like .lsa */
	u32(v) {
		this.ensure(4);
		const b = this.buf;
		let o = this.length;
		b[o++] = v >>> 24;
		b[o++] = v >>> 16;
		b[o++] = v >>> 8;
		b[o++] = v;
		this.length = o;
	}
	/** Unsigned LEB128 */
	varint(v) {
		if (!(v >= 0) || !Number.isSafeInteger(v)) throw new Error(`varint out of range: ${v}`);
		while (v >= 0x80) {
			this.u8((v & 0x7f) | 0x80);
			v = Math.floor(v / 128);
		}
		this.u8(v);
	}
	/** Zigzag signed LEB128 */
	svarint(v) {
		this.varint(v < 0 ? -2 * v - 1 : 2 * v);
	}
	f64(v) {
		this.ensure(8);
		new DataView(this.buf.buffer, this.buf.byteOffset + this.length, 8).setFloat64(0, v);
		this.length += 8;
	}
	bytes(b) {
		this.ensure(b.length);
		this.buf.set(b, this.length);
		this.length += b.length;
	}
	blob(b) {
		this.varint(b.length);
		this.bytes(b);
	}
	string(s) {
		this.blob(utf8_encoder.encode(s));
	}
	view() {
		return this.buf.subarray(0, this.length);
	}
}

export class ByteReader {
	/** @param {Uint8Array} b */
	constructor(b) {
		this.b = b;
		this.pos = 0;
	}
	get remaining() {
		return this.b.length - this.pos;
	}
	need(n) {
		if (this.pos + n > this.b.length) throw new Error("truncated animation data");
	}
	u8() {
		this.need(1);
		return this.b[this.pos++];
	}
	u32() {
		this.need(4);
		const b = this.b;
		const o = this.pos;
		this.pos += 4;
		return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
	}
	varint() {
		let v = 0;
		let scale = 1;
		for (let i = 0; i < 8; i++) {
			const byte = this.u8();
			v += (byte & 0x7f) * scale;
			if (!(byte & 0x80)) return v;
			scale *= 128;
		}
		throw new Error("varint too long");
	}
	svarint() {
		const v = this.varint();
		return v % 2 === 1 ? -(v + 1) / 2 : v / 2;
	}
	f64() {
		this.need(8);
		const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 8).getFloat64(0);
		this.pos += 8;
		return v;
	}
	bytes(n) {
		this.need(n);
		const out = this.b.subarray(this.pos, this.pos + n);
		this.pos += n;
		return out;
	}
	blob() {
		return this.bytes(this.varint());
	}
	string() {
		return utf8_decoder.decode(this.blob());
	}
}

// #endregion

// #region Tables (fixed by the format: never reorder, only append)

const STREAM_NAMES = ["op", "dt", "dx", "dy", "p", "other"];

const OP = {
	d: 1, M: 2, m: 3, u: 4, c: 5, s: 6, k: 7, t: 8, f: 9, b: 10, h: 11, p: 12,
	/** an event that doesn't fit its compact form: JSON in "other" */
	json: 0x3f,
};
/** pointer opcodes: + this flag when the pointer id differs from the previous pointer event's (id in "other") */
const OP_NEW_POINTER = 0x40;
const OP_NAMES = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));

const TOOL_IDS = [
	"TOOL_FREE_FORM_SELECT", "TOOL_SELECT", "TOOL_ERASER", "TOOL_FILL", "TOOL_PICK_COLOR", "TOOL_MAGNIFIER",
	"TOOL_PENCIL", "TOOL_BRUSH", "TOOL_AIRBRUSH", "TOOL_TEXT", "TOOL_LINE", "TOOL_CURVE", "TOOL_RECTANGLE",
	"TOOL_POLYGON", "TOOL_ELLIPSE", "TOOL_ROUNDED_RECTANGLE",
];
const COMMANDS = [
	"undo", "redo", "cancel", "deselect", "delete_selection", "select_all", "clear", "invert_colors", "flip_horizontal",
	"flip_vertical", "rotate", "stretch_and_skew", "paste", "select_tool", "go_to_history_node", "new_document",
	"nudge_selection", "scale_selection",
];
const BLOB_KINDS = ["text", "transform"];
const BRUSH_SHAPES = ["circle", "square", "reverse_diagonal", "diagonal"];
/** state ("s" event) field ids */
const STATE_FIELDS = ["bs", "b", "e", "a", "p", "w", "tm", "fg", "bg", "tc", "pal", "font", "z", "so", "tools"];
const FONT_KEYS = ["family", "size", "line_scale", "bold", "italic", "underline", "vertical", "color", "background"];
/** JS Paint's default palette (as recorded), so the first "s" event can say "default" */
const DEFAULT_PALETTE = Object.freeze([
	"rgb(0,0,0)", "rgb(128,128,128)", "rgb(128,0,0)", "rgb(128,128,0)", "rgb(0,128,0)", "rgb(0,128,128)", "rgb(0,0,128)",
	"rgb(128,0,128)", "rgb(128,128,64)", "rgb(0,64,64)", "rgb(0,128,255)", "rgb(0,64,128)", "rgb(64,0,255)", "rgb(128,64,0)",
	"rgb(255,255,255)", "rgb(192,192,192)", "rgb(255,0,0)", "rgb(255,255,0)", "rgb(0,255,0)", "rgb(0,255,255)", "rgb(0,0,255)",
	"rgb(255,0,255)", "rgb(255,255,128)", "rgb(0,255,128)", "rgb(128,255,255)", "rgb(128,128,255)", "rgb(255,0,128)", "rgb(255,128,64)",
]);

const POINTER_TYPES_MAX = 3;

// #endregion

// #region Values

// generic value tags
const V_NULL = 0, V_FALSE = 1, V_TRUE = 2, V_UINT = 3, V_NEG = 4, V_F64 = 5, V_STRING = 6, V_ARRAY = 7, V_OBJECT = 8;

function write_value(w, v) {
	if (v === null) {
		w.u8(V_NULL);
	} else if (v === false) {
		w.u8(V_FALSE);
	} else if (v === true) {
		w.u8(V_TRUE);
	} else if (typeof v === "number") {
		if (Number.isSafeInteger(v) && !Object.is(v, -0)) {
			if (v >= 0) {
				w.u8(V_UINT);
				w.varint(v);
			} else {
				w.u8(V_NEG);
				w.varint(-v);
			}
		} else {
			w.u8(V_F64);
			w.f64(v);
		}
	} else if (typeof v === "string") {
		w.u8(V_STRING);
		w.string(v);
	} else if (Array.isArray(v)) {
		w.u8(V_ARRAY);
		w.varint(v.length);
		for (const item of v) write_value(w, item);
	} else if (typeof v === "object") {
		const entries = Object.entries(v);
		w.u8(V_OBJECT);
		w.varint(entries.length);
		for (const [key, value] of entries) {
			w.string(key);
			write_value(w, value);
		}
	} else {
		throw new Error(`can't encode ${typeof v}`);
	}
}

function read_value(r) {
	const tag = r.u8();
	switch (tag) {
		case V_NULL: return null;
		case V_FALSE: return false;
		case V_TRUE: return true;
		case V_UINT: return r.varint();
		case V_NEG: return -r.varint();
		case V_F64: return r.f64();
		case V_STRING: return r.string();
		case V_ARRAY: {
			const n = r.varint();
			const out = [];
			for (let i = 0; i < n; i++) out.push(read_value(r));
			return out;
		}
		case V_OBJECT: {
			const n = r.varint();
			const out = {};
			for (let i = 0; i < n; i++) {
				const key = r.string();
				out[key] = read_value(r);
			}
			return out;
		}
		default: throw new Error(`bad value tag ${tag}`);
	}
}

// colors: 0 null, 1 "", 2 palette index, 3 "#rrggbb", 4 "rgb(r,g,b)", 5 other string
const C_NULL = 0, C_EMPTY = 1, C_PALETTE = 2, C_HEX = 3, C_RGB = 4, C_STRING = 5;
const HEX_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/;
const RGB_RE = /^rgb\((\d{1,3}),(\d{1,3}),(\d{1,3})\)$/;

function write_color(w, color, palette) {
	if (color === null) {
		w.u8(C_NULL);
		return;
	}
	if (typeof color !== "string") throw new Error("bad color");
	if (color === "") {
		w.u8(C_EMPTY);
		return;
	}
	const index = palette ? palette.indexOf(color) : -1;
	if (index >= 0) {
		w.u8(C_PALETTE);
		w.varint(index);
		return;
	}
	let match = HEX_RE.exec(color);
	if (match) {
		w.u8(C_HEX);
		for (let i = 1; i <= 3; i++) w.u8(parseInt(match[i], 16));
		return;
	}
	match = RGB_RE.exec(color);
	if (match && match.slice(1).every((n) => Number(n) <= 255 && String(Number(n)) === n)) {
		w.u8(C_RGB);
		for (let i = 1; i <= 3; i++) w.u8(Number(match[i]));
		return;
	}
	w.u8(C_STRING);
	w.string(color);
}

function read_color(r, palette) {
	const tag = r.u8();
	switch (tag) {
		case C_NULL: return null;
		case C_EMPTY: return "";
		case C_PALETTE: return palette[r.varint()];
		case C_HEX: return "#" + [r.u8(), r.u8(), r.u8()].map((n) => n.toString(16).padStart(2, "0")).join("");
		case C_RGB: return `rgb(${r.u8()},${r.u8()},${r.u8()})`;
		case C_STRING: return r.string();
		default: throw new Error(`bad color tag ${tag}`);
	}
}

/** table entry index, or 255 + the string */
function write_enum(w, table, value) {
	const index = table.indexOf(value);
	if (index >= 0 && index < 255) {
		w.u8(index);
	} else {
		w.u8(255);
		w.string(value);
	}
}
function read_enum(r, table) {
	const index = r.u8();
	return index === 255 ? r.string() : table[index];
}

// #endregion

// #region State

function write_state(w, changes, ctx) {
	const entries = Object.entries(changes);
	w.varint(entries.length);
	for (const [key, value] of entries) {
		write_enum(w, STATE_FIELDS, key);
		switch (key) {
			case "bs":
				write_enum(w, BRUSH_SHAPES, value);
				break;
			case "fg": case "bg": case "tc":
				write_color(w, value, ctx.palette);
				break;
			case "pal":
				if (ctx.first_state && value.length === DEFAULT_PALETTE.length && value.every((c, i) => c === DEFAULT_PALETTE[i])) {
					w.u8(0); // default palette
				} else {
					w.u8(1);
					w.varint(value.length);
					for (const color of value) write_color(w, color, null);
				}
				ctx.palette = value.slice();
				break;
			case "font": {
				const font_entries = Object.entries(value);
				w.varint(font_entries.length);
				for (const [font_key, font_value] of font_entries) {
					write_enum(w, FONT_KEYS, font_key);
					write_value(w, font_value);
				}
				break;
			}
			case "so": {
				const so_entries = Object.entries(value);
				w.varint(so_entries.length);
				for (const [tool_id, bits] of so_entries) {
					write_enum(w, TOOL_IDS, tool_id);
					write_value(w, bits);
				}
				break;
			}
			case "tools":
				w.varint(value.length);
				for (const tool_id of value) write_enum(w, TOOL_IDS, tool_id);
				break;
			default:
				write_value(w, value);
		}
	}
	ctx.first_state = false;
}

function read_state(r, ctx) {
	const n = r.varint();
	const changes = {};
	for (let i = 0; i < n; i++) {
		const key = read_enum(r, STATE_FIELDS);
		switch (key) {
			case "bs":
				changes[key] = read_enum(r, BRUSH_SHAPES);
				break;
			case "fg": case "bg": case "tc":
				changes[key] = read_color(r, ctx.palette);
				break;
			case "pal": {
				const kind = r.u8();
				let palette;
				if (kind === 0) {
					palette = DEFAULT_PALETTE.slice();
				} else {
					const count = r.varint();
					palette = [];
					for (let j = 0; j < count; j++) palette.push(read_color(r, null));
				}
				changes[key] = palette;
				ctx.palette = palette.slice();
				break;
			}
			case "font": {
				const count = r.varint();
				const font = {};
				for (let j = 0; j < count; j++) {
					const font_key = read_enum(r, FONT_KEYS);
					font[font_key] = read_value(r);
				}
				changes[key] = font;
				break;
			}
			case "so": {
				const count = r.varint();
				const so = {};
				for (let j = 0; j < count; j++) {
					const tool_id = read_enum(r, TOOL_IDS);
					so[tool_id] = read_value(r);
				}
				changes[key] = so;
				break;
			}
			case "tools": {
				const count = r.varint();
				const ids = [];
				for (let j = 0; j < count; j++) ids.push(read_enum(r, TOOL_IDS));
				changes[key] = ids;
				break;
			}
			default:
				changes[key] = read_value(r);
		}
	}
	ctx.first_state = false;
	return changes;
}

// #endregion

// #region Events

const is_int = (v) => Number.isSafeInteger(v) && !Object.is(v, -0);
const is_u8 = (v) => is_int(v) && v >= 0 && v <= 255;

/** buttons/button byte: buttons (5 bits) | (button + 1) << 5; 0xff escapes to varints */
function write_buttons(o, button, buttons) {
	if (is_int(buttons) && buttons >= 0 && buttons < 32 && is_int(button) && button >= -1 && button <= 5) {
		o.u8(buttons | ((button + 1) << 5));
	} else {
		o.u8(0xff);
		o.svarint(button);
		o.varint(buttons);
	}
}
function read_buttons(o) {
	const byte = o.u8();
	if (byte === 0xff) {
		const button = o.svarint();
		return [button, o.varint()];
	}
	return [(byte >> 5) - 1, byte & 31];
}

/**
 * Checks that an event has exactly the shape its compact form can store.
 * @param {any[]} e
 */
function fits(e) {
	if (!Array.isArray(e) || typeof e[0] !== "string" || !is_int(e[1])) return false;
	const pointer_xy = (from) => is_int(e[from]) && is_int(e[from + 1]) && is_int(e[2]) && e[2] >= 0;
	const target_ok = (t) => t === "c" || t === "a" || (Array.isArray(t) && t.length === 2 && (t[0] === "s" || t[0] === "t") && is_int(t[1]));
	switch (e[0]) {
		case "d": return e.length === 12 && pointer_xy(4) && target_ok(e[3]) && is_int(e[6]) && is_int(e[7]) && is_int(e[8]) && e[8] >= 0 && e[8] < 16 &&
			is_int(e[9]) && e[9] >= 0 && e[9] <= POINTER_TYPES_MAX && is_u8(e[10]) && (e[11] === 0 || e[11] === 1);
		case "M": return e.length === 9 && pointer_xy(3) && is_int(e[5]) && is_int(e[6]) && is_int(e[7]) && e[7] >= 0 && e[7] < 16 && is_u8(e[8]);
		case "m": return e.length === 5 && pointer_xy(3);
		case "u": return e.length === 8 && pointer_xy(3) && is_int(e[5]) && is_int(e[6]) && is_int(e[7]) && e[7] >= 0 && e[7] < 16;
		case "c": return e.length === 5 && pointer_xy(3);
		case "s": return e.length === 3 && e[2] && typeof e[2] === "object" && !Array.isArray(e[2]);
		case "k": return e.length === 2;
		case "t": return e.length === 3 && typeof e[2] === "string";
		case "f": return e.length >= 3 && typeof e[2] === "string";
		case "b": return e.length >= 4 && typeof e[2] === "string" && is_int(e[3]) && e[3] >= 0;
		case "h": return e.length === 5 && is_int(e[2]) && e[2] >= 0 && e[2] <= 0xffffffff && is_int(e[3]) && e[3] >= 0 && is_int(e[4]) && e[4] >= 0;
		case "p": return e.length === 6 && is_int(e[2]) && e[2] >= 0 && is_int(e[3]) && e[3] >= 0 && e[3] <= 0xffffffff && is_int(e[4]) && e[4] >= 0 && is_int(e[5]) && e[5] >= 0;
		default: return false;
	}
}

/**
 * Encodes one segment's events.
 * @param {any[][]} events
 * @returns {Uint8Array} [varint stream count][varint length × count][streams…]
 */
export function encode_events(events) {
	const s = Object.fromEntries(STREAM_NAMES.map((name) => [name, new ByteWriter(4096)]));
	const ctx = { palette: DEFAULT_PALETTE.slice(), first_state: true };
	let last_x = 0;
	let last_y = 0;
	let last_pid = 1;
	const write_xy = (x, y) => {
		s.dx.svarint(x - last_x);
		s.dy.svarint(y - last_y);
		last_x = x;
		last_y = y;
	};
	for (const e of events) {
		let state_ok = true;
		if (e[0] === "s" && fits(e)) {
			// make sure the state can round-trip before committing to the compact form
			try {
				const test = new ByteWriter(256);
				const test_ctx = { palette: ctx.palette.slice(), first_state: ctx.first_state };
				write_state(test, e[2], test_ctx);
				const back = read_state(new ByteReader(test.view()), { palette: ctx.palette.slice(), first_state: ctx.first_state });
				state_ok = JSON.stringify(back) === JSON.stringify(e[2]);
			} catch (_error) {
				state_ok = false;
			}
		}
		if (!fits(e) || !state_ok) {
			s.op.u8(OP.json);
			s.dt.svarint(is_int(e[1]) ? e[1] : 0);
			s.other.string(JSON.stringify(e));
			continue;
		}
		const type = e[0];
		const pointer = type === "d" || type === "M" || type === "m" || type === "u" || type === "c";
		let op = OP[type];
		if (pointer && e[2] !== last_pid) {
			op |= OP_NEW_POINTER;
		}
		s.op.u8(op);
		s.dt.svarint(e[1]);
		if (op & OP_NEW_POINTER) {
			s.other.varint(e[2]);
			last_pid = e[2];
		}
		switch (type) {
			case "d": {
				const [, , , target, x, y, button, buttons, mods, ptype, pressure, primary] = e;
				write_xy(x, y);
				if (target === "c") {
					s.other.u8(0);
				} else if (target === "a") {
					s.other.u8(1);
				} else {
					s.other.u8(target[0] === "s" ? 2 : 3);
					s.other.svarint(target[1]);
				}
				s.other.u8(mods | (ptype << 4) | (primary << 6));
				write_buttons(s.other, button, buttons);
				s.p.u8(pressure);
				break;
			}
			case "M": {
				const [, , , x, y, button, buttons, mods, pressure] = e;
				write_xy(x, y);
				s.other.u8(mods);
				write_buttons(s.other, button, buttons);
				s.p.u8(pressure);
				break;
			}
			case "m":
			case "c":
				write_xy(e[3], e[4]);
				break;
			case "u": {
				const [, , , x, y, button, buttons, mods] = e;
				write_xy(x, y);
				s.other.u8(mods);
				write_buttons(s.other, button, buttons);
				break;
			}
			case "s":
				write_state(s.other, e[2], ctx);
				break;
			case "k":
				break;
			case "t":
				s.other.string(e[2]);
				break;
			case "f": {
				write_enum(s.other, COMMANDS, e[2]);
				const args = e.slice(3);
				s.other.varint(args.length);
				for (const arg of args) {
					if (e[2] === "select_tool" && typeof arg === "string") {
						// tool ids are common: a compact form inside the generic value space
						s.other.u8(0x80);
						write_enum(s.other, TOOL_IDS, arg);
					} else {
						write_value(s.other, arg);
					}
				}
				break;
			}
			case "b": {
				write_enum(s.other, BLOB_KINDS, e[2]);
				s.other.varint(e[3]);
				const extra = e.slice(4);
				s.other.varint(extra.length);
				for (const v of extra) write_value(s.other, v);
				break;
			}
			case "h":
				s.other.u32(e[2]);
				s.other.varint(e[3]);
				s.other.varint(e[4]);
				break;
			case "p":
				s.other.varint(e[2]);
				s.other.u32(e[3]);
				s.other.varint(e[4]);
				s.other.varint(e[5]);
				break;
		}
	}
	const w = new ByteWriter(STREAM_NAMES.reduce((n, name) => n + s[name].length, 32));
	w.varint(STREAM_NAMES.length);
	for (const name of STREAM_NAMES) w.varint(s[name].length);
	for (const name of STREAM_NAMES) w.bytes(s[name].view());
	return w.view().slice();
}

/**
 * @param {Uint8Array} bytes
 * @returns {any[][]} events, exactly as in v1
 */
export function decode_events(bytes) {
	const r = new ByteReader(bytes);
	const n = r.varint();
	if (n < STREAM_NAMES.length) throw new Error("bad event streams");
	const lengths = Array.from({ length: n }, () => r.varint());
	const s = {};
	STREAM_NAMES.forEach((name, i) => (s[name] = new ByteReader(r.bytes(lengths[i]))));
	const ctx = { palette: DEFAULT_PALETTE.slice(), first_state: true };
	let last_x = 0;
	let last_y = 0;
	let last_pid = 1;
	const read_xy = () => {
		last_x += s.dx.svarint();
		last_y += s.dy.svarint();
		return [last_x, last_y];
	};
	const events = [];
	while (s.op.remaining > 0) {
		const op_byte = s.op.u8();
		const dt = s.dt.svarint();
		if (op_byte === OP.json) {
			events.push(JSON.parse(s.other.string()));
			continue;
		}
		const type = OP_NAMES[op_byte & ~OP_NEW_POINTER];
		if (!type) throw new Error(`bad opcode ${op_byte}`);
		if (op_byte & OP_NEW_POINTER) {
			last_pid = s.other.varint();
		}
		const pid = last_pid;
		switch (type) {
			case "d": {
				const [x, y] = read_xy();
				const target_kind = s.other.u8();
				const target = target_kind === 0 ? "c" : target_kind === 1 ? "a" : [target_kind === 2 ? "s" : "t", s.other.svarint()];
				const flags = s.other.u8();
				const [button, buttons] = read_buttons(s.other);
				events.push(["d", dt, pid, target, x, y, button, buttons, flags & 15, (flags >> 4) & 3, s.p.u8(), (flags >> 6) & 1]);
				break;
			}
			case "M": {
				const [x, y] = read_xy();
				const mods = s.other.u8();
				const [button, buttons] = read_buttons(s.other);
				events.push(["M", dt, pid, x, y, button, buttons, mods, s.p.u8()]);
				break;
			}
			case "m":
			case "c": {
				const [x, y] = read_xy();
				events.push([type, dt, pid, x, y]);
				break;
			}
			case "u": {
				const [x, y] = read_xy();
				const mods = s.other.u8();
				const [button, buttons] = read_buttons(s.other);
				events.push(["u", dt, pid, x, y, button, buttons, mods]);
				break;
			}
			case "s":
				events.push(["s", dt, read_state(s.other, ctx)]);
				break;
			case "k":
				events.push(["k", dt]);
				break;
			case "t":
				events.push(["t", dt, s.other.string()]);
				break;
			case "f": {
				const name = read_enum(s.other, COMMANDS);
				const count = s.other.varint();
				const args = [];
				for (let i = 0; i < count; i++) {
					if (s.other.b[s.other.pos] === 0x80) {
						s.other.pos++;
						args.push(read_enum(s.other, TOOL_IDS));
					} else {
						args.push(read_value(s.other));
					}
				}
				events.push(["f", dt, name, ...args]);
				break;
			}
			case "b": {
				const kind = read_enum(s.other, BLOB_KINDS);
				const blob = s.other.varint();
				const count = s.other.varint();
				const extra = [];
				for (let i = 0; i < count; i++) extra.push(read_value(s.other));
				events.push(["b", dt, kind, blob, ...extra]);
				break;
			}
			case "h":
				events.push(["h", dt, s.other.u32(), s.other.varint(), s.other.varint()]);
				break;
			case "p": {
				const blob = s.other.varint();
				events.push(["p", dt, blob, s.other.u32(), s.other.varint(), s.other.varint()]);
				break;
			}
		}
	}
	return events;
}

// #endregion
