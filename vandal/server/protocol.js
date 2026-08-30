"use strict";

// =============================================================================
// protocol.js — Binary wire protocol: serialization and deserialization of all
//               client-server messages over WebSocket (little-endian frames).
// Protocolo binario del cable: serializacion y deserializacion de todos los
// mensajes cliente-servidor sobre WebSocket (tramas little-endian).
//
// Key concepts / Conceptos clave:
//   - Reference implementation of the VANDAL binary wire spec / Implementacion de referencia de la especificacion binaria VANDAL
//   - Writer/Reader classes for growable little-endian buffers / Clases Writer/Reader para buffers little-endian de tamano variable
//   - STROKE_BLOCK format shared by HISTORY and STROKE packets / Formato STROKE_BLOCK compartido entre paquetes HISTORY y STROKE
//   - S2C (server-to-client) and C2S (client-to-server) packet IDs / IDs de paquetes S2C (servidor-a-cliente) y C2S (cliente-a-servidor)
// =============================================================================

// ===========================================================================
// protocol.js — binary (de)serialization for VANDAL.
//
// This Node server is the REFERENCE implementation of the wire protocol
// (to be ported to Go / Python / Rust later). Keep it minimal + documented.
// client/js/protocol.js MUST mirror these byte layouts byte-for-byte.
//
// ---------------------------------------------------------------------------
// WIRE RULES
//   * Every multibyte number is LITTLE-ENDIAN.
//   * 1-byte packet id at offset 0 of every frame (both directions).
//   * Canvas positions are absolute u16 (0..CANVAS_W / 0..CANVAS_H).
//   * str := [u8 length][length × u16 code unit]  (UTF-16 via charCodeAt),
//            length <= NICK_MAX code units; server clamps.
//
// STROKE_BLOCK (a completed stroke; shared by HISTORY + STROKE commit):
//   [u32 id][u32 ownerId][u8 tool][u8 color][u8 size][u8 flags]
//   [u16 nPoints]{ u16 x, u16 y } × nPoints
//
// ---------------------------------------------------------------------------
// SERVER -> CLIENT
//   0 WELCOME       [u32 yourId][u16 canvasW][u16 canvasH][u32 serverTick]
//   1 HISTORY       [u32 count]{ STROKE_BLOCK }              (full mural on join)
//   2 STROKE        { STROKE_BLOCK }                         (a stroke committed)
//   3 UNDO          [u32 strokeId]                           (remove a stroke)
//   4 PRESENCE      [u16 painterCount]
//   5 GALLERY       [u16 cx][u16 cy][u16 half][u16 durMs]    (fly-through cue)
//   6 PONG          [u32 clientMs][u32 serverTick]
//   7 CURSORS       [u16 count]{ [u32 id][u16 x][u16 y][u8 flags][u8 color][u8 tool][str name] }
//   8 STROKE_BEGIN  [u32 id][u32 ownerId][u8 tool][u8 color][u8 size][u8 flags][u16 x][u16 y]
//   9 STROKE_APPEND [u32 id][u16 n]{ u16 x, u16 y }
// 255 VERSION_OUTDATED
//
// A live stroke is drawn as BEGIN -> APPEND* -> STROKE(commit, same id). On the
// commit every client drops its in-progress copy and rasterizes the authoritative
// block, so late joiners (who missed BEGIN/APPEND) still get the finished stroke.
//
// CLIENT -> SERVER
//   0 SET_NICK      [str name]
//   1 PING          [u32 clientMs]
//   2 STROKE        [u8 tool][u8 color][u8 size][u8 flags][u16 n]{u16 x,u16 y}
//                   (one-shot: shapes + eraser)
//   3 UNDO          (undo my most-recent committed stroke)
//   4 STROKE_BEGIN  [u8 tool][u8 color][u8 size][u8 flags][u16 x][u16 y]
//   5 STROKE_APPEND [u16 n]{u16 x,u16 y}
//   6 STROKE_END
//   7 CURSOR        [u16 x][u16 y][u8 flags][u8 color][u8 tool]
// 255 HANDSHAKE     [u32 version]
//
// Live co-painting (brush + spray) streams BEGIN -> APPEND* -> END. Shapes and
// the eraser are sent as one-shot STROKE frames on release.
// ===========================================================================

const C = require("./constants.js");

// --- packet ids: server -> client ------------------------------------------
const S2C = {
  WELCOME: 0,
  HISTORY: 1,
  STROKE: 2,
  UNDO: 3,
  PRESENCE: 4,
  GALLERY: 5,
  PONG: 6,
  CURSORS: 7,
  STROKE_BEGIN: 8,
  STROKE_APPEND: 9,
  VERSION_OUTDATED: 255,
};

// --- packet ids: client -> server ------------------------------------------
const C2S = {
  SET_NICK: 0,
  PING: 1,
  STROKE: 2,
  UNDO: 3,
  STROKE_BEGIN: 4,
  STROKE_APPEND: 5,
  STROKE_END: 6,
  CURSOR: 7,
  HANDSHAKE: 255,
};

// STROKE flag bits
const FLAG_SOFT = 1 << 0; // soft (blended) brush vs. hard edge
// CURSOR flag bits
const CUR_PRESSING = 1 << 0; // painter is actively laying down a stroke

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- tiny growable little-endian writer ------------------------------------
class Writer {
  constructor(size = 64) {
    this.buf = Buffer.allocUnsafe(size);
    this.pos = 0;
  }
  _ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = Buffer.allocUnsafe(cap);
    this.buf.copy(nb, 0, 0, this.pos);
    this.buf = nb;
  }
  u8(v) {
    this._ensure(1);
    this.buf.writeUInt8(v & 0xff, this.pos);
    this.pos += 1;
    return this;
  }
  u16(v) {
    this._ensure(2);
    this.buf.writeUInt16LE(v & 0xffff, this.pos);
    this.pos += 2;
    return this;
  }
  u32(v) {
    this._ensure(4);
    this.buf.writeUInt32LE(v >>> 0, this.pos);
    this.pos += 4;
    return this;
  }
  // [u8 length][length x u16 code unit] UTF-16; clamps to NICK_MAX.
  str(s) {
    s = (s || "").slice(0, C.NICK_MAX);
    this._ensure(1 + 2 * s.length);
    this.buf.writeUInt8(s.length & 0xff, this.pos);
    this.pos += 1;
    for (let i = 0; i < s.length; i++) {
      this.buf.writeUInt16LE(s.charCodeAt(i) & 0xffff, this.pos);
      this.pos += 2;
    }
    return this;
  }
  done() {
    return this.buf.subarray(0, this.pos);
  }
}

// --- reader for client->server frames --------------------------------------
class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  u8() {
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }
  u16() {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  str() {
    const len = this.u8();
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.u16());
    return s;
  }
  remaining() {
    return this.buf.length - this.pos;
  }
}

// --- STROKE_BLOCK (completed stroke) ---------------------------------------
function writeStrokeBlock(w, s) {
  w.u32(s.id)
    .u32(s.ownerId)
    .u8(s.tool & 0xff)
    .u8(s.color & 0xff)
    .u8(s.size & 0xff)
    .u8(s.flags & 0xff)
    .u16(s.points.length);
  for (let i = 0; i < s.points.length; i++) {
    const p = s.points[i];
    w.u16(clamp(Math.round(p.x), 0, C.CANVAS_W)).u16(clamp(Math.round(p.y), 0, C.CANVAS_H));
  }
}

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
  return { id, ownerId, tool, color, size, flags, points };
}

// ===========================================================================
// Server -> Client encoders
// ===========================================================================

function welcome(yourId, serverTick) {
  return new Writer(16)
    .u8(S2C.WELCOME)
    .u32(yourId)
    .u16(C.CANVAS_W)
    .u16(C.CANVAS_H)
    .u32(serverTick >>> 0)
    .done();
}

function history(strokes) {
  const w = new Writer(4096);
  w.u8(S2C.HISTORY).u32(strokes.length >>> 0);
  for (const s of strokes) writeStrokeBlock(w, s);
  return w.done();
}

function stroke(s) {
  const w = new Writer(256);
  w.u8(S2C.STROKE);
  writeStrokeBlock(w, s);
  return w.done();
}

function strokeBegin(s) {
  const p0 = s.points[0] || { x: 0, y: 0 };
  return new Writer(24)
    .u8(S2C.STROKE_BEGIN)
    .u32(s.id)
    .u32(s.ownerId)
    .u8(s.tool & 0xff)
    .u8(s.color & 0xff)
    .u8(s.size & 0xff)
    .u8(s.flags & 0xff)
    .u16(clamp(Math.round(p0.x), 0, C.CANVAS_W))
    .u16(clamp(Math.round(p0.y), 0, C.CANVAS_H))
    .done();
}

function strokeAppend(id, pts) {
  const w = new Writer(8 + pts.length * 4);
  w.u8(S2C.STROKE_APPEND).u32(id >>> 0).u16(pts.length & 0xffff);
  for (let i = 0; i < pts.length; i++) {
    w.u16(clamp(Math.round(pts[i].x), 0, C.CANVAS_W)).u16(clamp(Math.round(pts[i].y), 0, C.CANVAS_H));
  }
  return w.done();
}

function undo(strokeId) {
  return new Writer(5).u8(S2C.UNDO).u32(strokeId >>> 0).done();
}

function presence(count) {
  return new Writer(3).u8(S2C.PRESENCE).u16(count & 0xffff).done();
}

function cursors(list) {
  const w = new Writer(64);
  w.u8(S2C.CURSORS).u16(list.length & 0xffff);
  for (const c of list) {
    w.u32(c.id >>> 0)
      .u16(clamp(Math.round(c.x), 0, 65535))
      .u16(clamp(Math.round(c.y), 0, 65535))
      .u8(c.pressing ? CUR_PRESSING : 0)
      .u8(c.color & 0xff)
      .u8((c.tool | 0) & 0xff)
      .str(c.name || "");
  }
  return w.done();
}

function gallery(cx, cy, half, durMs) {
  return new Writer(9)
    .u8(S2C.GALLERY)
    .u16(clamp(Math.round(cx), 0, 65535))
    .u16(clamp(Math.round(cy), 0, 65535))
    .u16(clamp(Math.round(half), 1, 65535))
    .u16(clamp(Math.round(durMs), 0, 65535))
    .done();
}

function pong(clientMs, serverTick) {
  return new Writer(9).u8(S2C.PONG).u32(clientMs >>> 0).u32(serverTick >>> 0).done();
}

function versionOutdated() {
  return Buffer.from([S2C.VERSION_OUTDATED]);
}

// ===========================================================================
// Client -> Server decoder
// ===========================================================================

function readPoints(r, cap) {
  let n = r.u16();
  if (n > cap) n = cap;
  const points = [];
  for (let i = 0; i < n && r.remaining() >= 4; i++) {
    points.push({ x: r.u16(), y: r.u16() });
  }
  return points;
}

function decodeClient(buf) {
  if (!buf || buf.length < 1) return null;
  const r = new Reader(buf);
  const id = r.u8();
  switch (id) {
    case C2S.HANDSHAKE: {
      const version = buf.length >= 5 ? r.u32() : 0;
      return { type: "handshake", version };
    }
    case C2S.SET_NICK: {
      if (buf.length < 2) return { type: "nick", name: "" };
      return { type: "nick", name: r.str() };
    }
    case C2S.PING: {
      const clientMs = buf.length >= 5 ? r.u32() : 0;
      return { type: "ping", clientMs };
    }
    case C2S.STROKE: {
      if (buf.length < 7) return null;
      const tool = r.u8();
      const color = r.u8();
      const size = r.u8();
      const flags = r.u8();
      const points = readPoints(r, C.MAX_POINTS);
      return { type: "stroke", tool, color, size, flags, points };
    }
    case C2S.STROKE_BEGIN: {
      if (buf.length < 9) return null;
      const tool = r.u8();
      const color = r.u8();
      const size = r.u8();
      const flags = r.u8();
      const x = r.u16();
      const y = r.u16();
      return { type: "stroke_begin", tool, color, size, flags, x, y };
    }
    case C2S.STROKE_APPEND: {
      if (buf.length < 3) return null;
      const points = readPoints(r, C.MAX_POINTS);
      return { type: "stroke_append", points };
    }
    case C2S.STROKE_END: {
      return { type: "stroke_end" };
    }
    case C2S.CURSOR: {
      if (buf.length < 8) return null;
      const x = r.u16();
      const y = r.u16();
      const flags = r.u8();
      const color = r.u8();
      const tool = r.u8();
      return { type: "cursor", x, y, pressing: !!(flags & CUR_PRESSING), color, tool };
    }
    case C2S.UNDO:
      return { type: "undo" };
    default:
      return { type: "unknown", id };
  }
}

module.exports = {
  S2C,
  C2S,
  FLAG_SOFT,
  CUR_PRESSING,
  Writer,
  Reader,
  writeStrokeBlock,
  readStrokeBlock,
  welcome,
  history,
  stroke,
  strokeBegin,
  strokeAppend,
  undo,
  presence,
  cursors,
  gallery,
  pong,
  versionOutdated,
  decodeClient,
};
