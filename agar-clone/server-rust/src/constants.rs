// constants.rs — Rust mirror of server/constants.js (SPEC §15).
// Identical numeric values; the sim and wire protocol depend on these.

// --- world / tick ---
pub const WORLD_SIZE: f64 = 14142.0;
pub const TICK_HZ: f64 = 25.0;
pub const STEP_MS: u64 = 40; // 1000 / TICK_HZ

// --- mass / sizes ---
pub const SPAWN_MASS: f64 = 10.0;
pub const MIN_CELL_MASS: f64 = 10.0;
pub const MAX_CELLS: usize = 16;

// --- eating ---
pub const EAT_RATIO: f64 = 1.25;
pub const EAT_OVERLAP: f64 = 0.4;

// --- movement ---
pub const SPEED_BASE: f64 = 1100.0;
pub const SPEED_EXP: f64 = -0.44;
pub const MOVEENGINE_DECAY: f64 = 0.75;
pub const BOOST_SPEED: f64 = 60.0;

// --- split ---
pub const SPLIT_MIN_MASS: f64 = 35.0;
pub const SPLIT_BOOST: f64 = 780.0;
pub const SPLIT_OFFSET: f64 = 40.0;

// --- merge / recombine ---
pub const NO_MERGE_TICKS: i64 = 15;
pub const MERGE_BASE_S: f64 = 30.0;
pub const MERGE_PER_MASS_S: f64 = 0.02;

// --- eject ---
pub const EJECT_MIN_MASS: f64 = 35.0;
pub const EJECT_LOSS: f64 = 18.0;
pub const EJECT_MASS: f64 = 13.0;
pub const EJECT_BOOST: f64 = 780.0;
pub const EJECT_DISPERSION: f64 = 0.3;

// --- food pellets ---
pub const FOOD_MASS: f64 = 1.0;
pub const FOOD_CAP: usize = 1500;
pub const FOOD_SPAWN_TICKS: u32 = 2;
pub const FOOD_SPAWN_BATCH: i32 = 20;

// --- viruses ---
pub const VIRUS_MASS: f64 = 100.0;
pub const VIRUS_MIN: usize = 10;
#[allow(dead_code)]
pub const VIRUS_MAX: usize = 30;
pub const VIRUS_FEED_COUNT: u32 = 7;
pub const VIRUS_SPLIT_BOOST: f64 = 780.0;
pub const VIRUS_POP_MIN_MASS: f64 = 125.0;

// --- mass decay ---
pub const DECAY_MIN_MASS: f64 = 100.0;
pub const DECAY_RATE: f64 = 0.002;

// --- broadcast cadence (in ticks) ---
pub const LEADERBOARD_EVERY: u32 = 25;
pub const RESYNC_EVERY: u32 = 250;

// --- camera / zoom / AoI ---
pub const BASE_VIEW_H: f64 = 1080.0;
pub const AOI_PAD: f64 = 400.0;
pub const AOI_CELL: f64 = 1024.0;

// --- net ---
pub const PROTOCOL_VERSION: u32 = 1;
pub const NICK_MAX: usize = 15;

// --- bots ---
pub const BOT_COUNT: usize = 15;
