"use strict";

// =============================================================================
// index.js — Main entry point: HTTP static server + WebSocket game server.
//            Punto de entrada principal: servidor HTTP estatico + servidor de juego WebSocket.
//
// Key concepts / Conceptos clave:
//   - Serves the client via HTTP and upgrades to binary WebSocket at "/" / Sirve el cliente por HTTP y actualiza a WebSocket binario en "/"
//   - Runs a fixed 25 Hz authoritative game loop (world.step) / Ejecuta un bucle de juego autoritativo fijo a 25 Hz (world.step)
//   - Manages join sequence: HANDSHAKE -> SET_NICK -> WELCOME / Gestiona secuencia de union: HANDSHAKE -> SET_NICK -> WELCOME
//   - Broadcasts per-viewport AoI snapshots, leaderboard, death and pong packets / Transmite snapshots AoI por viewport, tabla de lideres, muerte y paquetes pong
//   - Spawns AI bots so the arena always has activity / Genera bots IA para que la arena siempre tenga actividad
// =============================================================================

// ---------------------------------------------------------------------------
// index.js — CLASSIC agar.io clone authoritative game server (Node + ws).
//
//  - Serves the static client from ../client over HTTP on PORT (default 4100).
//  - Rewrites a client WS-URL placeholder so it connects back to this host.
//  - Accepts binary WebSocket upgrades at "/" (little-endian frames).
//  - Runs a fixed 25Hz authoritative simulation (world.js) and speaks the exact
//    binary protocol (protocol.js): per-viewport AoI SNAPSHOT every tick, ~1Hz
//    LEADERBOARD, PONG on demand, DEATH on last-cell loss.
//  - Spawns BOT_COUNT AI blobs so the arena is always alive.
//
// SPEC §12.3 join sequence: HANDSHAKE(version) -> SET_NICK(name) -> WELCOME
// (yourId + world dims + serverTick) -> first SNAPSHOT next tick. PING<->PONG.
// ---------------------------------------------------------------------------

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const C = require("./constants.js");
const P = require("./physics.js");
const proto = require("./protocol.js");
const { World } = require("./world.js");
const { BotManager } = require("./bots.js");

const PORT = Number(process.env.PORT) || 4100;
const CLIENT_ROOT = path.resolve(__dirname, "..", "client");

// ===========================================================================
// Static file serving (+ WebSocket URL rewrite)
// ===========================================================================

const MIME = {
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
};

// If a served .js hardcodes an AGAR_WS placeholder endpoint, rewrite it to
// connect back here. The reference client is expected to derive ws://host itself.
const URL_REWRITES = [
  [/wss?:\/\/[^"'`]*?AGAR_WS[^"'`]*/g, "ws://' + location.host + '/"],
];

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  if (urlPath === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  const filePath = path.normalize(path.join(CLIENT_ROOT, urlPath));
  if (!filePath.startsWith(CLIENT_ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";
    if (ext === ".js") {
      let text = data.toString("utf8");
      let changed = false;
      for (const [re, repl] of URL_REWRITES) {
        if (re.test(text)) {
          text = text.replace(re, repl);
          changed = true;
        }
      }
      if (changed) {
        res.writeHead(200, { "Content-Type": mime });
        res.end(text);
        return;
      }
    }
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

// ===========================================================================
// World + bots
// ===========================================================================

const world = new World();
const bots = new BotManager(world);
bots.spawnAll(C.BOT_COUNT);

// ws -> connection state
// { id, handshaken, named, seenNames:Set<ownerId>, visible:Set<entityId> }
const conns = new Map();

// ===========================================================================
// WebSocket handling
// ===========================================================================

const wss = new WebSocketServer({ server, path: "/" });

wss.on("connection", (ws) => {
  ws.binaryType = "arraybuffer";
  conns.set(ws, {
    id: 0,
    handshaken: false,
    named: false,
    seenNames: new Set(),
    visible: new Set(),
  });

  ws.on("message", (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let msg;
    try {
      msg = proto.decodeClient(buf);
    } catch (e) {
      return;
    }
    if (!msg) return;
    handleClientMessage(ws, msg);
  });

  ws.on("close", () => {
    const c = conns.get(ws);
    if (c && c.id) world.removePlayer(c.id);
    conns.delete(ws);
  });

  ws.on("error", () => {
    /* close handler cleans up */
  });
});

function send(ws, frame) {
  if (ws.readyState === ws.OPEN) ws.send(frame);
}

function handleClientMessage(ws, msg) {
  const c = conns.get(ws);
  if (!c) return;

  switch (msg.type) {
    case "handshake": {
      c.handshaken = true;
      if (msg.version !== C.PROTOCOL_VERSION) {
        send(ws, proto.versionOutdated());
        ws.close();
      }
      break;
    }

    case "nick": {
      const name = (msg.name || "").slice(0, C.NICK_MAX);
      if (c.id && world.players.has(c.id)) {
        world.players.get(c.id).name = name; // re-nick existing player
        break;
      }
      const p = world.addPlayer(name, false);
      c.id = p.id;
      c.named = true;
      c.seenNames = new Set();
      c.visible = new Set();
      send(ws, proto.welcome(p.id, world.simTick));
      break;
    }

    case "target": {
      const p = c.id ? world.players.get(c.id) : null;
      if (p && !p.dead) world.setTarget(p, msg.x, msg.y);
      break;
    }

    case "split": {
      const p = c.id ? world.players.get(c.id) : null;
      if (p && !p.dead) world.requestSplit(p);
      break;
    }

    case "eject": {
      const p = c.id ? world.players.get(c.id) : null;
      if (p && !p.dead) world.requestEject(p);
      break;
    }

    case "ping": {
      send(ws, proto.pong(msg.clientMs, world.simTick));
      break;
    }

    case "respawn": {
      const p = c.id ? world.players.get(c.id) : null;
      if (p && p.dead) {
        world.respawnPlayer(p);
        c.seenNames = new Set();
        c.visible = new Set();
        send(ws, proto.welcome(p.id, world.simTick));
      }
      break;
    }

    default:
      break;
  }
}

// ===========================================================================
// AoI collection (per viewer, from the world's broad-phase grids)
// ===========================================================================

// Player cells can be very large, so scan them (and the small virus/eject sets)
// linearly; only the ~1500 food pellets use the spatial grid.
function collectAoI(viewer) {
  const R = Math.max(viewer.sumRadius(), 32);
  const half = P.viewHalf(R);
  const ctr = viewer.centroid();
  const cx = ctr.x;
  const cy = ctr.y;

  const cells = [];
  for (const cellObj of world.cells.values()) {
    const r = cellObj.radius;
    if (Math.abs(cellObj.x - cx) <= half + r && Math.abs(cellObj.y - cy) <= half + r) {
      cells.push(cellObj);
    }
  }

  const foods = [];
  for (const cand of world.foodGrid.queryCircle(cx, cy, half + 32)) {
    const f = cand.ref;
    if (Math.abs(f.x - cx) <= half && Math.abs(f.y - cy) <= half) foods.push(f);
  }

  const viruses = [];
  for (const v of world.viruses.values()) {
    const r = v.radius;
    if (Math.abs(v.x - cx) <= half + r && Math.abs(v.y - cy) <= half + r) viruses.push(v);
  }

  const ejects = [];
  for (const e of world.ejects.values()) {
    if (Math.abs(e.x - cx) <= half + e.radius && Math.abs(e.y - cy) <= half + e.radius) {
      ejects.push(e);
    }
  }

  return { cells, foods, viruses, ejects, cx, cy, half };
}

function buildSnapshotFor(conn, viewer) {
  const aoi = collectAoI(viewer);
  const seenNames = conn.seenNames;
  const visibleOwners = new Set();
  const currentIds = new Set();

  const cellBlocks = [];
  for (const cellObj of aoi.cells) {
    currentIds.add(cellObj.id);
    const owner = cellObj.ownerId;
    visibleOwners.add(owner);
    let flags = 0;
    if (owner === viewer.id) flags |= proto.FLAG_MINE;
    if (cellObj.boosting) flags |= proto.FLAG_SPLIT;
    let name = null;
    if (!seenNames.has(owner)) {
      flags |= proto.FLAG_NAME;
      seenNames.add(owner);
      const pl = world.players.get(owner);
      name = pl ? pl.name : "";
    }
    cellBlocks.push({
      id: cellObj.id,
      ownerId: owner,
      x: cellObj.x,
      y: cellObj.y,
      size: cellObj.radius,
      hue: cellObj.hue,
      flags,
      name,
    });
  }
  // Drop owners no longer visible so a re-appearance re-sends the name.
  for (const o of seenNames) if (!visibleOwners.has(o)) seenNames.delete(o);

  const foods = [];
  for (const f of aoi.foods) {
    currentIds.add(f.id);
    foods.push({ id: f.id, x: f.x, y: f.y, hue: f.hue });
  }
  const viruses = [];
  for (const v of aoi.viruses) {
    currentIds.add(v.id);
    viruses.push({ id: v.id, x: v.x, y: v.y, size: v.radius });
  }
  const ejects = [];
  for (const e of aoi.ejects) {
    currentIds.add(e.id);
    ejects.push({ id: e.id, x: e.x, y: e.y, hue: e.hue });
  }

  // Removals: previously-visible ids that are gone or left the viewport.
  const removes = [];
  for (const id of conn.visible) if (!currentIds.has(id)) removes.push(id);
  conn.visible = currentIds;

  // Eat FX events near this viewport (small volume; filtered by position).
  const eats = [];
  for (const ev of world.eatEvents) {
    if (Math.abs(ev.x - aoi.cx) <= aoi.half && Math.abs(ev.y - aoi.cy) <= aoi.half) {
      eats.push(ev);
    }
  }

  return proto.snapshot(world.simTick, eats, cellBlocks, foods, viruses, ejects, removes);
}

// ===========================================================================
// Broadcast pump (called after each sim step)
// ===========================================================================

function broadcastTick() {
  const tick = world.simTick;

  // SNAPSHOT every tick, per viewport.
  for (const [ws, conn] of conns) {
    if (!conn.id) continue;
    const viewer = world.players.get(conn.id);
    if (!viewer || viewer.dead) continue;
    send(ws, buildSnapshotFor(conn, viewer));
  }
  world.eatEvents.length = 0;

  // DEATH — notify each player whose last cell was eaten this tick.
  if (world.deathEvents.length) {
    for (const d of world.deathEvents) {
      for (const [ws, conn] of conns) {
        if (conn.id === d.playerId) {
          send(ws, proto.death(d.finalMass));
          break;
        }
      }
    }
    world.deathEvents.length = 0;
  }

  // LEADERBOARD (~1 Hz): top-10 by total mass + per-viewer yourRank.
  if (tick % C.LEADERBOARD_EVERY === 0) {
    const allRows = world.leaderboardRows();
    const top = allRows.slice(0, 10);
    const rankById = new Map();
    for (let i = 0; i < allRows.length; i++) rankById.set(allRows[i].id, i + 1);
    for (const [ws, conn] of conns) {
      if (!conn.id) continue;
      const r = rankById.get(conn.id) || 0;
      const yourRank = r <= 10 ? r : 0; // 0 = outside the top-10
      send(ws, proto.leaderboard(top, yourRank));
    }
  }

  // RESYNC safety net (~10s): re-seed name deltas + visibility so a client that
  // dropped a snapshot recovers cleanly on the next tick.
  if (tick % C.RESYNC_EVERY === 0) {
    for (const conn of conns.values()) {
      if (!conn.id) continue;
      conn.seenNames = new Set();
      conn.visible = new Set();
    }
  }
}

// ===========================================================================
// 25Hz loop (accumulator, cap 250ms catch-up)
// ===========================================================================

let lastTime = Date.now();
let accumulator = 0;

setInterval(() => {
  const now = Date.now();
  accumulator += now - lastTime;
  lastTime = now;
  if (accumulator > 250) accumulator = 250;
  while (accumulator >= C.STEP_MS) {
    world.step((w) => bots.update(w));
    broadcastTick();
    accumulator -= C.STEP_MS;
  }
}, C.STEP_MS);

server.listen(PORT, () => {
  console.log(`agar-clone server listening on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/`);
  console.log(`Serving client from: ${CLIENT_ROOT}`);
});
