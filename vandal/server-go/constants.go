package main

// constants.go — mirror of ../server/constants.js. Single source of truth for
// VANDAL tuning numbers. Anything affecting the binary wire layout
// (TOOL/SIZE/PALETTE counts, canvas dims, NICK_MAX, PROTOCOL_VERSION) must match
// the browser client byte-for-byte.

const (
	// --- the shared mural ---
	CanvasW = 4000 // world width  in pixels (fits u16)
	CanvasH = 2500 // world height in pixels (fits u16)

	// --- authoritative loop ---
	TickHz = 20
	StepMS = 50 // 1000 / TickHz

	// --- broadcast cadence (in ticks) ---
	PresenceEvery = 20   // ~1 Hz "N painters online"
	CursorsEvery  = 1    // ~20 Hz live brush-cursor snapshots
	GalleryEvery  = 1600 // ~80 s coordinated gallery fly-through
	GalleryMS     = 9000 // fly-through duration the clients animate

	// --- tool / palette enums (indices travel on the wire) ---
	ToolCount    = 6  // 0 brush · 1 line · 2 rect · 3 circle · 4 eraser · 5 spray
	SizeCount    = 3  // 0 fine · 1 medium · 2 broad
	PaletteCount = 14 // curated warm pastel set (no violet)

	// --- stroke limits ---
	MaxPoints  = 600  // per-stroke polyline cap
	MaxStrokes = 4000 // history cap

	// --- net ---
	ProtocolVersion = 3
	NickMax         = 15

	// --- painter bots ---
	BotCount = 5
)
