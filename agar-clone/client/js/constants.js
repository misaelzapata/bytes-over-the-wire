"use strict";
// AGAR-CLONE — client constants. Mirrors server constants.js numeric values +
// the shared formulas (SPEC §15). Client duplicates these VERBATIM so that
// own-cell prediction matches server integration byte-for-formula.

const C = {
  // world / tick
  WORLD_SIZE: 14142,
  GRID_STEP: 50,
  TICK_HZ: 25,
  STEP_MS: 40,

  // mass / cells
  SPAWN_MASS: 10,
  MIN_CELL_MASS: 10,
  MAX_CELLS: 16,
  FOOD_MASS: 1,

  // eat rule
  EAT_RATIO: 1.25,
  EAT_OVERLAP: 0.4,

  // movement
  SPEED_BASE: 1100,
  SPEED_EXP: -0.44,
  MOVEENGINE_DECAY: 0.75,

  // split / merge
  SPLIT_MIN_MASS: 35,
  SPLIT_BOOST: 780,
  SPLIT_OFFSET: 40,
  NO_MERGE_TICKS: 15,
  MERGE_BASE_S: 30,
  MERGE_PER_MASS_S: 0.02,

  // eject
  EJECT_MIN_MASS: 35,
  EJECT_LOSS: 18,
  EJECT_MASS: 13,
  EJECT_BOOST: 780,
  EJECT_DISPERSION: 0.3,

  // virus
  VIRUS_MASS: 100,
  VIRUS_MIN: 10,
  VIRUS_MAX: 30,

  // decay
  DECAY_MIN_MASS: 100,
  DECAY_RATE: 0.002,

  // cadence
  LEADERBOARD_EVERY: 25,
  RESYNC_EVERY: 250,

  // view
  BASE_VIEW_H: 1080,
  AOI_PAD: 400,

  // net
  PROTOCOL_VERSION: 1,
  NICK_MAX: 15,

  // client-only
  SNAPSHOT_MS: 40,          // expected time between snapshots (25Hz)
  INTERP_DELAY_MS: 90,      // render remote cells this far behind live
  CAM_SMOOTH: 0.20,         // camera easing toward centroid
  RECONCILE: 0.25,          // own-cell prediction pull toward server auth
  INPUT_HZ: 25,             // throttle for INPUT_TARGET sends
};

// --- shared formulas (duplicated verbatim from server physics.js, SPEC §15) ---
function radiusOfMass(mass) { return Math.sqrt(100 * mass); }
function massOfRadius(r) { return (r * r) / 100; }
function speedOfMass(mass) { return C.SPEED_BASE * Math.pow(mass, C.SPEED_EXP); }
function recombineS(mass) { return C.MERGE_BASE_S + C.MERGE_PER_MASS_S * mass; }
function viewScaleOfR(R) { return Math.pow(Math.min(64 / R, 1), 0.4); }
