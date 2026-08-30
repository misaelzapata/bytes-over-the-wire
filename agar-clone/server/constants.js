"use strict";

// ---------------------------------------------------------------------------
// constants.js — single source of truth for every gameplay/tuning number.
//
// SPEC §15. client/js/constants.js MUST hold these IDENTICAL numeric values;
// physics.js formulas (radius/mass, speed^-0.44, viewScale, recombineS) are
// duplicated verbatim on the client for own-cell prediction parity.
// ---------------------------------------------------------------------------

const C = {
  // --- world / tick ---
  WORLD_SIZE: 14142, // square arena side; coords run [0, WORLD_SIZE]
  GRID_STEP: 50, // client-side faint grid spacing
  TICK_HZ: 25, // authoritative sim rate
  STEP_MS: 40, // 1000 / TICK_HZ

  // --- mass / sizes ---
  SPAWN_MASS: 10, // fresh cell mass (radius 31.6)
  MIN_CELL_MASS: 10, // a cell never drops below this
  MAX_CELLS: 16, // per-player cell cap

  // --- eating ---
  EAT_RATIO: 1.25, // A eats B iff A.mass >= 1.25 * B.mass
  EAT_OVERLAP: 0.4, // and dist < A.radius - 0.4 * B.radius

  // --- movement ---
  SPEED_BASE: 1100, // speed(mass) = SPEED_BASE * mass^SPEED_EXP  (u/s)
  SPEED_EXP: -0.44, // bigger => slower
  MOVEENGINE_DECAY: 0.75, // per-tick decay of the split/eject/pop impulse vector
  BOOST_SPEED: 60, // |moveEngine| above this (u/s) => "boosting" (merge suppressed)

  // --- split (spacebar) ---
  SPLIT_MIN_MASS: 35, // only cells this big can split
  SPLIT_BOOST: 780, // launch impulse (u/s) added to moveEngine
  SPLIT_OFFSET: 40, // spawn offset beyond the parent edge, toward cursor

  // --- merge / recombine ---
  NO_MERGE_TICKS: 15, // hard lockout right after a split, regardless of formula
  MERGE_BASE_S: 30, // recombineS(mass) = 30 + 0.02 * mass
  MERGE_PER_MASS_S: 0.02,

  // --- eject (W) ---
  EJECT_MIN_MASS: 35, // only cells this big can eject
  EJECT_LOSS: 18, // mass removed from the cell per eject
  EJECT_MASS: 13, // mass of the spawned pellet (5 lost to the void)
  EJECT_BOOST: 780, // launch impulse (u/s)
  EJECT_DISPERSION: 0.3, // ± radians random spread on the eject direction

  // --- food pellets ---
  FOOD_MASS: 1, // radius 10
  FOOD_CAP: 1500,
  FOOD_SPAWN_TICKS: 2, // replenish every N ticks
  FOOD_SPAWN_BATCH: 20, // up to this many pellets added per replenish

  // --- viruses ---
  VIRUS_MASS: 100, // radius 100
  VIRUS_MIN: 10, // keep at least this many
  VIRUS_MAX: 30, // stop natural spawns at/above this
  VIRUS_FEED_COUNT: 7, // ejected pellets to make a virus shoot a new one
  VIRUS_SPLIT_BOOST: 780, // launch impulse of a shot virus (u/s)
  VIRUS_POP_MIN_MASS: 125, // a cell must be >= 1.25*VIRUS_MASS to pop a virus

  // --- mass decay ---
  DECAY_MIN_MASS: 100, // only cells above this decay
  DECAY_RATE: 0.002, // fraction of mass lost per second (0.2%/s)

  // --- broadcast cadence (in ticks) ---
  SNAPSHOT_EVERY: 1, // per tick (25 Hz) viewport snapshot
  LEADERBOARD_EVERY: 25, // ~1 Hz top-10
  RESYNC_EVERY: 250, // ~10s safety net (re-seed name deltas + visibility)

  // --- camera / zoom / AoI ---
  BASE_VIEW_H: 1080, // reference viewport height in world units at scale 1
  AOI_PAD: 400, // extra world margin streamed beyond the visible box
  AOI_CELL: 1024, // uniform spatial-hash cell size

  // --- net ---
  PROTOCOL_VERSION: 1,
  NICK_MAX: 15,

  // --- bots ---
  BOT_COUNT: 15,
};

module.exports = C;
