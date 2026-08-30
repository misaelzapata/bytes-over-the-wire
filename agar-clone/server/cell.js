"use strict";

// =============================================================================
// cell.js — Game entity classes: PlayerCell, Food, Virus, EjectedMass.
//           Clases de entidades del juego: PlayerCell, Food, Virus, EjectedMass.
//
// Key concepts / Conceptos clave:
//   - PlayerCell: a blob owned by a player, with momentum engine for split/eject impulse / PlayerCell: un blob de un jugador, con motor de impulso para division/eyeccion
//   - Food: static +1 mass pellet scattered across the arena / Food: pellet estatico de +1 masa esparcido por la arena
//   - Virus: green spiky cell that pops large cells; can be fed and shot / Virus: celula verde con puas que explota celulas grandes; puede ser alimentado y disparado
//   - EjectedMass: 13-mass pellet ejected by players; edible by cells or fed to viruses / EjectedMass: pellet de 13 masa eyectado por jugadores; comestible por celulas o alimenta virus
//   - All use radius = sqrt(100*mass) derived property / Todos usan la propiedad derivada radius = sqrt(100*mass)
// =============================================================================

// ---------------------------------------------------------------------------
// cell.js — entity classes.
//
//   PlayerCell   — a blob belonging to a player (or bot).
//   Food         — a static +1 pellet.
//   Virus        — a green spiky cell (mass 100); pops big cells, shoots when fed.
//   EjectedMass  — a 13-mass pellet flung by W; eaten by cells or fed to viruses.
//
// All positions/masses are full-precision floats; radius is derived from mass
// via the single geometric law radius = sqrt(100*mass) (physics.js).
// ---------------------------------------------------------------------------

const C = require("./constants.js");

const BOOST_THRESH2 = C.BOOST_SPEED * C.BOOST_SPEED;

class PlayerCell {
  constructor(id, ownerId, x, y, mass, hue, bornTick) {
    this.id = id;
    this.ownerId = ownerId;
    this.x = x;
    this.y = y;
    this.mass = mass;
    this.hue = hue;
    // momentum engine (split/eject/pop impulse), world units / second
    this.mx = 0;
    this.my = 0;
    this.bornTick = bornTick; // tick this cell last (re)started its merge timer
  }
  get radius() {
    return Math.sqrt(100 * this.mass);
  }
  // "boosting" = the impulse engine is still significant; merges are suppressed
  // and the wire flag isSplitting is set so the client can render the launch.
  get boosting() {
    return this.mx * this.mx + this.my * this.my > BOOST_THRESH2;
  }
}

class Food {
  constructor(id, x, y, hue) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.hue = hue;
    this.mass = C.FOOD_MASS;
  }
  get radius() {
    return Math.sqrt(100 * this.mass);
  }
}

class Virus {
  constructor(id, x, y) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.mass = C.VIRUS_MASS;
    this.mx = 0; // momentum engine when shot
    this.my = 0;
    this.feed = 0; // ejected pellets absorbed so far
    this.fx = 0; // accumulated feed direction (for the shot)
    this.fy = 0;
  }
  get radius() {
    return Math.sqrt(100 * this.mass);
  }
  get boosting() {
    return this.mx * this.mx + this.my * this.my > BOOST_THRESH2;
  }
}

class EjectedMass {
  constructor(id, x, y, hue) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.hue = hue;
    this.mass = C.EJECT_MASS;
    this.mx = 0;
    this.my = 0;
  }
  get radius() {
    return Math.sqrt(100 * this.mass);
  }
  get boosting() {
    return this.mx * this.mx + this.my * this.my > BOOST_THRESH2;
  }
}

module.exports = { PlayerCell, Food, Virus, EjectedMass };
