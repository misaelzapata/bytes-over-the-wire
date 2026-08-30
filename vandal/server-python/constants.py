"""constants.py — single source of truth for VANDAL tuning numbers (Python port).

Mirror of ../server/constants.js. Anything that affects the binary wire layout
(TOOL/SIZE/PALETTE counts, canvas dims, NICK_MAX, PROTOCOL_VERSION) has to match
byte-for-byte with the shared client (../client/js/constants.js).
"""

# --- the shared mural (one enormous canvas everyone paints on) ---
CANVAS_W = 4000   # world width  in pixels (fits u16)
CANVAS_H = 2500   # world height in pixels (fits u16)
MURAL_BG = "#F0E4CF"

# --- authoritative loop ---
TICK_HZ = 20
STEP_MS = 50      # 1000 / TICK_HZ

# --- broadcast cadence (in ticks) ---
PRESENCE_EVERY = 20     # ~1 Hz "N painters online"
CURSORS_EVERY = 1       # ~20 Hz live brush-cursor snapshots
GALLERY_EVERY = 1600    # ~80 s coordinated gallery fly-through
GALLERY_MS = 9000       # fly-through duration the clients animate

# --- tool / palette enums (indices travel on the wire) ---
TOOL_COUNT = 6          # 0 brush · 1 line · 2 rect · 3 circle · 4 eraser · 5 spray
SIZE_COUNT = 3          # 0 fine · 1 medium · 2 broad
PALETTE_COUNT = 14      # curated warm pastel set (no violet)

# --- stroke limits ---
MAX_POINTS = 600        # per-stroke polyline cap; long live strokes auto-split
MAX_STROKES = 4000      # history cap; oldest strokes retire past this

# --- net ---
PROTOCOL_VERSION = 3
NICK_MAX = 15

# --- painter bots ---
BOT_COUNT = 5
