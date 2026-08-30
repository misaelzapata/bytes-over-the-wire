"use strict";
// AGAR-CLONE — client protocol.js. EXACT byte-layout mirror of server/protocol.js
// (SPEC §12). LITTLE-ENDIAN everywhere (DataView littleEndian = true). Strings =
// [u8 len][len × u16 code unit] UTF-16 via charCodeAt. Coords = absolute u16.

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
// Client -> Server encoders (SPEC §12.1)
// ===========================================================================
function encSetNick(name) {
  name = (name || "").slice(0, C.NICK_MAX);
  const w = new Writer(2 + 2 * name.length).u8(0).u8(name.length & 0xff);
  for (let i = 0; i < name.length; i++) w.u16(name.charCodeAt(i));
  return w.done();
}
function encPing(clientMs) { return new Writer(5).u8(1).u32(clientMs >>> 0).done(); }
function encInputTarget(x, y) {
  return new Writer(5).u8(2).u16(x & 0xffff).u16(y & 0xffff).done();
}
function encSplit() { return new Writer(1).u8(3).done(); }
function encEject() { return new Writer(1).u8(4).done(); }
function encRespawn() { return new Writer(1).u8(5).done(); }
function encHandshake(version) { return new Writer(5).u8(255).u32(version).done(); }

// ===========================================================================
// Server -> Client decoders (SPEC §12.1-§12.2)
// ===========================================================================

// CELL_BLOCK (SPEC §12.2). Name delta: bit1 => name string present.
function readCellBlock(r) {
  const id = r.u32();
  const ownerId = r.u32();
  const x = r.u16();
  const y = r.u16();
  const size = r.u16();
  const hue = r.u8();
  const flags = r.u8();
  const isMine = !!(flags & 1);
  const namePresent = !!(flags & 2);
  const isSplitting = !!(flags & 4);
  let name = null;
  if (namePresent) name = r.str();
  return { id, ownerId, x, y, size, hue, isMine, isSplitting, name };
}

function decodeSnapshot(r) {
  const tick = r.u32();
  const nEat = r.u16();
  const eats = new Array(nEat);
  for (let i = 0; i < nEat; i++) eats[i] = { eaterId: r.u32(), eatenId: r.u32() };

  const nCells = r.u16();
  const cells = new Array(nCells);
  for (let i = 0; i < nCells; i++) cells[i] = readCellBlock(r);

  const nFood = r.u16();
  const food = new Array(nFood);
  for (let i = 0; i < nFood; i++) food[i] = { id: r.u32(), x: r.u16(), y: r.u16(), hue: r.u8() };

  const nVirus = r.u16();
  const virus = new Array(nVirus);
  for (let i = 0; i < nVirus; i++) virus[i] = { id: r.u32(), x: r.u16(), y: r.u16(), size: r.u16() };

  const nEject = r.u16();
  const eject = new Array(nEject);
  for (let i = 0; i < nEject; i++) eject[i] = { id: r.u32(), x: r.u16(), y: r.u16(), hue: r.u8() };

  const nRemove = r.u16();
  const remove = new Array(nRemove);
  for (let i = 0; i < nRemove; i++) remove[i] = r.u32();

  return { type: "snapshot", tick, eats, cells, food, virus, eject, remove };
}

// Dispatch a server frame (ArrayBuffer) to a typed object.
function decodeServer(arrbuf) {
  const r = new Reader(arrbuf);
  const id = r.u8();
  switch (id) {
    case 0: { // WELCOME
      const yourPlayerId = r.u32();
      const worldW = r.u16();
      const worldH = r.u16();
      const serverTick = r.u32();
      return { type: "welcome", yourPlayerId, worldW, worldH, serverTick };
    }
    case 1: return decodeSnapshot(r);
    case 2: { // LEADERBOARD
      const n = r.u8();
      const rows = new Array(n);
      for (let i = 0; i < n; i++) {
        const playerId = r.u32();
        const mass = r.u32();
        const name = r.str();
        rows[i] = { playerId, mass, name };
      }
      const yourRank = r.u8();
      return { type: "leaderboard", rows, yourRank };
    }
    case 3: { // PONG
      const clientMs = r.u32();
      const serverTick = r.u32();
      return { type: "pong", clientMs, serverTick };
    }
    case 4: { // DEATH
      const finalMass = r.u32();
      return { type: "death", finalMass };
    }
    case 255: return { type: "version_outdated" };
    default: return { type: "unknown", id };
  }
}

const Protocol = {
  Writer, Reader,
  encSetNick, encPing, encInputTarget, encSplit, encEject, encRespawn, encHandshake,
  decodeServer,
};
