"use strict";

// =============================================================================
// player.js — Player tracker: one instance per human or bot in the game.
//             Rastreador de jugador: una instancia por humano o bot en el juego.
//
// Key concepts / Conceptos clave:
//   - Owns the player's live cells[], nickname, hue color, and dead state / Posee las celulas[] vivas del jugador, apodo, color hue y estado de muerte
//   - Stores mouse-drift target (targetX/Y) and queued split/eject actions / Almacena objetivo de desplazamiento del raton (targetX/Y) y acciones de division/eyeccion en cola
//   - Provides centroid() for camera/AoI center and sumRadius() for zoom scaling / Provee centroid() para centro de camara/AoI y sumRadius() para escalado de zoom
//   - totalMass() aggregates mass across all owned cells / totalMass() agrega la masa de todas las celulas propias
// =============================================================================

// ---------------------------------------------------------------------------
// player.js — PlayerTracker: one per human or bot.
//
// Owns the player's live cells[], nick, hue, current mouse-drift target, and the
// queued split/eject action flags drained by world.step(). All per-cell physics
// live on the PlayerCell entities (cell.js); this is the roster + input state.
// ---------------------------------------------------------------------------

class Player {
  constructor(id, name, isBot) {
    this.id = id;
    this.name = name || "";
    this.isBot = !!isBot;
    this.hue = (Math.random() * 256) | 0;

    this.cells = []; // PlayerCell[] (also present in world.cells map)

    // mouse-drift target (world coords). Seeded at spawn to the spawn point.
    this.targetX = 0;
    this.targetY = 0;

    // queued one-shot actions (applied once at the top of the next tick)
    this.queueSplit = false;
    this.queueEject = false;

    this.dead = false;
    this.finalMass = 0; // last total mass at death (for the DEATH packet)
  }

  totalMass() {
    let m = 0;
    for (const c of this.cells) m += c.mass;
    return m;
  }

  // mass-weighted centroid of own cells (camera target / AoI center).
  centroid() {
    let sx = 0;
    let sy = 0;
    let tm = 0;
    for (const c of this.cells) {
      sx += c.x * c.mass;
      sy += c.y * c.mass;
      tm += c.mass;
    }
    if (tm === 0) return { x: this.targetX, y: this.targetY };
    return { x: sx / tm, y: sy / tm };
  }

  // R = sum of own-cell radii (classic zoom / view-size proxy).
  sumRadius() {
    let r = 0;
    for (const c of this.cells) r += c.radius;
    return r;
  }
}

module.exports = Player;
