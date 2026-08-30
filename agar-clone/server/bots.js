"use strict";

// =============================================================================
// bots.js — AI bot manager: spawns and drives computer-controlled players.
//           Gestor de bots IA: genera y controla jugadores manejados por computadora.
//
// Key concepts / Conceptos clave:
//   - Bots are normal Players (isBot=true) using the same input API as humans / Los bots son Players normales (isBot=true) usando la misma API de entrada que humanos
//   - Behavior priority: flee threats > chase prey > graze food > roam randomly / Prioridad de comportamiento: huir de amenazas > perseguir presas > pastar comida > vagar aleatoriamente
//   - Bots split-snipe when clearly dominant and prey is in range / Los bots dividen-disparan cuando son claramente dominantes y la presa esta en rango
//   - Dead bots auto-respawn each tick to keep the arena populated / Los bots muertos reaparecen automaticamente cada tick para mantener la arena poblada
// =============================================================================

// ---------------------------------------------------------------------------
// bots.js — simple AI blobs so the arena is always alive.
//
// Each bot is a normal Player (isBot=true) and drives itself through the SAME
// setTarget / requestSplit input path humans use. Behaviour: flee any nearby
// bigger blob, else chase the nearest smaller enemy cell (splitting to snipe
// when it's safe), else graze the nearest food, else roam. Dead bots respawn.
// ---------------------------------------------------------------------------

const C = require("./constants.js");

const BOT_NAMES = [
  "Blobby", "Nomz", "Gulp", "Squish", "Pac", "Chonk", "Orbit", "Gooey",
  "Wobble", "Munch", "Bubble", "Jelly", "Splat", "Zippy", "Void", "Puddle",
  "Dot", "Marble", "Cell", "Nibble",
];

class BotManager {
  constructor(world) {
    this.world = world;
    this.bots = []; // { id, roamX, roamY }
  }

  spawnAll(count = C.BOT_COUNT) {
    for (let i = 0; i < count; i++) {
      const name = BOT_NAMES[i % BOT_NAMES.length];
      const p = this.world.addPlayer(name, true);
      this.bots.push({ id: p.id, roamX: 0, roamY: 0 });
    }
  }

  update(world) {
    for (const bot of this.bots) {
      const p = world.players.get(bot.id);
      if (!p) continue;
      if (p.dead) {
        world.respawnPlayer(p);
        continue;
      }
      if (p.cells.length === 0) continue;

      // reference point = the bot's largest cell
      let big = p.cells[0];
      for (const c of p.cells) if (c.mass > big.mass) big = c;
      const cx = big.x;
      const cy = big.y;

      const R = 1300;
      let threat = null;
      let threatD2 = R * R;
      let prey = null;
      let preyD2 = R * R;
      for (const cand of world.cellGrid.queryCircle(cx, cy, R)) {
        const c = cand.ref;
        if (c.ownerId === p.id) continue;
        const dx = c.x - cx;
        const dy = c.y - cy;
        const d2 = dx * dx + dy * dy;
        if (c.mass >= big.mass * C.EAT_RATIO) {
          if (d2 < threatD2) {
            threatD2 = d2;
            threat = c;
          }
        } else if (big.mass >= c.mass * 1.3) {
          if (d2 < preyD2) {
            preyD2 = d2;
            prey = c;
          }
        }
      }

      if (threat) {
        // flee directly away from the threat
        let ax = cx - threat.x;
        let ay = cy - threat.y;
        const d = Math.hypot(ax, ay) || 1;
        world.setTarget(p, cx + (ax / d) * 900, cy + (ay / d) * 900);
      } else if (prey) {
        world.setTarget(p, prey.x, prey.y);
        // snipe with a split when clearly dominant and in range
        if (
          big.mass >= C.SPLIT_MIN_MASS &&
          big.mass >= prey.mass * 2.5 &&
          preyD2 < (big.radius + 200) * (big.radius + 200) &&
          Math.random() < 0.05
        ) {
          world.requestSplit(p);
        }
      } else {
        let food = null;
        let fd2 = Infinity;
        for (const cand of world.foodGrid.queryCircle(cx, cy, 1000)) {
          const f = cand.ref;
          const dx = f.x - cx;
          const dy = f.y - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 < fd2) {
            fd2 = d2;
            food = f;
          }
        }
        if (food) {
          world.setTarget(p, food.x, food.y);
        } else {
          const near =
            Math.abs(cx - bot.roamX) < 80 && Math.abs(cy - bot.roamY) < 80;
          if (near || Math.random() < 0.02 || (bot.roamX === 0 && bot.roamY === 0)) {
            const pos = world.randomPos(300);
            bot.roamX = pos.x;
            bot.roamY = pos.y;
          }
          world.setTarget(p, bot.roamX, bot.roamY);
        }
      }
    }
  }
}

module.exports = { BotManager, BOT_NAMES };
