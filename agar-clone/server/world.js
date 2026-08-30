"use strict";

// =============================================================================
// world.js — Authoritative game simulation: all server-side game logic.
//            Simulacion autoritativa del juego: toda la logica del juego en el servidor.
//
// Key concepts / Conceptos clave:
//   - Owns entity maps (players, cells, food, viruses, ejects) / Posee los mapas de entidades (jugadores, celulas, comida, virus, eyecciones)
//   - Executes the ordered 25 Hz tick: input -> integrate -> merge -> eat -> decay / Ejecuta el tick ordenado a 25 Hz: entrada -> integrar -> fusionar -> comer -> decaer
//   - Handles split, eject, virus pop/shoot mechanics / Maneja mecanicas de division, eyeccion, explosion/disparo de virus
//   - Produces event queues (eats, deaths) consumed by index.js for broadcasting / Produce colas de eventos (comidas, muertes) consumidas por index.js para transmision
//   - Manages safe spawning, food/virus replenishment and mass decay / Gestiona spawn seguro, reposicion de comida/virus y decaimiento de masa
// =============================================================================

// ---------------------------------------------------------------------------
// world.js — the authoritative simulation.
//
// Owns the entity maps (players, cells, food, viruses, ejects), the ordered
// 25Hz step(), and the event queues (eats, deaths) that index.js drains into
// wire packets each snapshot. Every mechanic from SPEC §3–§10 lives here.
//
// SPEC §11 tick order:
//   1 simTick++            6 eat pass (cells eat cells/food/eject; virus pop)
//   2 update bots          7 food replenish; virus replenish
//   3 apply queued input   8 mass decay
//   4 integrate entities   9 cull dead players
//   5 own-cell merge/coll  (broadcast handled by index.js)
// ---------------------------------------------------------------------------

const C = require("./constants.js");
const P = require("./physics.js");
const { PlayerCell, Food, Virus, EjectedMass } = require("./cell.js");
const Player = require("./player.js");
const { Grid } = require("./aoi.js");

let nextId = 1;
function allocId() {
  const id = nextId++;
  if (nextId > 0xffffffff) nextId = 1;
  return id;
}

const DT = 1 / C.TICK_HZ;

class World {
  constructor() {
    this.simTick = 0;
    this.players = new Map(); // playerId -> Player
    this.cells = new Map(); // cellId -> PlayerCell
    this.food = new Map(); // id -> Food
    this.viruses = new Map(); // id -> Virus
    this.ejects = new Map(); // id -> EjectedMass

    // event queues drained by index.js each snapshot
    this.eatEvents = []; // { eaterId, eatenId, x, y }
    this.deathEvents = []; // { playerId, finalMass }

    // broad-phase grids, rebuilt each step and reused by index.js for AoI.
    this.cellGrid = new Grid();
    this.foodGrid = new Grid();
    this.virusGrid = new Grid();
    this.ejectGrid = new Grid();

    this.seedFood();
    this.seedViruses();
    this.rebuildGrids(); // populate grids so bots have a broad-phase on tick 1
  }

  // --- spawning -----------------------------------------------------------

  randomPos(pad = 100) {
    return {
      x: pad + Math.random() * (C.WORLD_SIZE - 2 * pad),
      y: pad + Math.random() * (C.WORLD_SIZE - 2 * pad),
    };
  }

  // A spawn point far from any BIGGER player cell (so fresh spawns aren't free food).
  safeSpawn() {
    const spawnR = P.radius(C.SPAWN_MASS);
    const safe = 700;
    const safe2 = safe * safe;
    for (let attempt = 0; attempt < 24; attempt++) {
      const pos = this.randomPos(200);
      let ok = true;
      for (const c of this.cells.values()) {
        if (c.mass <= C.SPAWN_MASS * C.EAT_RATIO) continue; // only avoid threats
        const dx = c.x - pos.x;
        const dy = c.y - pos.y;
        if (dx * dx + dy * dy < safe2) {
          ok = false;
          break;
        }
      }
      if (ok) return pos;
    }
    return this.randomPos(200);
  }

  addPlayer(name, isBot) {
    const id = allocId();
    const p = new Player(id, name, isBot);
    this.players.set(id, p);
    this.spawnPlayer(p);
    return p;
  }

  // Give a player a single fresh spawn cell and clear death state.
  spawnPlayer(p) {
    const pos = this.safeSpawn();
    p.dead = false;
    p.targetX = pos.x;
    p.targetY = pos.y;
    const c = this.newCell(p.id, pos.x, pos.y, C.SPAWN_MASS, p.hue);
    p.cells.push(c);
  }

  respawnPlayer(p) {
    // remove any leftover cells first
    for (const c of p.cells) this.cells.delete(c.id);
    p.cells.length = 0;
    this.spawnPlayer(p);
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    for (const c of p.cells) this.cells.delete(c.id);
    this.players.delete(id);
  }

  newCell(ownerId, x, y, mass, hue) {
    const c = new PlayerCell(allocId(), ownerId, x, y, mass, hue, this.simTick);
    this.cells.set(c.id, c);
    return c;
  }

  // Remove one player cell; if it was the owner's last, the player dies.
  removeCell(cell) {
    if (!this.cells.has(cell.id)) return;
    this.cells.delete(cell.id);
    const p = this.players.get(cell.ownerId);
    if (!p) return;
    const i = p.cells.indexOf(cell);
    if (i >= 0) p.cells.splice(i, 1);
    if (p.cells.length === 0 && !p.dead) {
      p.dead = true;
      this.deathEvents.push({ playerId: p.id, finalMass: Math.round(p.finalMass) });
    }
  }

  seedFood() {
    while (this.food.size < C.FOOD_CAP) this.spawnFood();
  }
  spawnFood() {
    const pos = this.randomPos(20);
    const f = new Food(allocId(), pos.x, pos.y, (Math.random() * 256) | 0);
    this.food.set(f.id, f);
  }
  seedViruses() {
    while (this.viruses.size < C.VIRUS_MIN) this.spawnVirus();
  }
  spawnVirus() {
    const pos = this.randomPos(300);
    const v = new Virus(allocId(), pos.x, pos.y);
    this.viruses.set(v.id, v);
  }

  // --- input (humans + bots share this path) ------------------------------

  setTarget(p, x, y) {
    if (p.dead) return;
    p.targetX = P.clamp(x, 0, C.WORLD_SIZE);
    p.targetY = P.clamp(y, 0, C.WORLD_SIZE);
  }
  requestSplit(p) {
    if (!p.dead) p.queueSplit = true;
  }
  requestEject(p) {
    if (!p.dead) p.queueEject = true;
  }

  // --- main tick ----------------------------------------------------------

  step(updateBots) {
    this.simTick++;

    // 2 — bots register their inputs through the same setTarget/requestX path
    if (updateBots) updateBots(this);

    // 3 — apply queued one-shot actions
    for (const p of this.players.values()) {
      if (p.dead) continue;
      if (p.queueSplit) this.doSplit(p);
      if (p.queueEject) this.doEject(p);
      p.queueSplit = false;
      p.queueEject = false;
    }

    // 4 — integrate all moving entities
    this.integrate();

    // rebuild broad-phase grids from post-move positions (reused by AoI too)
    this.rebuildGrids();

    // 5 — own-cell collision + merge
    this.resolveOwnCells();

    // 6 — eat pass (feeds first, then cells consume food/eject/virus/cells)
    this.feedViruses();
    this.eatPass();

    // 7 — replenishment
    if (this.simTick % C.FOOD_SPAWN_TICKS === 0) {
      let budget = C.FOOD_SPAWN_BATCH;
      while (budget-- > 0 && this.food.size < C.FOOD_CAP) this.spawnFood();
    }
    while (this.viruses.size < C.VIRUS_MIN) this.spawnVirus();

    // 8 — mass decay
    this.decay();

    // record live total-mass for the death card
    for (const p of this.players.values()) {
      if (!p.dead) p.finalMass = p.totalMass();
    }
  }

  integrate() {
    // player cells: mouse-drift + momentum engine + border clamp
    for (const c of this.cells.values()) {
      const p = this.players.get(c.ownerId);
      const tx = p ? p.targetX : c.x;
      const ty = p ? p.targetY : c.y;
      const dx = tx - c.x;
      const dy = ty - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1e-6) {
        const step = Math.min(dist, P.speed(c.mass) * DT);
        c.x += (dx / dist) * step;
        c.y += (dy / dist) * step;
      }
      // momentum engine (split/eject/pop impulse), decayed each tick
      c.x += c.mx * DT;
      c.y += c.my * DT;
      c.mx *= C.MOVEENGINE_DECAY;
      c.my *= C.MOVEENGINE_DECAY;
      this.borderClamp(c);
    }

    // ejected pellets: coast on their engine, then rest (still eatable)
    for (const e of this.ejects.values()) {
      if (e.mx !== 0 || e.my !== 0) {
        e.x += e.mx * DT;
        e.y += e.my * DT;
        e.mx *= C.MOVEENGINE_DECAY;
        e.my *= C.MOVEENGINE_DECAY;
        if (Math.hypot(e.mx, e.my) < 5) {
          e.mx = 0;
          e.my = 0;
        }
        this.borderClamp(e);
      }
    }

    // shot viruses coast until they settle
    for (const v of this.viruses.values()) {
      if (v.mx !== 0 || v.my !== 0) {
        v.x += v.mx * DT;
        v.y += v.my * DT;
        v.mx *= C.MOVEENGINE_DECAY;
        v.my *= C.MOVEENGINE_DECAY;
        if (Math.hypot(v.mx, v.my) < 5) {
          v.mx = 0;
          v.my = 0;
        }
        this.borderClamp(v);
      }
    }
  }

  borderClamp(e) {
    const r = e.radius;
    e.x = P.clamp(e.x, r, C.WORLD_SIZE - r);
    e.y = P.clamp(e.y, r, C.WORLD_SIZE - r);
  }

  rebuildGrids() {
    this.cellGrid.clear();
    for (const c of this.cells.values()) this.cellGrid.insert(c.x, c.y, c);
    this.foodGrid.clear();
    for (const f of this.food.values()) this.foodGrid.insert(f.x, f.y, f);
    this.virusGrid.clear();
    for (const v of this.viruses.values()) this.virusGrid.insert(v.x, v.y, v);
    this.ejectGrid.clear();
    for (const e of this.ejects.values()) this.ejectGrid.insert(e.x, e.y, e);
  }

  // --- own-cell collision + merge (SPEC §7) -------------------------------

  mergeable(cell) {
    if (cell.boosting) return false;
    return this.simTick - cell.bornTick >= P.recombineTicks(cell.mass);
  }

  resolveOwnCells() {
    const merges = []; // { big, small }
    for (const p of this.players.values()) {
      const cs = p.cells;
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          const a = cs[i];
          const b = cs[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d = Math.hypot(dx, dy);
          const bothMerge = this.mergeable(a) && this.mergeable(b);
          if (bothMerge) {
            // absorb the smaller when it overlaps past the larger's core
            if (d < Math.max(a.radius, b.radius)) {
              const big = a.mass >= b.mass ? a : b;
              const small = big === a ? b : a;
              merges.push({ big, small });
            }
          } else {
            // resist overlap: push apart so they can't stack past rA+rB
            const rsum = a.radius + b.radius;
            if (d < rsum) {
              if (d < 1e-6) {
                dx = 1;
                dy = 0;
                d = 1;
              }
              const push = (rsum - d) / 2;
              const nx = dx / d;
              const ny = dy / d;
              a.x -= nx * push;
              a.y -= ny * push;
              b.x += nx * push;
              b.y += ny * push;
              this.borderClamp(a);
              this.borderClamp(b);
            }
          }
        }
      }
    }
    for (const m of merges) {
      if (!this.cells.has(m.big.id) || !this.cells.has(m.small.id)) continue;
      m.big.mass += m.small.mass;
      this.removeCell(m.small);
    }
  }

  // --- eat pass (SPEC §4,§5,§8,§9) ----------------------------------------

  // Ejected pellets absorbed by an overlapping virus; 7 feeds => shoot a virus.
  feedViruses() {
    if (this.ejects.size === 0 || this.viruses.size === 0) return;
    for (const e of this.ejects.values()) {
      const near = this.virusGrid.queryCircle(e.x, e.y, e.radius + P.radius(C.VIRUS_MASS));
      for (const cand of near) {
        const v = cand.ref;
        if (!this.viruses.has(v.id)) continue;
        const dx = e.x - v.x;
        const dy = e.y - v.y;
        if (dx * dx + dy * dy < v.radius * v.radius) {
          // remember the feed direction (where the pellet was travelling)
          let fx = e.mx;
          let fy = e.my;
          if (fx === 0 && fy === 0) {
            fx = dx;
            fy = dy;
          }
          const fl = Math.hypot(fx, fy) || 1;
          v.fx += fx / fl;
          v.fy += fy / fl;
          v.feed++;
          this.ejects.delete(e.id);
          if (v.feed >= C.VIRUS_FEED_COUNT) this.shootVirus(v);
          break;
        }
      }
    }
  }

  shootVirus(v) {
    let dx = v.fx;
    let dy = v.fy;
    const dl = Math.hypot(dx, dy);
    if (dl < 1e-6) {
      const a = Math.random() * Math.PI * 2;
      dx = Math.cos(a);
      dy = Math.sin(a);
    } else {
      dx /= dl;
      dy /= dl;
    }
    const nv = new Virus(allocId(), v.x + dx * v.radius, v.y + dy * v.radius);
    nv.mx = dx * C.VIRUS_SPLIT_BOOST;
    nv.my = dy * C.VIRUS_SPLIT_BOOST;
    this.borderClamp(nv);
    this.viruses.set(nv.id, nv);
    v.feed = 0;
    v.fx = 0;
    v.fy = 0;
  }

  eatPass() {
    // Larger cells act first so ties resolve in favour of the bigger blob.
    const sorted = [...this.cells.values()].sort((a, b) => b.mass - a.mass);
    for (const a of sorted) {
      if (!this.cells.has(a.id)) continue; // already eaten this pass
      const ar = a.radius;

      // food: eaten by simple body overlap (center within radius)
      const nf = this.foodGrid.queryCircle(a.x, a.y, ar);
      for (const cand of nf) {
        const f = cand.ref;
        if (!this.food.has(f.id)) continue;
        const dx = f.x - a.x;
        const dy = f.y - a.y;
        if (dx * dx + dy * dy < ar * ar) {
          a.mass += f.mass;
          this.food.delete(f.id);
          this.eatEvents.push({ eaterId: a.id, eatenId: f.id, x: f.x, y: f.y });
        }
      }

      // ejected pellets: overlap test (their mass auto-satisfies the ratio)
      const ne = this.ejectGrid.queryCircle(a.x, a.y, ar);
      for (const cand of ne) {
        const e = cand.ref;
        if (!this.ejects.has(e.id)) continue;
        const dx = e.x - a.x;
        const dy = e.y - a.y;
        const reach = ar - C.EAT_OVERLAP * e.radius;
        if (dx * dx + dy * dy < reach * reach) {
          a.mass += e.mass;
          this.ejects.delete(e.id);
          this.eatEvents.push({ eaterId: a.id, eatenId: e.id, x: e.x, y: e.y });
        }
      }

      // virus pop: only cells >= 125 that cover the virus center
      if (a.mass >= C.VIRUS_POP_MIN_MASS) {
        const nv = this.virusGrid.queryCircle(a.x, a.y, ar);
        for (const cand of nv) {
          const v = cand.ref;
          if (!this.viruses.has(v.id)) continue;
          const dx = v.x - a.x;
          const dy = v.y - a.y;
          const reach = ar - C.EAT_OVERLAP * v.radius;
          if (dx * dx + dy * dy < reach * reach) {
            a.mass += v.mass;
            this.viruses.delete(v.id);
            this.eatEvents.push({ eaterId: a.id, eatenId: v.id, x: v.x, y: v.y });
            this.explode(a);
            break; // the cell is now smaller/scattered; stop this cell's pass
          }
        }
        if (!this.cells.has(a.id)) continue;
      }

      // other players' cells: ratio + overlap
      const nc = this.cellGrid.queryCircle(a.x, a.y, ar);
      for (const cand of nc) {
        const b = cand.ref;
        if (b === a || !this.cells.has(b.id)) continue;
        if (b.ownerId === a.ownerId) continue; // same owner => merge pass only
        if (a.mass < C.EAT_RATIO * b.mass) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const reach = ar - C.EAT_OVERLAP * b.radius;
        if (dx * dx + dy * dy < reach * reach) {
          a.mass += b.mass;
          this.eatEvents.push({ eaterId: a.id, eatenId: b.id, x: b.x, y: b.y });
          this.removeCell(b);
        }
      }
    }
  }

  // --- split / eject / pop (SPEC §6,§8,§9) --------------------------------

  doSplit(p) {
    // every eligible cell splits, largest first, until the player-wide cap.
    const eligible = p.cells
      .filter((c) => c.mass >= C.SPLIT_MIN_MASS)
      .sort((a, b) => b.mass - a.mass);
    for (const c of eligible) {
      if (p.cells.length >= C.MAX_CELLS) break;
      const half = c.mass / 2;
      c.mass = half;
      c.bornTick = this.simTick; // splitting resets the parent's merge timer too
      let dx = p.targetX - c.x;
      let dy = p.targetY - c.y;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d;
      dy /= d;
      const r = P.radius(half);
      const nx = c.x + dx * (r + C.SPLIT_OFFSET);
      const ny = c.y + dy * (r + C.SPLIT_OFFSET);
      const nc = this.newCell(p.id, nx, ny, half, c.hue);
      nc.mx = dx * C.SPLIT_BOOST;
      nc.my = dy * C.SPLIT_BOOST;
      this.borderClamp(nc);
      p.cells.push(nc);
    }
  }

  doEject(p) {
    for (const c of p.cells) {
      if (c.mass < C.EJECT_MIN_MASS) continue;
      c.mass -= C.EJECT_LOSS;
      let dx = p.targetX - c.x;
      let dy = p.targetY - c.y;
      const d = Math.hypot(dx, dy) || 1;
      let ang = Math.atan2(dy / d, dx / d);
      ang += (Math.random() * 2 - 1) * C.EJECT_DISPERSION;
      dx = Math.cos(ang);
      dy = Math.sin(ang);
      const r = c.radius + P.radius(C.EJECT_MASS);
      const ex = c.x + dx * r;
      const ey = c.y + dy * r;
      const e = new EjectedMass(allocId(), ex, ey, c.hue);
      e.mx = dx * C.EJECT_BOOST;
      e.my = dy * C.EJECT_BOOST;
      this.borderClamp(e);
      this.ejects.set(e.id, e);
    }
  }

  // A popped cell (mass already boosted by VIRUS_MASS) scatters into pieces.
  explode(cell) {
    const p = this.players.get(cell.ownerId);
    if (!p) return;
    const room = C.MAX_CELLS - p.cells.length;
    const byMass = Math.floor(cell.mass / C.SPLIT_MIN_MASS) - 1;
    const pieces = Math.min(room, byMass);
    if (pieces <= 0) return;
    const pieceMass = cell.mass / (pieces + 1);
    cell.mass = pieceMass;
    cell.bornTick = this.simTick;
    for (let i = 0; i < pieces; i++) {
      const ang = (i / pieces) * Math.PI * 2 + Math.random() * 0.3;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      const nc = this.newCell(p.id, cell.x, cell.y, pieceMass, cell.hue);
      nc.mx = dx * C.SPLIT_BOOST;
      nc.my = dy * C.SPLIT_BOOST;
      p.cells.push(nc);
    }
  }

  // --- mass decay (SPEC §10) ----------------------------------------------

  decay() {
    for (const c of this.cells.values()) {
      if (c.mass <= C.DECAY_MIN_MASS) continue;
      c.mass -= c.mass * C.DECAY_RATE * DT;
      if (c.mass < C.MIN_CELL_MASS) c.mass = C.MIN_CELL_MASS;
    }
  }

  // --- leaderboard (SPEC §13) ---------------------------------------------

  leaderboardRows() {
    const rows = [];
    for (const p of this.players.values()) {
      if (p.dead || p.cells.length === 0) continue;
      rows.push({ id: p.id, mass: Math.round(p.totalMass()), name: p.name });
    }
    rows.sort((a, b) => b.mass - a.mass);
    return rows;
  }
}

module.exports = { World };
