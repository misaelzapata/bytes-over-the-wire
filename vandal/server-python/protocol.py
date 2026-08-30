"""protocol.py — binary (de)serialization for VANDAL (Python port).

Byte-for-byte mirror of ../server/protocol.js and ../client/js/protocol.js.

WIRE RULES
  * Every multibyte number is LITTLE-ENDIAN.
  * 1-byte packet id at offset 0 of every frame (both directions).
  * Canvas positions are absolute u16 (0..CANVAS_W / 0..CANVAS_H).
  * str := [u8 length][length x u16 code unit]  (UTF-16 via charCodeAt),
           length <= NICK_MAX code units; server clamps.

STROKE_BLOCK (a completed stroke; shared by HISTORY + STROKE commit):
  [u32 id][u32 ownerId][u8 tool][u8 color][u8 size][u8 flags]
  [u16 nPoints]{ u16 x, u16 y } x nPoints
"""

import struct

import constants as C

# --- packet ids: server -> client ------------------------------------------
S2C = {
    "WELCOME": 0,
    "HISTORY": 1,
    "STROKE": 2,
    "UNDO": 3,
    "PRESENCE": 4,
    "GALLERY": 5,
    "PONG": 6,
    "CURSORS": 7,
    "STROKE_BEGIN": 8,
    "STROKE_APPEND": 9,
    "VERSION_OUTDATED": 255,
}

# --- packet ids: client -> server ------------------------------------------
C2S = {
    "SET_NICK": 0,
    "PING": 1,
    "STROKE": 2,
    "UNDO": 3,
    "STROKE_BEGIN": 4,
    "STROKE_APPEND": 5,
    "STROKE_END": 6,
    "CURSOR": 7,
    "HANDSHAKE": 255,
}

# STROKE flag bits
FLAG_SOFT = 1 << 0       # soft (blended) brush vs. hard edge
# CURSOR flag bits
CUR_PRESSING = 1 << 0    # painter is actively laying down a stroke


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def _round(v):
    # JS Math.round: round half toward +Infinity.
    import math
    return math.floor(v + 0.5)


# --- growable little-endian writer -----------------------------------------
class Writer:
    def __init__(self, size=64):
        self.buf = bytearray()

    def u8(self, v):
        self.buf += struct.pack("<B", v & 0xFF)
        return self

    def u16(self, v):
        self.buf += struct.pack("<H", v & 0xFFFF)
        return self

    def u32(self, v):
        self.buf += struct.pack("<I", v & 0xFFFFFFFF)
        return self

    # [u8 length][length x u16 code unit] UTF-16; clamps to NICK_MAX.
    def str(self, s):
        s = (s or "")[:C.NICK_MAX]
        self.buf += struct.pack("<B", len(s) & 0xFF)
        for ch in s:
            self.buf += struct.pack("<H", ord(ch) & 0xFFFF)
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
        chars = []
        for _ in range(length):
            chars.append(chr(self.u16()))
        return "".join(chars)

    def remaining(self):
        return len(self.buf) - self.pos


# --- STROKE_BLOCK (completed stroke) ---------------------------------------
def write_stroke_block(w, s):
    w.u32(s["id"]).u32(s["ownerId"]).u8(s["tool"] & 0xFF).u8(s["color"] & 0xFF) \
        .u8(s["size"] & 0xFF).u8(s["flags"] & 0xFF).u16(len(s["points"]))
    for p in s["points"]:
        w.u16(clamp(_round(p["x"]), 0, C.CANVAS_W)).u16(clamp(_round(p["y"]), 0, C.CANVAS_H))


def read_stroke_block(r):
    sid = r.u32()
    owner_id = r.u32()
    tool = r.u8()
    color = r.u8()
    size = r.u8()
    flags = r.u8()
    n = r.u16()
    points = [None] * n
    for i in range(n):
        points[i] = {"x": r.u16(), "y": r.u16()}
    return {"id": sid, "ownerId": owner_id, "tool": tool, "color": color,
            "size": size, "flags": flags, "points": points}


# ===========================================================================
# Server -> Client encoders
# ===========================================================================
def welcome(your_id, server_tick):
    return (Writer(16).u8(S2C["WELCOME"]).u32(your_id)
            .u16(C.CANVAS_W).u16(C.CANVAS_H).u32(server_tick & 0xFFFFFFFF).done())


def history(strokes):
    w = Writer(4096)
    w.u8(S2C["HISTORY"]).u32(len(strokes) & 0xFFFFFFFF)
    for s in strokes:
        write_stroke_block(w, s)
    return w.done()


def stroke(s):
    w = Writer(256)
    w.u8(S2C["STROKE"])
    write_stroke_block(w, s)
    return w.done()


def stroke_begin(s):
    p0 = s["points"][0] if s["points"] else {"x": 0, "y": 0}
    return (Writer(24).u8(S2C["STROKE_BEGIN"]).u32(s["id"]).u32(s["ownerId"])
            .u8(s["tool"] & 0xFF).u8(s["color"] & 0xFF).u8(s["size"] & 0xFF).u8(s["flags"] & 0xFF)
            .u16(clamp(_round(p0["x"]), 0, C.CANVAS_W)).u16(clamp(_round(p0["y"]), 0, C.CANVAS_H))
            .done())


def stroke_append(sid, pts):
    w = Writer(8 + len(pts) * 4)
    w.u8(S2C["STROKE_APPEND"]).u32(sid & 0xFFFFFFFF).u16(len(pts) & 0xFFFF)
    for p in pts:
        w.u16(clamp(_round(p["x"]), 0, C.CANVAS_W)).u16(clamp(_round(p["y"]), 0, C.CANVAS_H))
    return w.done()


def undo(stroke_id):
    return Writer(5).u8(S2C["UNDO"]).u32(stroke_id & 0xFFFFFFFF).done()


def presence(count):
    return Writer(3).u8(S2C["PRESENCE"]).u16(count & 0xFFFF).done()


def cursors(lst):
    w = Writer(64)
    w.u8(S2C["CURSORS"]).u16(len(lst) & 0xFFFF)
    for c in lst:
        w.u32(c["id"] & 0xFFFFFFFF) \
            .u16(clamp(_round(c["x"]), 0, 65535)) \
            .u16(clamp(_round(c["y"]), 0, 65535)) \
            .u8(CUR_PRESSING if c["pressing"] else 0) \
            .u8(c["color"] & 0xFF) \
            .u8((c.get("tool") or 0) & 0xFF) \
            .str(c.get("name") or "")
    return w.done()


def gallery(cx, cy, half, dur_ms):
    return (Writer(9).u8(S2C["GALLERY"])
            .u16(clamp(_round(cx), 0, 65535))
            .u16(clamp(_round(cy), 0, 65535))
            .u16(clamp(_round(half), 1, 65535))
            .u16(clamp(_round(dur_ms), 0, 65535))
            .done())


def pong(client_ms, server_tick):
    return Writer(9).u8(S2C["PONG"]).u32(client_ms & 0xFFFFFFFF).u32(server_tick & 0xFFFFFFFF).done()


def version_outdated():
    return bytes([S2C["VERSION_OUTDATED"]])


# ===========================================================================
# Client -> Server decoder
# ===========================================================================
def read_points(r, cap):
    n = r.u16()
    if n > cap:
        n = cap
    points = []
    i = 0
    while i < n and r.remaining() >= 4:
        points.append({"x": r.u16(), "y": r.u16()})
        i += 1
    return points


def decode_client(buf):
    if not buf or len(buf) < 1:
        return None
    r = Reader(buf)
    pid = r.u8()
    if pid == C2S["HANDSHAKE"]:
        version = r.u32() if len(buf) >= 5 else 0
        return {"type": "handshake", "version": version}
    elif pid == C2S["SET_NICK"]:
        if len(buf) < 2:
            return {"type": "nick", "name": ""}
        return {"type": "nick", "name": r.str()}
    elif pid == C2S["PING"]:
        client_ms = r.u32() if len(buf) >= 5 else 0
        return {"type": "ping", "clientMs": client_ms}
    elif pid == C2S["STROKE"]:
        if len(buf) < 7:
            return None
        tool = r.u8()
        color = r.u8()
        size = r.u8()
        flags = r.u8()
        points = read_points(r, C.MAX_POINTS)
        return {"type": "stroke", "tool": tool, "color": color,
                "size": size, "flags": flags, "points": points}
    elif pid == C2S["STROKE_BEGIN"]:
        if len(buf) < 9:
            return None
        tool = r.u8()
        color = r.u8()
        size = r.u8()
        flags = r.u8()
        x = r.u16()
        y = r.u16()
        return {"type": "stroke_begin", "tool": tool, "color": color,
                "size": size, "flags": flags, "x": x, "y": y}
    elif pid == C2S["STROKE_APPEND"]:
        if len(buf) < 3:
            return None
        points = read_points(r, C.MAX_POINTS)
        return {"type": "stroke_append", "points": points}
    elif pid == C2S["STROKE_END"]:
        return {"type": "stroke_end"}
    elif pid == C2S["CURSOR"]:
        if len(buf) < 8:
            return None
        x = r.u16()
        y = r.u16()
        flags = r.u8()
        color = r.u8()
        tool = r.u8()
        return {"type": "cursor", "x": x, "y": y,
                "pressing": bool(flags & CUR_PRESSING), "color": color, "tool": tool}
    elif pid == C2S["UNDO"]:
        return {"type": "undo"}
    else:
        return {"type": "unknown", "id": pid}
