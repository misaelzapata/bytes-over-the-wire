"""main.py -- CLASSIC agar.io clone authoritative game server (Python + aiohttp).

Functionally identical to the Node reference (server/index.js):
  - Serves the static client from ../client over HTTP on PORT (default 4100).
  - Accepts binary WebSocket upgrades at "/" (little-endian frames).
  - Runs a fixed 25Hz authoritative simulation (world.py) and speaks the exact
    binary protocol (protocol.py): per-viewport AoI SNAPSHOT every tick, ~1Hz
    LEADERBOARD, PONG on demand, DEATH on last-cell loss.
  - Spawns BOT_COUNT AI blobs so the arena is always alive.

SPEC §12.3 join sequence: HANDSHAKE(version) -> SET_NICK(name) -> WELCOME
(yourId + world dims + serverTick) -> first SNAPSHOT next tick. PING<->PONG.

One HTTP port serves BOTH the static client and the WS upgrade.
"""

import asyncio
import os
import re
import time
import math

from aiohttp import web, WSMsgType

import constants as C
import physics as P
import protocol as proto
from world import World
from bots import BotManager

PORT = int(os.environ.get("PORT") or 4100)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CLIENT_ROOT = os.path.normpath(os.path.join(BASE_DIR, "..", "client"))

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
}

# If a served .js hardcodes an AGAR_WS placeholder endpoint, rewrite it to
# connect back here (parity with the Node reference; the shared client derives
# ws://host itself, so this is a no-op in practice).
_URL_REWRITE_RE = re.compile(r"wss?://[^\"'`]*?AGAR_WS[^\"'`]*")
_URL_REWRITE_REPL = "ws://' + location.host + '/"

# ---------------------------------------------------------------------------
# World + bots
# ---------------------------------------------------------------------------

world = World()
bots = BotManager(world)
bots.spawnAll(C.BOT_COUNT)

# ws -> connection state
#   { id, handshaken, named, seenNames:set, visible:set }
conns = {}


class Conn:
    __slots__ = ("id", "handshaken", "named", "seenNames", "visible")

    def __init__(self):
        self.id = 0
        self.handshaken = False
        self.named = False
        self.seenNames = set()
        self.visible = set()


# ===========================================================================
# Static file serving (+ WebSocket upgrade on the same route)
# ===========================================================================

async def http_handler(request):
    # A WebSocket upgrade arrives as GET / with Upgrade: websocket.
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return await ws_handler(request)

    url_path = request.path.split("?")[0]
    if url_path == "/":
        url_path = "/index.html"
    if url_path == "/favicon.ico":
        return web.Response(status=204)

    file_path = os.path.normpath(os.path.join(CLIENT_ROOT, url_path.lstrip("/")))
    if not (file_path == CLIENT_ROOT or file_path.startswith(CLIENT_ROOT + os.sep)):
        return web.Response(status=403, text="Forbidden")

    try:
        with open(file_path, "rb") as f:
            data = f.read()
    except (FileNotFoundError, IsADirectoryError, PermissionError):
        return web.Response(status=404, text="Not found")

    ext = os.path.splitext(file_path)[1].lower()
    mime = MIME.get(ext, "application/octet-stream")

    if ext == ".js":
        text = data.decode("utf-8")
        if _URL_REWRITE_RE.search(text):
            text = _URL_REWRITE_RE.sub(_URL_REWRITE_REPL, text)
            return web.Response(body=text.encode("utf-8"), content_type="application/javascript", charset="utf-8")

    return web.Response(body=data, headers={"Content-Type": mime})


# ===========================================================================
# WebSocket handling
# ===========================================================================

async def ws_handler(request):
    ws = web.WebSocketResponse(max_msg_size=0)
    await ws.prepare(request)

    conn = Conn()
    conns[ws] = conn

    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                data = msg.data
                m = proto.decode_client(data)
                if m:
                    await handle_client_message(ws, conn, m)
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        if conn.id:
            world.removePlayer(conn.id)
        conns.pop(ws, None)

    return ws


async def send(ws, frame):
    if not ws.closed:
        try:
            await ws.send_bytes(frame)
        except (ConnectionResetError, RuntimeError):
            pass


async def handle_client_message(ws, c, msg):
    t = msg["type"]

    if t == "handshake":
        c.handshaken = True
        if msg["version"] != C.PROTOCOL_VERSION:
            await send(ws, proto.version_outdated())
            await ws.close()
        return

    if t == "nick":
        name = (msg["name"] or "")[: C.NICK_MAX]
        if c.id and c.id in world.players:
            world.players[c.id].name = name
            return
        p = world.addPlayer(name, False)
        c.id = p.id
        c.named = True
        c.seenNames = set()
        c.visible = set()
        await send(ws, proto.welcome(p.id, world.simTick))
        return

    if t == "target":
        p = world.players.get(c.id) if c.id else None
        if p and not p.dead:
            world.setTarget(p, msg["x"], msg["y"])
        return

    if t == "split":
        p = world.players.get(c.id) if c.id else None
        if p and not p.dead:
            world.requestSplit(p)
        return

    if t == "eject":
        p = world.players.get(c.id) if c.id else None
        if p and not p.dead:
            world.requestEject(p)
        return

    if t == "ping":
        await send(ws, proto.pong(msg["clientMs"], world.simTick))
        return

    if t == "respawn":
        p = world.players.get(c.id) if c.id else None
        if p and p.dead:
            world.respawnPlayer(p)
            c.seenNames = set()
            c.visible = set()
            await send(ws, proto.welcome(p.id, world.simTick))
        return


# ===========================================================================
# AoI collection (per viewer)
# ===========================================================================

def collect_aoi(viewer):
    R = max(viewer.sumRadius(), 32)
    half = P.view_half(R)
    cx, cy = viewer.centroid()

    cells = []
    for cell_obj in world.cells.values():
        r = cell_obj.radius
        if abs(cell_obj.x - cx) <= half + r and abs(cell_obj.y - cy) <= half + r:
            cells.append(cell_obj)

    foods = []
    for f in world.foodGrid.query_circle(cx, cy, half + 32):
        if abs(f.x - cx) <= half and abs(f.y - cy) <= half:
            foods.append(f)

    viruses = []
    for v in world.viruses.values():
        r = v.radius
        if abs(v.x - cx) <= half + r and abs(v.y - cy) <= half + r:
            viruses.append(v)

    ejects = []
    for e in world.ejects.values():
        if abs(e.x - cx) <= half + e.radius and abs(e.y - cy) <= half + e.radius:
            ejects.append(e)

    return cells, foods, viruses, ejects, cx, cy, half


def build_snapshot_for(conn, viewer):
    cells_aoi, foods_aoi, viruses_aoi, ejects_aoi, cx, cy, half = collect_aoi(viewer)
    seen_names = conn.seenNames
    visible_owners = set()
    current_ids = set()

    cell_blocks = []
    for cell_obj in cells_aoi:
        current_ids.add(cell_obj.id)
        owner = cell_obj.ownerId
        visible_owners.add(owner)
        flags = 0
        if owner == viewer.id:
            flags |= proto.FLAG_MINE
        if cell_obj.boosting:
            flags |= proto.FLAG_SPLIT
        name = None
        if owner not in seen_names:
            flags |= proto.FLAG_NAME
            seen_names.add(owner)
            pl = world.players.get(owner)
            name = pl.name if pl else ""
        cell_blocks.append({
            "id": cell_obj.id,
            "ownerId": owner,
            "x": cell_obj.x,
            "y": cell_obj.y,
            "size": cell_obj.radius,
            "hue": cell_obj.hue,
            "flags": flags,
            "name": name,
        })
    # Drop owners no longer visible so a re-appearance re-sends the name.
    for o in list(seen_names):
        if o not in visible_owners:
            seen_names.discard(o)

    foods = []
    for f in foods_aoi:
        current_ids.add(f.id)
        foods.append({"id": f.id, "x": f.x, "y": f.y, "hue": f.hue})
    viruses = []
    for v in viruses_aoi:
        current_ids.add(v.id)
        viruses.append({"id": v.id, "x": v.x, "y": v.y, "size": v.radius})
    ejects = []
    for e in ejects_aoi:
        current_ids.add(e.id)
        ejects.append({"id": e.id, "x": e.x, "y": e.y, "hue": e.hue})

    removes = []
    for id in conn.visible:
        if id not in current_ids:
            removes.append(id)
    conn.visible = current_ids

    eats = []
    for ev in world.eatEvents:
        if abs(ev["x"] - cx) <= half and abs(ev["y"] - cy) <= half:
            eats.append(ev)

    return proto.snapshot(world.simTick, eats, cell_blocks, foods, viruses, ejects, removes)


# ===========================================================================
# Broadcast pump (called after each sim step)
# ===========================================================================

async def broadcast_tick():
    tick = world.simTick

    # SNAPSHOT every tick, per viewport.
    for ws, conn in list(conns.items()):
        if not conn.id:
            continue
        viewer = world.players.get(conn.id)
        if not viewer or viewer.dead:
            continue
        await send(ws, build_snapshot_for(conn, viewer))
    world.eatEvents.clear()

    # DEATH -- notify each player whose last cell was eaten this tick.
    if world.deathEvents:
        for d in world.deathEvents:
            for ws, conn in list(conns.items()):
                if conn.id == d["playerId"]:
                    await send(ws, proto.death(d["finalMass"]))
                    break
        world.deathEvents.clear()

    # LEADERBOARD (~1 Hz): top-10 by total mass + per-viewer yourRank.
    if tick % C.LEADERBOARD_EVERY == 0:
        all_rows = world.leaderboardRows()
        top = all_rows[:10]
        rank_by_id = {}
        for i, row in enumerate(all_rows):
            rank_by_id[row["id"]] = i + 1
        for ws, conn in list(conns.items()):
            if not conn.id:
                continue
            r = rank_by_id.get(conn.id, 0)
            your_rank = r if r <= 10 else 0
            await send(ws, proto.leaderboard(top, your_rank))

    # RESYNC safety net (~10s): re-seed name deltas + visibility.
    if tick % C.RESYNC_EVERY == 0:
        for conn in conns.values():
            if not conn.id:
                continue
            conn.seenNames = set()
            conn.visible = set()


# ===========================================================================
# 25Hz loop (accumulator, cap 250ms catch-up)
# ===========================================================================

async def game_loop():
    last_time = time.monotonic() * 1000.0
    accumulator = 0.0
    while True:
        await asyncio.sleep(C.STEP_MS / 1000.0)
        now = time.monotonic() * 1000.0
        accumulator += now - last_time
        last_time = now
        if accumulator > 250:
            accumulator = 250
        while accumulator >= C.STEP_MS:
            world.step(lambda w: bots.update(w))
            await broadcast_tick()
            accumulator -= C.STEP_MS


async def on_startup(app):
    app["game_loop"] = asyncio.create_task(game_loop())


async def on_cleanup(app):
    task = app.get("game_loop")
    if task:
        task.cancel()


def main():
    app = web.Application()
    app.router.add_route("GET", "/{path:.*}", http_handler)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    print(f"agar-clone server listening on http://localhost:{PORT}")
    print(f"WebSocket endpoint: ws://localhost:{PORT}/")
    print(f"Serving client from: {CLIENT_ROOT}")
    web.run_app(app, host="0.0.0.0", port=PORT, print=None)


if __name__ == "__main__":
    main()
