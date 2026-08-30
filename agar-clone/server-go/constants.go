package main

// constants.go — single source of truth for every gameplay/tuning number.
// Mirrors server/constants.js EXACTLY (SPEC §15). Values are duplicated on the
// shared client for own-cell prediction parity; do not change them here.

const (
	// --- world / tick ---
	WorldSize = 14142 // square arena side; coords run [0, WorldSize]
	GridStep  = 50    // client-side faint grid spacing (client-only)
	TickHz    = 25    // authoritative sim rate
	StepMs    = 40    // 1000 / TickHz

	// --- mass / sizes ---
	SpawnMass   = 10 // fresh cell mass (radius 31.6)
	MinCellMass = 10 // a cell never drops below this
	MaxCells    = 16 // per-player cell cap

	// --- eating ---
	EatRatio   = 1.25 // A eats B iff A.mass >= 1.25 * B.mass
	EatOverlap = 0.4  // and dist < A.radius - 0.4 * B.radius

	// --- movement ---
	SpeedBase      = 1100.0 // speed(mass) = SpeedBase * mass^SpeedExp  (u/s)
	SpeedExp       = -0.44  // bigger => slower
	MoveEngineDecay = 0.75  // per-tick decay of the split/eject/pop impulse vector
	BoostSpeed     = 60.0   // |moveEngine| above this (u/s) => "boosting"

	// --- split (spacebar) ---
	SplitMinMass = 35     // only cells this big can split
	SplitBoost   = 780.0  // launch impulse (u/s) added to moveEngine
	SplitOffset  = 40.0   // spawn offset beyond the parent edge, toward cursor

	// --- merge / recombine ---
	NoMergeTicks  = 15   // hard lockout right after a split
	MergeBaseS    = 30.0 // recombineS(mass) = 30 + 0.02 * mass
	MergePerMassS = 0.02

	// --- eject (W) ---
	EjectMinMass   = 35    // only cells this big can eject
	EjectLoss      = 18.0  // mass removed from the cell per eject
	EjectMass      = 13.0  // mass of the spawned pellet (5 lost to the void)
	EjectBoost     = 780.0 // launch impulse (u/s)
	EjectDispersion = 0.3  // ± radians random spread on the eject direction

	// --- food pellets ---
	FoodMass       = 1.0  // radius 10
	FoodCap        = 1500
	FoodSpawnTicks = 2  // replenish every N ticks
	FoodSpawnBatch = 20 // up to this many pellets added per replenish

	// --- viruses ---
	VirusMass      = 100.0 // radius 100
	VirusMin       = 10    // keep at least this many
	VirusMax       = 30    // stop natural spawns at/above this (unused; parity)
	VirusFeedCount = 7     // ejected pellets to make a virus shoot a new one
	VirusSplitBoost = 780.0 // launch impulse of a shot virus (u/s)
	VirusPopMinMass = 125.0 // a cell must be >= 1.25*VirusMass to pop a virus

	// --- mass decay ---
	DecayMinMass = 100.0 // only cells above this decay
	DecayRate    = 0.002 // fraction of mass lost per second (0.2%/s)

	// --- broadcast cadence (in ticks) ---
	SnapshotEvery    = 1   // per tick (25 Hz) viewport snapshot
	LeaderboardEvery = 25  // ~1 Hz top-10
	ResyncEvery      = 250 // ~10s safety net

	// --- camera / zoom / AoI ---
	BaseViewH = 1080.0 // reference viewport height in world units at scale 1
	AoiPad    = 400.0  // extra world margin streamed beyond the visible box
	AoiCell   = 1024   // uniform spatial-hash cell size

	// --- net ---
	ProtocolVersion = 1
	NickMax         = 15

	// --- bots ---
	BotCount = 15
)
