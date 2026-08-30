"use strict";

// =============================================================================
// protocol.js — Binary wire protocol: serialization and deserialization of all packets.
//               Protocolo binario: serializacion y deserializacion de todos los paquetes.
//
// Key concepts / Conceptos clave:
//   - All multibyte values are little-endian; 1-byte packet ID at offset 0 / Todos los valores multibyte son little-endian; ID de paquete de 1 byte en offset 0
//   - Server->Client: WELCOME, SNAPSHOT, LEADERBOARD, PONG, DEATH / Servidor->Cliente: WELCOME, SNAPSHOT, LEADERBOARD, PONG, DEATH
//   - Client->Server: HANDSHAKE, SET_NICK, PING, INPUT_TARGET, SPLIT, EJECT, RESPAWN / Cliente->Servidor: HANDSHAKE, SET_NICK, PING, INPUT_TARGET, SPLIT, EJECT, RESPAWN
//   - Positions quantized to u16 for transport; sim uses full-precision floats / Posiciones cuantizadas a u16 para transporte; la simulacion usa floats de precision completa
//   - Growable Writer and stateful Reader classes for building/parsing frames / Clases Writer (creciente) y Reader (con estado) para construir/parsear tramas
// =============================================================================

// ---------------------------------------------------------------------------
// protocol.js — binary (de)serialization matching SPEC §12 EXACTLY.
//
// Rules (SPEC §0):
//  - Every multibyte number is LITTLE-ENDIAN (Buffer *LE methods).
//  - 1-byte packet id at offset 0 of every frame (both directions).
//  - World positions are absolute u16 (world 0..14142 fits u16 0..65535);
//    sizes (radii) are u16; leaderboard masses u32.
//  - Strings = [u8 length][length x u16 code unit] UTF-16 (charCodeAt), names
//    <= NICK_MAX code units; server clamps.
//  - Quantization is WIRE-ONLY; the sim runs on full-precision floats.
//
// client/js/protocol.js MUST mirror these byte layouts byte-for-byte.
// ---------------------------------------------------------------------------

const C = require("./constants.js");

// --- packet ids ------------------------------------------------------------
const S2C = {
  WELCOME: 0,
  SNAPSHOT: 1,
  LEADERBOARD: 2,
  PONG: 3,
  DEATH: 4,
  VERSION_OUTDATED: 255,
};

const C2S = {
  SET_NICK: 0,
  PING: 1,
  INPUT_TARGET: 2,
  SPLIT: 3,
  EJECT: 4,
  RESPAWN: 5,
  HANDSHAKE: 255,
};

// cell-block flag bits (SPEC §12.2)
const FLAG_MINE = 1 << 0;
const FLAG_NAME = 1 << 1;
const FLAG_SPLIT = 1 << 2;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// absolute world coord -> u16
function encPos(v) {
  return clamp(Math.round(v), 0, 65535);
}
// radius -> u16
function encSize(v) {
  return clamp(Math.round(v), 0, 65535);
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

// ===========================================================================
// Server -> Client encoders
// ===========================================================================

// id 0 WELCOME: [u8 0][u32 yourPlayerId][u16 worldW][u16 worldH][u32 serverTick]
function welcome(yourId, serverTick) {
  const w = new Writer(16);
  w.u8(S2C.WELCOME)
    .u32(yourId)
    .u16(C.WORLD_SIZE)
    .u16(C.WORLD_SIZE)
    .u32(serverTick);
  return w.done();
}

// id 1 SNAPSHOT (SPEC §12.2). Inputs are plain arrays already culled to the
// viewer's AoI by index.js:
//   eats:    [{ eaterId, eatenId }]
//   cells:   [{ id, ownerId, x, y, size, hue, flags, name|null }]
//   foods:   [{ id, x, y, hue }]
//   viruses: [{ id, x, y, size }]
//   ejects:  [{ id, x, y, hue }]
//   removes: [id]
function snapshot(serverTick, eats, cells, foods, viruses, ejects, removes) {
  const w = new Writer(2048);
  w.u8(S2C.SNAPSHOT).u32(serverTick);

  w.u16(eats.length);
  for (const e of eats) w.u32(e.eaterId).u32(e.eatenId);

  w.u16(cells.length);
  for (const c of cells) {
    w.u32(c.id)
      .u32(c.ownerId)
      .u16(encPos(c.x))
      .u16(encPos(c.y))
      .u16(encSize(c.size))
      .u8(c.hue & 0xff)
      .u8(c.flags & 0xff);
    if (c.flags & FLAG_NAME) w.str(c.name || "");
  }

  w.u16(foods.length);
  for (const f of foods) w.u32(f.id).u16(encPos(f.x)).u16(encPos(f.y)).u8(f.hue & 0xff);

  w.u16(viruses.length);
  for (const v of viruses) w.u32(v.id).u16(encPos(v.x)).u16(encPos(v.y)).u16(encSize(v.size));

  w.u16(ejects.length);
  for (const e of ejects) w.u32(e.id).u16(encPos(e.x)).u16(encPos(e.y)).u8(e.hue & 0xff);

  w.u16(removes.length);
  for (const id of removes) w.u32(id);

  return w.done();
}

// id 2 LEADERBOARD: [u8 2][u8 n]{ u32 playerId, u32 mass, str name }[u8 yourRank]
function leaderboard(rows, yourRank) {
  const w = new Writer(256);
  w.u8(S2C.LEADERBOARD).u8(rows.length);
  for (const r of rows) w.u32(r.id).u32(r.mass >>> 0).str(r.name || "");
  w.u8(clamp(yourRank | 0, 0, 255));
  return w.done();
}

// id 3 PONG: [u8 3][u32 clientMs][u32 serverTick]
function pong(clientMs, serverTick) {
  const w = new Writer(9);
  w.u8(S2C.PONG).u32(clientMs >>> 0).u32(serverTick >>> 0);
  return w.done();
}

// id 4 DEATH: [u8 4][u32 finalMass]
function death(finalMass) {
  const w = new Writer(5);
  w.u8(S2C.DEATH).u32(Math.max(0, finalMass | 0));
  return w.done();
}

// id 255 VERSION_OUTDATED: no payload
function versionOutdated() {
  return Buffer.from([S2C.VERSION_OUTDATED]);
}

// ===========================================================================
// Client -> Server decoder
// ===========================================================================

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
    case C2S.INPUT_TARGET: {
      if (buf.length < 5) return null;
      const x = r.u16();
      const y = r.u16();
      return { type: "target", x, y };
    }
    case C2S.SPLIT:
      return { type: "split" };
    case C2S.EJECT:
      return { type: "eject" };
    case C2S.RESPAWN:
      return { type: "respawn" };
    default:
      return { type: "unknown", id };
  }
}

module.exports = {
  S2C,
  C2S,
  FLAG_MINE,
  FLAG_NAME,
  FLAG_SPLIT,
  Writer,
  Reader,
  welcome,
  snapshot,
  leaderboard,
  pong,
  death,
  versionOutdated,
  decodeClient,
};
