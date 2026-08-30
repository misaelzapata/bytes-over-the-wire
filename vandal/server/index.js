"use strict";

// =============================================================================
// index.js — Main server entry point: HTTP static serving, WebSocket relay,
//            and the authoritative game loop for the collaborative mural.
// Punto de entrada principal del servidor: servicio de archivos estaticos HTTP,
// retransmision WebSocket y bucle de juego autoritativo para el mural colaborativo.
//
// Key concepts / Conceptos clave:
//   - Serves client files & accepts binary WebSocket connections / Sirve archivos del cliente y acepta conexiones WebSocket binarias
//   - Maintains authoritative stroke history & broadcasts to all painters / Mantiene el historial autoritativo de trazos y lo transmite a todos los pintores
//   - Runs a fixed 20 Hz simulation loop for bots, cursors & presence / Ejecuta un bucle de simulacion fijo a 20 Hz para bots, cursores y presencia
//   - Join sequence: HANDSHAKE -> SET_NICK -> WELCOME -> HISTORY / Secuencia de union: HANDSHAKE -> SET_NICK -> WELCOME -> HISTORY
// =============================================================================

// ---------------------------------------------------------------------------
// index.js — VANDAL: a cooperative collaborative-mural server (Node + ws).
//
//  - Serves the static client from ../client over HTTP on PORT (default 4504).
//  - Accepts binary WebSocket upgrades at "/" (little-endian frames; see
//    protocol.js for the full documented wire spec — this is the reference impl).
//  - Keeps the authoritative stroke history (mural.js). New joiners are handed
//    the whole mural (HISTORY) plus any in-progress live strokes; every stroke
//    is broadcast to everyone as BEGIN -> APPEND* -> STROKE(commit).
//  - Runs a fixed 20Hz loop for painter-bots, ~20Hz live cursor snapshots,
//    ~1Hz PRESENCE, and a periodic coordinated GALLERY fly-through cue.
//
// Join sequence: HANDSHAKE(version) -> SET_NICK(name) -> WELCOME -> HISTORY.
// ---------------------------------------------------------------------------

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const C = require("./constants.js");

// ---------------------------------------------------------------------------
// Configurable WALL SIZE (env WALL_W / WALL_H, defaults to the constants). This
// is server-authoritative and WIRE-SAFE: the dimensions already travel in the
// WELCOME packet's existing u16 fields, so no byte layout changes. We override
// the shared constants HERE — before the world modules (protocol/mural/bots)
// load — so every world-sized clamp, spawn, pickSpot and reservation uses it.
(function applyWallSize() {
  const w = parseInt(process.env.WALL_W, 10);
  const h = parseInt(process.env.WALL_H, 10);
  if (Number.isFinite(w)) C.CANVAS_W = Math.max(600, Math.min(65535, w));
  if (Number.isFinite(h)) C.CANVAS_H = Math.max(600, Math.min(65535, h));
})();

const proto = require("./protocol.js");
const { Mural } = require("./mural.js");
const { BotManager } = require("./bots.js");

const PORT = Number(process.env.PORT) || 4504;
const CLIENT_ROOT = path.resolve(__dirname, "..", "client");

// ---------------------------------------------------------------------------
// Google Maps key — loaded from the repo-root .env (../../.env) or the env.
// It NEVER leaves the server: only the /streetview proxy below sees it, and the
// client is told only a boolean (MAPS_ENABLED). Not logged, not shipped.
// ---------------------------------------------------------------------------
function loadMapsKey() {
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY.trim();
  try {
    const envPath = path.join(__dirname, "..", "..", ".env");
    const txt = fs.readFileSync(envPath, "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*GOOGLE_MAPS_API_KEY\s*=\s*(.*)\s*$/.exec(line);
      if (m) return m[1].replace(/^["']|["']$/g, "").trim();
    }
  } catch (e) { /* no .env — fall back to paste/upload */ }
  return "";
}
const MAPS_KEY = loadMapsKey();
const MAPS_ENABLED = MAPS_KEY.length > 0;

// ===========================================================================
// Static file serving
// ===========================================================================

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

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
    // index.html: inject the (boolean) Street-View availability flag. The API
    // key itself is never injected — only whether the address lookup works.
    if (ext === ".html") {
      const html = data.toString("utf8").replace(/%%MAPS_ENABLED%%/g, MAPS_ENABLED ? "true" : "false");
      res.writeHead(200, { "Content-Type": MIME[ext], "Cache-Control": "no-cache" });
      res.end(html);
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Street View proxy — GET /streetview?location=<address|lat,lng>&heading=&pitch=
//   &fov=&size=WxH . The server appends the key server-side, checks the Street
// View metadata (so ZERO_RESULTS is reported clearly), then streams the JPEG.
// The Static API accepts an address string directly, so no geocoding call.
// ---------------------------------------------------------------------------
async function serveStreetView(req, res) {
  const u = new URL(req.url, "http://localhost");
  const location = (u.searchParams.get("location") || "").trim();
  // Non-image outcomes reply 200 with a short status body (the client reads it
  // and falls back to paste/upload). Using 200 keeps the browser console clean
  // — a real address just has no live imagery / the key lacks the API.
  if (!MAPS_ENABLED) { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("maps-key-missing"); return; }
  if (!location) { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("missing-location"); return; }

  const size = /^\d{2,4}x\d{2,4}$/.test(u.searchParams.get("size") || "") ? u.searchParams.get("size") : "640x640";
  const fov = clampParam(u.searchParams.get("fov"), 10, 120, 80);
  const heading = u.searchParams.get("heading");
  const pitch = u.searchParams.get("pitch");

  const base = new URLSearchParams({ location, key: MAPS_KEY });
  try {
    // 1) metadata: is there imagery for this location?
    const meta = await fetch("https://maps.googleapis.com/maps/api/streetview/metadata?" + base.toString());
    const mj = await meta.json().catch(() => ({ status: "UNKNOWN" }));
    if (!mj || mj.status !== "OK") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("streetview-" + ((mj && mj.status) || "unavailable").toLowerCase());
      return;
    }
    // 2) the panorama image
    const img = new URLSearchParams({ location, size, fov: String(fov), key: MAPS_KEY });
    if (heading !== null && heading !== "") img.set("heading", clampParam(heading, 0, 360, 0).toString());
    if (pitch !== null && pitch !== "") img.set("pitch", clampParam(pitch, -90, 90, 0).toString());
    const r = await fetch("https://maps.googleapis.com/maps/api/streetview?" + img.toString());
    const ct = r.headers.get("content-type") || "";
    if (!r.ok || !ct.startsWith("image")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("streetview-error");
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-store" });
    res.end(buf);
  } catch (e) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("streetview-fetch-failed");
  }
}
function clampParam(v, lo, hi, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return n < lo ? lo : n > hi ? hi : n;
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.split("?")[0] === "/streetview") { serveStreetView(req, res); return; }
  serveStatic(req, res);
});

// ===========================================================================
// World state
// ===========================================================================

let nextId = 1;
const allocId = () => nextId++;

const mural = new Mural();
const bots = new BotManager(allocId);
bots.spawnAll(C.BOT_COUNT);

let simTick = 0;

// ws -> connection state
const conns = new Map();

function humanCount() {
  let n = 0;
  for (const c of conns.values()) if (c.named) n++;
  return n;
}
function painterCount() {
  return humanCount() + bots.count;
}

// ===========================================================================
// WebSocket handling
// ===========================================================================

const wss = new WebSocketServer({ server, path: "/" });

wss.on("connection", (ws) => {
  ws.binaryType = "arraybuffer";
  conns.set(ws, {
    id: 0,
    name: "",
    handshaken: false,
    named: false,
    cx: 0,
    cy: 0,
    pressing: false,
    color: 4,
    tool: 0,
    cursorAt: 0,
  });

  ws.on("message", (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let msg;
    try {
      msg = proto.decodeClient(buf);
    } catch (e) {
      return;
    }
    if (msg) handleClientMessage(ws, msg);
  });

  ws.on("close", () => {
    const c = conns.get(ws);
    if (c && c.id && mural.isOpen(c.id)) streamEnd(c.id); // finalize a dropped live stroke
    conns.delete(ws);
    broadcast(proto.presence(painterCount()));
  });

  ws.on("error", () => {
    /* close handler cleans up */
  });
});

function send(ws, frame) {
  if (ws.readyState === ws.OPEN) ws.send(frame);
}

function broadcast(frame) {
  for (const [ws, c] of conns) {
    if (c.named) send(ws, frame);
  }
}

// ---- streaming orchestration (shared by humans + bots) --------------------
function streamBegin(ownerId, meta, x, y) {
  const s = mural.begin(ownerId, meta, x, y);
  broadcast(proto.strokeBegin(s));
  return s;
}

function streamAppend(ownerId, meta, pts) {
  if (!mural.isOpen(ownerId)) return;
  let remaining = pts;
  // Auto-split when a single live stroke hits the per-stroke cap, so a long
  // continuous drag never "cuts off": commit the full record, then reopen from
  // its last point to keep the line visually unbroken.
  for (let guard = 0; guard < 64 && remaining.length; guard++) {
    const { appended, full } = mural.append(ownerId, remaining);
    if (appended.length) broadcast(proto.strokeAppend(mural.open.get(ownerId).id, appended));
    remaining = remaining.slice(appended.length);
    if (full && remaining.length) {
      const open = mural.open.get(ownerId);
      const last = open.points[open.points.length - 1];
      const committed = mural.end(ownerId);
      if (committed) broadcast(proto.stroke(committed));
      streamBegin(ownerId, meta || open, last.x, last.y);
    } else if (appended.length === 0) {
      break;
    }
  }
}

function streamEnd(ownerId) {
  const committed = mural.end(ownerId);
  if (committed) broadcast(proto.stroke(committed));
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
      c.name = (msg.name || "").slice(0, C.NICK_MAX);
      if (!c.id) c.id = allocId();
      c.named = true;
      send(ws, proto.welcome(c.id, simTick));
      send(ws, proto.history(mural.strokes));
      // Replay any in-progress live strokes so a joiner sees them mid-paint.
      for (const open of mural.open.values()) {
        send(ws, proto.strokeBegin(open));
        if (open.points.length > 1) send(ws, proto.strokeAppend(open.id, open.points.slice(1)));
      }
      send(ws, proto.presence(painterCount()));
      broadcast(proto.presence(painterCount()));
      break;
    }

    // one-shot commit (shapes + eraser)
    case "stroke": {
      if (!c.named || !c.id) break;
      const stored = mural.commitStroke(c.id, msg);
      if (stored) broadcast(proto.stroke(stored));
      break;
    }

    // live streaming (brush + spray)
    case "stroke_begin": {
      if (!c.named || !c.id) break;
      if (mural.isOpen(c.id)) streamEnd(c.id); // never leave a dangling stroke
      c._meta = { tool: msg.tool, color: msg.color, size: msg.size, flags: msg.flags };
      streamBegin(c.id, c._meta, msg.x, msg.y);
      break;
    }
    case "stroke_append": {
      if (!c.named || !c.id) break;
      if (msg.points && msg.points.length) streamAppend(c.id, c._meta, msg.points);
      break;
    }
    case "stroke_end": {
      if (!c.named || !c.id) break;
      streamEnd(c.id);
      break;
    }

    case "cursor": {
      if (!c.named || !c.id) break;
      c.cx = msg.x;
      c.cy = msg.y;
      c.pressing = msg.pressing;
      c.color = msg.color & 0xff;
      c.tool = msg.tool & 0xff;
      c.cursorAt = Date.now();
      break;
    }

    case "undo": {
      if (!c.named || !c.id) break;
      const removedId = mural.undoLast(c.id);
      if (removedId) broadcast(proto.undo(removedId));
      break;
    }

    case "ping": {
      send(ws, proto.pong(msg.clientMs, simTick));
      break;
    }

    default:
      break;
  }
}

// ===========================================================================
// Live cursor snapshot (who is drawing) — humans (recent) + all bots.
// ===========================================================================

function broadcastCursors() {
  const list = [];
  const now = Date.now();
  for (const c of conns.values()) {
    if (c.named && c.id && c.cursorAt && now - c.cursorAt < 2000) {
      list.push({ id: c.id, x: c.cx, y: c.cy, pressing: !!c.pressing, color: c.color | 0, tool: c.tool | 0, name: c.name });
    }
  }
  for (const bc of bots.cursors()) list.push(bc);
  if (list.length) broadcast(proto.cursors(list));
}

// ===========================================================================
// 20Hz loop (accumulator, cap 250ms catch-up)
// ===========================================================================

function stepOnce() {
  simTick++;

  // Painter bots co-create graffiti (tags, throw-ups, the Banksy piece),
  // streamed like humans; shapes arrive as one-shot commits.
  const events = bots.update();
  for (const ev of events) {
    if (ev.type === "begin") streamBegin(ev.ownerId, ev.raw, ev.x, ev.y);
    else if (ev.type === "append") streamAppend(ev.ownerId, null, ev.points);
    else if (ev.type === "end") streamEnd(ev.ownerId);
    else if (ev.type === "oneshot") {
      const stored = mural.commitStroke(ev.ownerId, ev.raw);
      if (stored) broadcast(proto.stroke(stored));
    }
  }

  if (simTick % C.CURSORS_EVERY === 0) broadcastCursors();
  if (simTick % C.PRESENCE_EVERY === 0) broadcast(proto.presence(painterCount()));
}

let lastTime = Date.now();
let accumulator = 0;

setInterval(() => {
  const now = Date.now();
  accumulator += now - lastTime;
  lastTime = now;
  // Clamp to a SINGLE step so a stall never fires several stepOnce() in one turn:
  // bursts would flush multiple cursor/append packets together and defeat the
  // client's render-delay jitter buffer (collapsing it back to a metronome).
  if (accumulator > C.STEP_MS) accumulator = C.STEP_MS;
  while (accumulator >= C.STEP_MS) {
    stepOnce();
    accumulator -= C.STEP_MS;
  }
}, C.STEP_MS);

server.listen(PORT, () => {
  console.log(`VANDAL server listening on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/`);
  console.log(`Serving client from: ${CLIENT_ROOT}`);
  console.log(`Wall size: ${C.CANVAS_W} x ${C.CANVAS_H}  (Street View lookup: ${MAPS_ENABLED ? "on" : "off"})`);
});
