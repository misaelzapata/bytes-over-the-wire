"use strict";

// =============================================================================
// interpolate.js — Client-side state store, snapshot interpolation, and prediction.
//                  Almacen de estado del cliente, interpolacion de snapshots y prediccion.
//
// Key concepts / Conceptos clave:
//   - World object holds all client entity maps (cells, food, viruses, ejects) / El objeto World contiene todos los mapas de entidades del cliente (celulas, comida, virus, eyecciones)
//   - applySnapshot(): merges server snapshots, handles eat FX and removals / applySnapshot(): fusiona snapshots del servidor, maneja efectos de comer y eliminaciones
//   - Own cells use client-side prediction reconciled toward server authority / Las celulas propias usan prediccion del lado del cliente reconciliada hacia la autoridad del servidor
//   - Remote cells interpolate between buffered snapshot positions for smooth rendering / Las celulas remotas interpolan entre posiciones de snapshots almacenados para renderizado suave
//   - Staleness sweep removes entities not refreshed within ~600ms / El barrido de obsolescencia elimina entidades no actualizadas en ~600ms
// =============================================================================

// AGAR-CLONE — client interpolate.js. Authoritative-lite state store: entity maps,
// remote-cell snapshot interpolation (render ~1 snapshot behind), and own-cell
// client-side prediction reconciled to server state (SPEC §11, §14).

const World = {
  selfId: 0,
  worldW: C.WORLD_SIZE,
  worldH: C.WORLD_SIZE,

  cells: new Map(),     // id -> cell render object
  food: new Map(),      // id -> { x, y, hue }
  viruses: new Map(),   // id -> { x, y, size }
  ejects: new Map(),    // id -> { x, y, hue }

  nameByOwner: new Map(),   // ownerId -> nick (name-delta cache)
  seen: new Set(),          // ids present in the most recent snapshot (for pruning)

  leaderboard: [],          // [{ playerId, mass, name }]
  yourRank: 0,

  eatFx: [],                // [{ x, y, r, age }] transient eat pops

  dead: false,
  finalMass: 0,

  // clock sync
  hasClock: false,
  serverTickAtSync: 0,
  clientMsAtSync: 0,
  rtt: 0,

  reset() {
    this.cells.clear();
    this.food.clear();
    this.viruses.clear();
    this.ejects.clear();
    this.nameByOwner.clear();
    this.seen.clear();
    this.leaderboard = [];
    this.yourRank = 0;
    this.eatFx = [];
    this.dead = false;
  },

  // Set of the local player's cell ids (predicted).
  myCells() {
    const out = [];
    for (const c of this.cells.values()) if (c.isMine) out.push(c);
    return out;
  },
};

// ---------------------------------------------------------------------------
// Apply a decoded SNAPSHOT (SPEC §12.2).
// ---------------------------------------------------------------------------
function applySnapshot(msg) {
  const now = performance.now();

  // --- eat FX + explicit removals ---
  for (const e of msg.eats) {
    const eaten = World.cells.get(e.eatenId) || World.food.get(e.eatenId) || World.ejects.get(e.eatenId);
    if (eaten) World.eatFx.push({ x: eaten.rx ?? eaten.x, y: eaten.ry ?? eaten.y, r: eaten.size ? eaten.size : 12, age: 0 });
    World.cells.delete(e.eatenId);
    World.food.delete(e.eatenId);
    World.ejects.delete(e.eatenId);
    World.viruses.delete(e.eatenId);
  }
  for (const id of msg.remove) {
    World.cells.delete(id);
    World.food.delete(id);
    World.viruses.delete(id);
    World.ejects.delete(id);
  }

  // --- cells (interpolated / predicted) ---
  const present = new Set();
  for (const b of msg.cells) {
    present.add(b.id);
    // name-delta cache
    if (b.name != null) World.nameByOwner.set(b.ownerId, b.name);
    const nm = World.nameByOwner.get(b.ownerId) || "";

    let c = World.cells.get(b.id);
    if (!c) {
      c = {
        id: b.id, ownerId: b.ownerId, hue: b.hue, isMine: b.isMine,
        name: nm, isSplitting: b.isSplitting,
        // interpolation samples (remote)
        prevX: b.x, prevY: b.y, prevSize: b.size,
        curX: b.x, curY: b.y, curSize: b.size,
        lastMs: now,
        // render output (filled by tick)
        rx: b.x, ry: b.y, size: b.size,
        // own-cell prediction
        px: b.x, py: b.y, authX: b.x, authY: b.y,
      };
      World.cells.set(b.id, c);
    } else {
      c.prevX = c.curX; c.prevY = c.curY; c.prevSize = c.curSize;
      c.curX = b.x; c.curY = b.y; c.curSize = b.size;
      c.lastMs = now;
      c.hue = b.hue;
      c.isMine = b.isMine;
      c.isSplitting = b.isSplitting;
      c.name = nm;
      // reconcile prediction toward server authority
      c.authX = b.x; c.authY = b.y;
      c.px += (b.x - c.px) * C.RECONCILE;
      c.py += (b.y - c.py) * C.RECONCILE;
    }
  }

  // --- food / virus / eject: absolute list within viewport ---
  for (const f of msg.food) {
    let e = World.food.get(f.id);
    if (!e) World.food.set(f.id, { x: f.x, y: f.y, hue: f.hue, lastMs: now });
    else { e.x = f.x; e.y = f.y; e.hue = f.hue; e.lastMs = now; }
  }
  for (const v of msg.virus) {
    let e = World.viruses.get(v.id);
    if (!e) World.viruses.set(v.id, { x: v.x, y: v.y, size: v.size, rx: v.x, ry: v.y, lastMs: now });
    else { e.px = e.x; e.py = e.y; e.x = v.x; e.y = v.y; e.size = v.size; e.lastMs = now; }
  }
  for (const j of msg.eject) {
    let e = World.ejects.get(j.id);
    if (!e) World.ejects.set(j.id, { x: j.x, y: j.y, hue: j.hue, prevX: j.x, prevY: j.y, lastMs: now });
    else { e.prevX = e.x; e.prevY = e.y; e.x = j.x; e.y = j.y; e.hue = j.hue; e.lastMs = now; }
  }
}

// ---------------------------------------------------------------------------
// Per-frame update: interpolate remote cells, predict own cells (SPEC §3, §11).
// dt in seconds. mouseWorld = { x, y } drift target.
// ---------------------------------------------------------------------------
function tickInterpolation(dt, mouseWorld) {
  const now = performance.now();

  for (const c of World.cells.values()) {
    // size always interpolates smoothly for growth/eat
    const aSize = clamp01((now - c.lastMs) / C.SNAPSHOT_MS);
    c.size = lerp(c.prevSize, c.curSize, aSize);

    if (c.isMine && mouseWorld) {
      // client-side prediction: drift toward the mouse, same law as server.
      const mass = massOfRadius(c.size);
      const dx = mouseWorld.x - c.px;
      const dy = mouseWorld.y - c.py;
      const dist = Math.hypot(dx, dy);
      const step = Math.min(dist, speedOfMass(mass) * dt);
      if (dist > 1e-6) { c.px += (dx / dist) * step; c.py += (dy / dist) * step; }
      // clamp to world border like server
      const r = c.size;
      c.px = clamp(c.px, r, World.worldW - r);
      c.py = clamp(c.py, r, World.worldH - r);
      c.rx = c.px; c.ry = c.py;
    } else {
      // remote cell: interpolate between the two buffered snapshots.
      const a = clamp01((now - c.lastMs) / C.SNAPSHOT_MS);
      c.rx = lerp(c.prevX, c.curX, a);
      c.ry = lerp(c.prevY, c.curY, a);
    }
  }

  // eject drift interpolation
  for (const e of World.ejects.values()) {
    const a = clamp01((now - e.lastMs) / C.SNAPSHOT_MS);
    e.rx = lerp(e.prevX, e.x, a);
    e.ry = lerp(e.prevY, e.y, a);
  }
  // virus drift (shot viruses move)
  for (const v of World.viruses.values()) {
    if (v.px != null) {
      const a = clamp01((now - v.lastMs) / C.SNAPSHOT_MS);
      v.rx = lerp(v.px, v.x, a);
      v.ry = lerp(v.py, v.y, a);
    } else { v.rx = v.x; v.ry = v.y; }
  }

  // age eat FX
  for (let i = World.eatFx.length - 1; i >= 0; i--) {
    World.eatFx[i].age += dt;
    if (World.eatFx[i].age > 0.35) World.eatFx.splice(i, 1);
  }

  // Defensive staleness sweep: full-viewport snapshots arrive every tick, so any
  // entity not refreshed for a while has left the viewport (belt-and-suspenders
  // in case a removal-list entry is ever missed). Own predicted cells refresh on
  // every snapshot too, so this also clears them on death.
  const STALE = 600; // ms (~15 ticks)
  for (const [id, c] of World.cells) if (now - c.lastMs > STALE) World.cells.delete(id);
  for (const [id, e] of World.food) if (now - e.lastMs > STALE) World.food.delete(id);
  for (const [id, e] of World.ejects) if (now - e.lastMs > STALE) World.ejects.delete(id);
  for (const [id, v] of World.viruses) if (now - v.lastMs > STALE) World.viruses.delete(id);
}

// mass-weighted centroid + summed radius of own cells (camera + zoom source).
function ownCentroid() {
  let sx = 0, sy = 0, sm = 0, sr = 0, n = 0;
  for (const c of World.cells.values()) {
    if (!c.isMine) continue;
    const mass = massOfRadius(c.size);
    sx += c.rx * mass; sy += c.ry * mass; sm += mass; sr += c.size; n++;
  }
  if (n === 0) return null;
  return { x: sx / sm, y: sy / sm, R: sr, mass: sm, n };
}

// --- tiny math helpers ---
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
