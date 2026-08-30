# VANDAL

A **cooperative collaborative mural**. One enormous shared canvas that many
players paint on together, in real time. There is no fighting, no territory, no
defacing — the whole point is co-creating something beautiful, punctuated by a
periodic **gallery fly-through** that zooms the whole room into a lively corner
of the mural and back.

Authoritative **Node + `ws`** server (binary little-endian protocol, shared
stroke history), plain **browser canvas-2D** client (no build step).

```bash
npm install && node server/index.js
# open http://localhost:4504
```

Runs great solo — **painter bots** quietly co-create pastel motifs so the mural
is always alive.

---

## The tools ("buenas herramientas")

A real little toolbar (bottom of the screen — click to pick):

- **Brush** — smooth, *tapered* strokes.
- **Soft / Hard** edge — soft blends into a pastel halo, hard keeps a clean edge.
- **Three sizes** — fine · medium · broad.
- **Line** — straight line tool.
- **Rectangle** and **Circle** — simple shape tools (drag a bounding box).
- **Eraser** — paints the mural ground back over your marks.
- **Undo** — removes *your* most recent stroke (button, or `Ctrl+Z`).
- A curated **warm pastel palette** (14 colours, no violet/magenta).

**One control:** point + **press-drag to paint**. Tool hotkeys: `B` brush,
`L` line, `R` rect, `C` circle, `E` eraser.

The whole mural is always fit to your viewport, so everyone paints on the same
visible canvas. Every ~60 s the server cues a synchronized **gallery
fly-through** — the camera glides into a busy region and back. Start painting at
any time to dismiss it locally.

---

## How it works

### Server (`server/`) — authoritative historian

The server never rasterizes pixels. It keeps an **ordered list of validated
strokes** so that (a) a new joiner can be handed the entire mural and (b) undo
can target a specific stroke by id.

- `index.js` — HTTP static file server for `../client` **and** the WebSocket
  upgrade on the same port (`4504`). Fixed **20 Hz** accumulator loop drives the
  painter bots, ~1 Hz presence, and the periodic gallery cue. Strokes themselves
  are relayed **immediately** on arrival for snappy co-painting.
- `mural.js` — the stroke store: validate/clamp incoming strokes, cap history at
  `MAX_STROKES` (oldest marks retire), undo-by-owner, remove-by-id.
- `bots.js` — cooperative painter bots. They only *add* gentle pastel strokes
  (brush arcs, soft shapes, lines) around a slowly drifting anchor; they never
  erase anyone's work.
- `protocol.js` — binary encoders/decoders + the growable little-endian
  `Writer`/`Reader` (reused from the agar-clone patterns in this repo).
- `constants.js` — single source of truth for tuning numbers.

### Client (`client/`) — canvas-2D, plain JS

- A full-resolution **offscreen buffer** (`CANVAS_W × CANVAS_H`) is the mural.
  Each incoming stroke is rasterized onto it once; undo replays the remaining
  strokes in order.
- `mural.js` — stroke rasterization: **tapered stamped brush** (resample the
  polyline, taper the radius toward both ends), soft-halo blending, and the
  line/rect/circle/eraser tools.
- `state.js` — `Camera` (fit-to-view + animated gallery fly-through, respecting
  `prefers-reduced-motion`).
- `input.js` — the single press-drag control and the toolbar wiring.
- `net.js` / `protocol.js` — WebSocket lifecycle and the **byte-for-byte** mirror
  of the server protocol (`binaryType = 'arraybuffer'`, `DataView` little-endian).
- `render.js` / `main.js` — framed-mural render loop, presence HUD, gallery banner.

---

## Binary protocol (little-endian)

1-byte packet id at offset 0 of every frame. Positions are absolute `u16`
canvas coords. Strings are `[u8 len][len × u16 code unit]` UTF-16.

**Join:** `HANDSHAKE(version)` → `SET_NICK(name)` → `WELCOME(yourId, canvasW,
canvasH, serverTick)` → `HISTORY(all strokes)`. `PING`↔`PONG` for a clock read.

### `STROKE_BLOCK` (shared by `HISTORY` and `STROKE`)

```
[u32 id][u32 ownerId][u8 tool][u8 color][u8 size][u8 flags]
[u16 nPoints]{ u16 x, u16 y } × nPoints
```

`tool`: 0 brush · 1 line · 2 rect · 3 circle · 4 eraser · `flags` bit0 = soft.

### Server → client

| id | name    | payload |
|----|---------|---------|
| 0  | WELCOME | `u32 yourId, u16 canvasW, u16 canvasH, u32 serverTick` |
| 1  | HISTORY | `u32 count, { STROKE_BLOCK } × count` |
| 2  | STROKE  | `{ STROKE_BLOCK }` |
| 3  | UNDO    | `u32 strokeId` |
| 4  | PRESENCE| `u16 painterCount` |
| 5  | GALLERY | `u16 cx, u16 cy, u16 half, u16 durMs` |
| 6  | PONG    | `u32 clientMs, u32 serverTick` |
| 255| VERSION_OUTDATED | — |

### Client → server

| id | name      | payload |
|----|-----------|---------|
| 0  | SET_NICK  | `str name` |
| 1  | PING      | `u32 clientMs` |
| 2  | STROKE    | `u8 tool, u8 color, u8 size, u8 flags, u16 n, { u16 x, u16 y } × n` |
| 3  | UNDO      | — |
| 255| HANDSHAKE | `u32 version` |

The server assigns `id` + `ownerId` and rebroadcasts each stroke to everyone.

---

## Files

```
vandal/
├── package.json            # dep: ws
├── README.md
├── server/
│   ├── index.js            # http + ws on :4504, 20Hz loop, broadcast
│   ├── server.js           # convenience entry (requires index.js)
│   ├── constants.js
│   ├── protocol.js         # binary Writer/Reader + (de)coders
│   ├── mural.js            # authoritative stroke history
│   └── bots.js             # cooperative painter bots
└── client/
    ├── index.html
    ├── css/style.css
    └── js/
        ├── constants.js    # wire-critical values mirror the server
        ├── protocol.js     # byte-for-byte protocol mirror
        ├── state.js        # World + Camera (gallery fly-through)
        ├── mural.js        # offscreen buffer + stroke rasterization
        ├── net.js
        ├── input.js        # press-drag control + toolbar
        ├── render.js
        └── main.js
```

Port **4504** serves both the static client and the WebSocket endpoint.
