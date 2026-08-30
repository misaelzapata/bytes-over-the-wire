"""main.py — VANDAL cooperative collaborative-mural server (Python + aiohttp).

Functional port of ../server/index.js.

  - Serves the static client from ../client over HTTP on PORT (default 4504).
  - Accepts binary WebSocket upgrades at "/" (little-endian frames; see
    protocol.py for the documented wire spec).
  - Keeps the authoritative stroke history (mural.py). New joiners get the whole
    mural (HISTORY) plus any in-progress live strokes; every stroke is broadcast
    as BEGIN -> APPEND* -> STROKE(commit).
  - Runs a fixed 20Hz loop for painter-bots, ~20Hz live cursor snapshots,
    ~1Hz PRESENCE, and a periodic coordinated GALLERY fly-through cue.

Join sequence: HANDSHAKE(version) -> SET_NICK(name) -> WELCOME -> HISTORY.
"""

import asyncio
import os
import posixpath
import random
import time
from urllib.parse import unquote, urlsplit

from aiohttp import WSMsgType, web

import constants as C
import protocol as proto
from bots import BotManager
from mural import Mural

PORT = int(os.environ.get("PORT") or 4504)
CLIENT_ROOT = os.path.realpath(os.path.join(os.path.dirname(__file__), "..", "client"))

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
}

# ===========================================================================
# World state
# ===========================================================================
next_id = 1


def alloc_id():
    global next_id
    v = next_id
    next_id += 1
    return v


mural = Mural()
bots = BotManager(alloc_id)
bots.spawn_all(C.BOT_COUNT)

sim_tick = 0

# ws -> connection state dict
conns = {}


def human_count():
    return sum(1 for c in conns.values() if c["named"])


def painter_count():
    return human_count() + bots.count


# ===========================================================================
# Networking helpers
# ===========================================================================
async def send(ws, frame):
    if not ws.closed:
        try:
            await ws.send_bytes(frame)
        except Exception:
            pass


async def broadcast(frame):
    for ws, c in list(conns.items()):
        if c["named"]:
            await send(ws, frame)


# ---- streaming orchestration (shared by humans + bots) --------------------
async def stream_begin(owner_id, meta, x, y):
    s = mural.begin(owner_id, meta, x, y)
    await broadcast(proto.stroke_begin(s))
    return s


async def stream_append(owner_id, meta, pts):
    if not mural.is_open(owner_id):
        return
    remaining = pts
    guard = 0
    while guard < 64 and remaining:
        appended, full = mural.append(owner_id, remaining)
        if appended:
            await broadcast(proto.stroke_append(mural.open[owner_id]["id"], appended))
        remaining = remaining[len(appended):]
        if full and remaining:
            open_stroke = mural.open[owner_id]
            last = open_stroke["points"][-1]
            committed = mural.end(owner_id)
            if committed:
                await broadcast(proto.stroke(committed))
            await stream_begin(owner_id, meta or open_stroke, last["x"], last["y"])
        elif len(appended) == 0:
            break
        guard += 1


async def stream_end(owner_id):
    committed = mural.end(owner_id)
    if committed:
        await broadcast(proto.stroke(committed))


# ===========================================================================
# Client message handling
# ===========================================================================
async def handle_client_message(ws, msg):
    c = conns.get(ws)
    if not c:
        return
    t = msg["type"]

    if t == "handshake":
        c["handshaken"] = True
        if msg["version"] != C.PROTOCOL_VERSION:
            await send(ws, proto.version_outdated())
            await ws.close()

    elif t == "nick":
        c["name"] = (msg.get("name") or "")[:C.NICK_MAX]
        if not c["id"]:
            c["id"] = alloc_id()
        c["named"] = True
        await send(ws, proto.welcome(c["id"], sim_tick))
        await send(ws, proto.history(mural.strokes))
        for open_stroke in mural.open.values():
            await send(ws, proto.stroke_begin(open_stroke))
            if len(open_stroke["points"]) > 1:
                await send(ws, proto.stroke_append(open_stroke["id"], open_stroke["points"][1:]))
        await send(ws, proto.presence(painter_count()))
        await broadcast(proto.presence(painter_count()))

    elif t == "stroke":
        if not c["named"] or not c["id"]:
            return
        stored = mural.commit_stroke(c["id"], msg)
        if stored:
            await broadcast(proto.stroke(stored))

    elif t == "stroke_begin":
        if not c["named"] or not c["id"]:
            return
        if mural.is_open(c["id"]):
            await stream_end(c["id"])
        c["_meta"] = {"tool": msg["tool"], "color": msg["color"],
                      "size": msg["size"], "flags": msg["flags"]}
        await stream_begin(c["id"], c["_meta"], msg["x"], msg["y"])

    elif t == "stroke_append":
        if not c["named"] or not c["id"]:
            return
        if msg.get("points"):
            await stream_append(c["id"], c.get("_meta"), msg["points"])

    elif t == "stroke_end":
        if not c["named"] or not c["id"]:
            return
        await stream_end(c["id"])

    elif t == "cursor":
        if not c["named"] or not c["id"]:
            return
        c["cx"] = msg["x"]
        c["cy"] = msg["y"]
        c["pressing"] = msg["pressing"]
        c["color"] = msg["color"] & 0xFF
        c["tool"] = msg.get("tool", 0) & 0xFF
        c["cursorAt"] = now_ms()

    elif t == "undo":
        if not c["named"] or not c["id"]:
            return
        removed_id = mural.undo_last(c["id"])
        if removed_id:
            await broadcast(proto.undo(removed_id))

    elif t == "ping":
        await send(ws, proto.pong(msg["clientMs"], sim_tick))


def now_ms():
    return int(time.time() * 1000)


# ===========================================================================
# Gallery fly-through
# ===========================================================================
async def trigger_gallery():
    strokes = mural.strokes
    cx = C.CANVAS_W / 2
    cy = C.CANVAS_H / 2
    if strokes:
        s = strokes[len(strokes) - 1 - int(random.random() * min(60, len(strokes)))]
        p = s["points"][len(s["points"]) // 2]
        cx = p["x"]
        cy = p["y"]
    half = 320 + random.random() * 380
    await broadcast(proto.gallery(cx, cy, half, C.GALLERY_MS))


# ===========================================================================
# Live cursor snapshot (who is drawing) — humans (recent) + all bots.
# ===========================================================================
async def broadcast_cursors():
    lst = []
    now = now_ms()
    for c in conns.values():
        if c["named"] and c["id"] and c["cursorAt"] and now - c["cursorAt"] < 2000:
            lst.append({"id": c["id"], "x": c["cx"], "y": c["cy"],
                        "pressing": bool(c["pressing"]), "color": int(c["color"]),
                        "tool": int(c.get("tool", 0)), "name": c["name"]})
    for bc in bots.cursors():
        lst.append(bc)
    if lst:
        await broadcast(proto.cursors(lst))


# ===========================================================================
# 20Hz loop
# ===========================================================================
async def step_once():
    global sim_tick
    sim_tick += 1

    events = bots.update()
    for ev in events:
        if ev["type"] == "begin":
            await stream_begin(ev["ownerId"], ev["raw"], ev["x"], ev["y"])
        elif ev["type"] == "append":
            await stream_append(ev["ownerId"], None, ev["points"])
        elif ev["type"] == "end":
            await stream_end(ev["ownerId"])

    if sim_tick % C.CURSORS_EVERY == 0:
        await broadcast_cursors()
    if sim_tick % C.PRESENCE_EVERY == 0:
        await broadcast(proto.presence(painter_count()))
    if sim_tick % C.GALLERY_EVERY == 0:
        await trigger_gallery()


async def game_loop():
    step_ms = C.STEP_MS
    last = time.monotonic() * 1000
    accumulator = 0.0
    while True:
        await asyncio.sleep(step_ms / 1000.0)
        now = time.monotonic() * 1000
        accumulator += now - last
        last = now
        if accumulator > 250:
            accumulator = 250
        while accumulator >= step_ms:
            await step_once()
            accumulator -= step_ms


# ===========================================================================
# WebSocket handler
# ===========================================================================
async def ws_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    conns[ws] = {
        "id": 0, "name": "", "handshaken": False, "named": False,
        "cx": 0, "cy": 0, "pressing": False, "color": 4, "cursorAt": 0,
        "_meta": None,
    }

    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                try:
                    decoded = proto.decode_client(msg.data)
                except Exception:
                    continue
                if decoded:
                    await handle_client_message(ws, decoded)
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        c = conns.get(ws)
        if c and c["id"] and mural.is_open(c["id"]):
            await stream_end(c["id"])
        conns.pop(ws, None)
        await broadcast(proto.presence(painter_count()))

    return ws


# ===========================================================================
# Static file serving
# ===========================================================================
def serve_static_response(url_path):
    url_path = unquote(url_path.split("?")[0])
    if url_path == "/":
        url_path = "/index.html"
    if url_path == "/favicon.ico":
        return web.Response(status=204)

    # Normalize and confine to CLIENT_ROOT (mirrors the Node path guard).
    rel = posixpath.normpath(url_path).lstrip("/")
    file_path = os.path.normpath(os.path.join(CLIENT_ROOT, rel))
    if not (file_path == CLIENT_ROOT or file_path.startswith(CLIENT_ROOT + os.sep)):
        return web.Response(status=403, text="Forbidden")

    if not os.path.isfile(file_path):
        return web.Response(status=404, text="Not found")

    ext = os.path.splitext(file_path)[1].lower()
    with open(file_path, "rb") as f:
        data = f.read()
    return web.Response(body=data, content_type=MIME.get(ext, "application/octet-stream").split(";")[0],
                        charset="utf-8" if "charset" in MIME.get(ext, "") else None)


async def http_handler(request):
    # One route, one port: WS upgrade at "/" or static file otherwise.
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return await ws_handler(request)
    return serve_static_response(request.raw_path)


async def on_startup(app):
    app["game_loop"] = asyncio.create_task(game_loop())


async def on_cleanup(app):
    app["game_loop"].cancel()


def main():
    app = web.Application()
    app.router.add_route("GET", "/{tail:.*}", http_handler)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    print(f"VANDAL server listening on http://localhost:{PORT}")
    print(f"WebSocket endpoint: ws://localhost:{PORT}/")
    print(f"Serving client from: {CLIENT_ROOT}")
    web.run_app(app, host="0.0.0.0", port=PORT, print=None)


if __name__ == "__main__":
    main()
