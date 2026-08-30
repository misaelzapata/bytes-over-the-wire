"""protocol.py -- binary (de)serialization matching SPEC §12 EXACTLY.

Byte-for-byte mirror of server/protocol.js:
  - Every multibyte number is LITTLE-ENDIAN.
  - 1-byte packet id at offset 0 of every frame (both directions).
  - Positions are absolute u16, sizes (radii) u16, leaderboard masses u32.
  - Strings = [u8 length][length x u16 code unit] UTF-16 (charCodeAt), clamped
    to NICK_MAX code units.
  - Quantization is WIRE-ONLY; the sim runs on full-precision floats.
"""

import struct
import constants as C
from physics import js_round

# --- packet ids ------------------------------------------------------------
S2C_WELCOME = 0
S2C_SNAPSHOT = 1
S2C_LEADERBOARD = 2
S2C_PONG = 3
S2C_DEATH = 4
S2C_VERSION_OUTDATED = 255

C2S_SET_NICK = 0
C2S_PING = 1
C2S_INPUT_TARGET = 2
C2S_SPLIT = 3
C2S_EJECT = 4
C2S_RESPAWN = 5
C2S_HANDSHAKE = 255

# cell-block flag bits (SPEC §12.2)
FLAG_MINE = 1 << 0
FLAG_NAME = 1 << 1
FLAG_SPLIT = 1 << 2


def _clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def enc_pos(v):
    return _clamp(js_round(v), 0, 65535)


def enc_size(v):
    return _clamp(js_round(v), 0, 65535)


# --- little-endian writer ---------------------------------------------------
class Writer:
    def __init__(self, size=64):
        self.buf = bytearray()

    def u8(self, v):
        self.buf.append(v & 0xFF)
        return self

    def u16(self, v):
        self.buf += struct.pack("<H", v & 0xFFFF)
        return self

    def u32(self, v):
        self.buf += struct.pack("<I", v & 0xFFFFFFFF)
        return self

    def str(self, s):
        # [u8 length][length x u16 code unit] UTF-16-LE; clamp to NICK_MAX units.
        s = s or ""
        units = s.encode("utf-16-le")  # 2 bytes per UTF-16 code unit
        n = len(units) // 2
        if n > C.NICK_MAX:
            n = C.NICK_MAX
            units = units[: n * 2]
        self.buf.append(n & 0xFF)
        self.buf += units
        return self

    def done(self):
        return bytes(self.buf)


# --- reader for client->server frames --------------------------------------
class Reader:
    def __init__(self, buf):
        self.buf = buf
        self.pos = 0

    def u8(self):
        v = self.buf[self.pos]
        self.pos += 1
        return v

    def u16(self):
        v = struct.unpack_from("<H", self.buf, self.pos)[0]
        self.pos += 2
        return v

    def u32(self):
        v = struct.unpack_from("<I", self.buf, self.pos)[0]
        self.pos += 4
        return v

    def str(self):
        length = self.u8()
        raw = self.buf[self.pos : self.pos + 2 * length]
        self.pos += 2 * length
        return raw.decode("utf-16-le", errors="replace")

    def remaining(self):
        return len(self.buf) - self.pos


# ===========================================================================
# Server -> Client encoders
# ===========================================================================

def welcome(your_id, server_tick):
    w = Writer(16)
    (w.u8(S2C_WELCOME)
      .u32(your_id)
      .u16(C.WORLD_SIZE)
      .u16(C.WORLD_SIZE)
      .u32(server_tick))
    return w.done()


def snapshot(server_tick, eats, cells, foods, viruses, ejects, removes):
    w = Writer(2048)
    w.u8(S2C_SNAPSHOT).u32(server_tick)

    w.u16(len(eats))
    for e in eats:
        w.u32(e["eaterId"]).u32(e["eatenId"])

    w.u16(len(cells))
    for c in cells:
        (w.u32(c["id"])
          .u32(c["ownerId"])
          .u16(enc_pos(c["x"]))
          .u16(enc_pos(c["y"]))
          .u16(enc_size(c["size"]))
          .u8(c["hue"] & 0xFF)
          .u8(c["flags"] & 0xFF))
        if c["flags"] & FLAG_NAME:
            w.str(c["name"] or "")

    w.u16(len(foods))
    for f in foods:
        w.u32(f["id"]).u16(enc_pos(f["x"])).u16(enc_pos(f["y"])).u8(f["hue"] & 0xFF)

    w.u16(len(viruses))
    for v in viruses:
        w.u32(v["id"]).u16(enc_pos(v["x"])).u16(enc_pos(v["y"])).u16(enc_size(v["size"]))

    w.u16(len(ejects))
    for e in ejects:
        w.u32(e["id"]).u16(enc_pos(e["x"])).u16(enc_pos(e["y"])).u8(e["hue"] & 0xFF)

    w.u16(len(removes))
    for rid in removes:
        w.u32(rid)

    return w.done()


def leaderboard(rows, your_rank):
    w = Writer(256)
    w.u8(S2C_LEADERBOARD).u8(len(rows))
    for r in rows:
        w.u32(r["id"]).u32(r["mass"] & 0xFFFFFFFF).str(r["name"] or "")
    w.u8(_clamp(int(your_rank), 0, 255))
    return w.done()


def pong(client_ms, server_tick):
    w = Writer(9)
    w.u8(S2C_PONG).u32(client_ms & 0xFFFFFFFF).u32(server_tick & 0xFFFFFFFF)
    return w.done()


def death(final_mass):
    w = Writer(5)
    w.u8(S2C_DEATH).u32(max(0, int(final_mass)))
    return w.done()


def version_outdated():
    return bytes([S2C_VERSION_OUTDATED])


# ===========================================================================
# Client -> Server decoder
# ===========================================================================

def decode_client(buf):
    if not buf or len(buf) < 1:
        return None
    r = Reader(buf)
    pid = r.u8()
    if pid == C2S_HANDSHAKE:
        version = r.u32() if len(buf) >= 5 else 0
        return {"type": "handshake", "version": version}
    if pid == C2S_SET_NICK:
        if len(buf) < 2:
            return {"type": "nick", "name": ""}
        return {"type": "nick", "name": r.str()}
    if pid == C2S_PING:
        client_ms = r.u32() if len(buf) >= 5 else 0
        return {"type": "ping", "clientMs": client_ms}
    if pid == C2S_INPUT_TARGET:
        if len(buf) < 5:
            return None
        x = r.u16()
        y = r.u16()
        return {"type": "target", "x": x, "y": y}
    if pid == C2S_SPLIT:
        return {"type": "split"}
    if pid == C2S_EJECT:
        return {"type": "eject"}
    if pid == C2S_RESPAWN:
        return {"type": "respawn"}
    return {"type": "unknown", "id": pid}
