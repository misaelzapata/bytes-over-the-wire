"use strict";
// VANDAL — client protocol.js. EXACT byte-layout mirror of server/protocol.js.
// LITTLE-ENDIAN everywhere (DataView littleEndian = true). Strings =
// [u8 len][len × u16 code unit] UTF-16 via charCodeAt. Coords = absolute u16.
// See server/protocol.js for the full documented wire spec.

// ---------------------------------------------------------------------------
// Growable little-endian Writer (DataView-backed).
// ---------------------------------------------------------------------------
class Writer {
  constructor(size = 32) {
    this.buf = new ArrayBuffer(size);
    this.dv = new DataView(this.buf);
    this.pos = 0;
  }
  _ensure(n) {
    if (this.pos + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = new ArrayBuffer(cap);
    new Uint8Array(nb).set(new Uint8Array(this.buf, 0, this.pos));
    this.buf = nb;
    this.dv = new DataView(nb);
  }
  u8(v) { this._ensure(1); this.dv.setUint8(this.pos, v & 0xff); this.pos += 1; return this; }
  u16(v) { this._ensure(2); this.dv.setUint16(this.pos, v & 0xffff, true); this.pos += 2; return this; }
  u32(v) { this._ensure(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; return this; }
  str(s) {
    s = s || "";
    this._ensure(1 + 2 * s.length);
    this.dv.setUint8(this.pos, s.length & 0xff); this.pos += 1;
    for (let i = 0; i < s.length; i++) { this.dv.setUint16(this.pos, s.charCodeAt(i), true); this.pos += 2; }
    return this;
  }
  done() { return new Uint8Array(this.buf, 0, this.pos); }
}

// ---------------------------------------------------------------------------
// Little-endian Reader (DataView-backed).
// ---------------------------------------------------------------------------
class Reader {
  constructor(arrbuf) { this.dv = new DataView(arrbuf); this.pos = 0; }
  u8() { const v = this.dv.getUint8(this.pos); this.pos += 1; return v; }
  u16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  str() {
    const len = this.u8();
    let s = "";
    for (let i = 0; i < len; i++) { s += String.fromCharCode(this.dv.getUint16(this.pos, true)); this.pos += 2; }
    return s;
  }
  remaining() { return this.dv.byteLength - this.pos; }
}

// ===========================================================================
// Client -> Server encoders
// ===========================================================================
function encSetNick(name) {
  name = (name || "").slice(0, C.NICK_MAX);
  const w = new Writer(2 + 2 * name.length).u8(0).u8(name.length & 0xff);
  for (let i = 0; i < name.length; i++) w.u16(name.charCodeAt(i));
  return w.done();
}
function encPing(clientMs) { return new Writer(5).u8(1).u32(clientMs >>> 0).done(); }

// STROKE (one-shot: shapes + eraser): [u8 2][u8 tool][u8 color][u8 size][u8 flags][u16 n]{u16 x,u16 y}
function encStroke(tool, color, size, flags, points) {
  const w = new Writer(8 + points.length * 4);
  w.u8(2).u8(tool & 0xff).u8(color & 0xff).u8(size & 0xff).u8(flags & 0xff).u16(points.length & 0xffff);
  for (let i = 0; i < points.length; i++) w.u16(points[i].x & 0xffff).u16(points[i].y & 0xffff);
  return w.done();
}
function encUndo() { return new Writer(1).u8(3).done(); }
// STROKE_BEGIN: [u8 4][u8 tool][u8 color][u8 size][u8 flags][u16 x][u16 y]
function encStrokeBegin(tool, color, size, flags, x, y) {
  return new Writer(9).u8(4).u8(tool & 0xff).u8(color & 0xff).u8(size & 0xff).u8(flags & 0xff).u16(x & 0xffff).u16(y & 0xffff).done();
}
// STROKE_APPEND: [u8 5][u16 n]{u16 x,u16 y}
function encStrokeAppend(points) {
  const w = new Writer(3 + points.length * 4);
  w.u8(5).u16(points.length & 0xffff);
  for (let i = 0; i < points.length; i++) w.u16(points[i].x & 0xffff).u16(points[i].y & 0xffff);
  return w.done();
}
function encStrokeEnd() { return new Writer(1).u8(6).done(); }
// CURSOR: [u8 7][u16 x][u16 y][u8 flags][u8 color][u8 tool]
function encCursor(x, y, pressing, color, tool) {
  return new Writer(8).u8(7).u16(x & 0xffff).u16(y & 0xffff).u8(pressing ? 1 : 0).u8(color & 0xff).u8(tool & 0xff).done();
}
function encHandshake(version) { return new Writer(5).u8(255).u32(version).done(); }

// ===========================================================================
// Server -> Client decoders
// ===========================================================================
function readStrokeBlock(r) {
  const id = r.u32();
  const ownerId = r.u32();
  const tool = r.u8();
  const color = r.u8();
  const size = r.u8();
  const flags = r.u8();
  const n = r.u16();
  const points = new Array(n);
  for (let i = 0; i < n; i++) points[i] = { x: r.u16(), y: r.u16() };
  return { id, ownerId, tool, color, size, flags, soft: !!(flags & 1), flat: !!(flags & 2), points };
}

function decodeServer(arrbuf) {
  const r = new Reader(arrbuf);
  const id = r.u8();
  switch (id) {
    case 0: {
      const yourId = r.u32();
      const canvasW = r.u16();
      const canvasH = r.u16();
      const serverTick = r.u32();
      return { type: "welcome", yourId, canvasW, canvasH, serverTick };
    }
    case 1: {
      const count = r.u32();
      const strokes = new Array(count);
      for (let i = 0; i < count; i++) strokes[i] = readStrokeBlock(r);
      return { type: "history", strokes };
    }
    case 2:
      return { type: "stroke", stroke: readStrokeBlock(r) };
    case 3:
      return { type: "undo", strokeId: r.u32() };
    case 4:
      return { type: "presence", count: r.u16() };
    case 5: {
      const cx = r.u16();
      const cy = r.u16();
      const half = r.u16();
      const durMs = r.u16();
      return { type: "gallery", cx, cy, half, durMs };
    }
    case 6: {
      const clientMs = r.u32();
      const serverTick = r.u32();
      return { type: "pong", clientMs, serverTick };
    }
    case 7: {
      const count = r.u16();
      const list = new Array(count);
      for (let i = 0; i < count; i++) {
        const cid = r.u32();
        const x = r.u16();
        const y = r.u16();
        const flags = r.u8();
        const color = r.u8();
        const tool = r.u8();
        const name = r.str();
        list[i] = { id: cid, x, y, pressing: !!(flags & 1), color, tool, name };
      }
      return { type: "cursors", list };
    }
    case 8: {
      const sid = r.u32();
      const ownerId = r.u32();
      const tool = r.u8();
      const color = r.u8();
      const size = r.u8();
      const flags = r.u8();
      const x = r.u16();
      const y = r.u16();
      return { type: "stroke_begin", id: sid, ownerId, tool, color, size, flags, soft: !!(flags & 1), flat: !!(flags & 2), x, y };
    }
    case 9: {
      const sid = r.u32();
      const n = r.u16();
      const points = new Array(n);
      for (let i = 0; i < n; i++) points[i] = { x: r.u16(), y: r.u16() };
      return { type: "stroke_append", id: sid, points };
    }
    case 255: return { type: "version_outdated" };
    default: return { type: "unknown", id };
  }
}

const Protocol = {
  Writer, Reader,
  encSetNick, encPing, encStroke, encUndo,
  encStrokeBegin, encStrokeAppend, encStrokeEnd, encCursor, encHandshake,
  decodeServer,
};
