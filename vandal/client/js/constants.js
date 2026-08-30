"use strict";
// VANDAL — client constants. Wire-affecting values (canvas dims, TOOL/SIZE/
// PALETTE counts, NICK_MAX, PROTOCOL_VERSION, MAX_POINTS) MUST match
// server/constants.js byte-for-byte.

const C = {
  CANVAS_W: 4000,
  CANVAS_H: 2500,
  MURAL_BG: "#F0E4CF", // warm plaster tone the eraser reveals (matches wall base)

  TICK_HZ: 20,
  STEP_MS: 50,

  TOOL_COUNT: 6,
  SIZE_COUNT: 3,
  PALETTE_COUNT: 14,

  MAX_POINTS: 600,

  PROTOCOL_VERSION: 3,
  NICK_MAX: 15,

  // client-only (not on the wire)
  CURSOR_SEND_MS: 60, // ~16 Hz outbound brush-cursor updates
  STREAM_FLUSH_MS: 28, // ~35 Hz batched append flush while painting
};

// --- tool enum (indices travel on the wire; the 6 ids are FIXED) ---
// Re-themed as a real graffiti kit (labels/icons only — wire is unchanged):
//   0 MARKER (handstyle) · 1 STRAIGHTEDGE · 2 ROLLER (fill block) ·
//   3 STENCIL · 4 BUFF (paint-over) · 5 SPRAY CAN (hero)
const TOOL = { BRUSH: 0, LINE: 1, RECT: 2, CIRCLE: 3, ERASER: 4, SPRAY: 5 };

// --- widths in world pixels, indexed by SIZE (0 fine · 1 med · 2 broad).
// For the SPRAY CAN, SIZE is the CAP: 0 = skinny (thin, precise), 2 = fat (wide cloud). ---
const SIZES = [6, 15, 32];

// --- REAL spray-paint palette — colours + names sampled from real graffiti
// lines (Montana MTN 94 / MTN Hardcore, Molotow, Ironlak). 14 fixed slots; the
// index is a u8 on the wire so slots/order NEVER change — only the RGB behind
// each index. ABSOLUTELY NO violet/purple/magenta/indigo. Slot 0 is a cream and
// slot 13 is a warm charcoal keyline. ---
const PALETTE = [
  "#F6ECD3", // 0  cream
  "#FBD1A0", // 1  apricot
  "#F9AE63", // 2  mango
  "#FF8A6B", // 3  coral
  "#F26B34", // 4  vitamin C orange
  "#CE3B2E", // 5  malcolm red
  "#FFD873", // 6  beach yellow
  "#FBC02D", // 7  divine yellow
  "#C6892C", // 8  ocher brown
  "#AFC552", // 9  guacamole
  "#6FBE8E", // 10 mojito green
  "#34AEA3", // 11 caribbean teal (accent)
  "#4F9FD6", // 12 andes blue (accent)
  "#2B2620", // 13 bone black (charcoal keyline)
];

// Real spray-paint colour NAMES + brand family for each index (for the spray-can
// rack labels). Generic can silhouette only — no trademarked logo art.
const PALETTE_META = [
  { name: "Vanilla", brand: "Molotow" },
  { name: "Apricot", brand: "MTN 94" },
  { name: "Mango", brand: "MTN 94" },
  { name: "Coral", brand: "Hardcore" },
  { name: "Vitamin C", brand: "MTN 94" },
  { name: "Malcolm Red", brand: "MTN 94" },
  { name: "Beach", brand: "Ironlak" },
  { name: "Divine Yellow", brand: "MTN 94" },
  { name: "Ocher Brown", brand: "Molotow" },
  { name: "Guacamole", brand: "MTN 94" },
  { name: "Mojito", brand: "Hardcore" },
  { name: "Caribbean", brand: "Ironlak" },
  { name: "Andes Blue", brand: "MTN 94" },
  { name: "Bone Black", brand: "Molotow" },
];

// The eraser reveals the wall surface. In the committed buffer it uses
// destination-out; ERASE_COLOR is only used to tint the live preview.
const ERASE_COLOR = C.MURAL_BG;
