# VANDAL — Rust server

A Rust (tokio) port of the reference Node server at `../server`. It is
functionally identical and speaks the **exact same little-endian binary
protocol** to the **shared, unchanged client** at `../client`.

- Serves the static client from `../client` over HTTP on `PORT`.
- Accepts binary WebSocket upgrades at `/` on the **same** port (routed by
  peeking the request head — no separate WS port).
- Keeps the authoritative stroke history (`Mural`). New joiners get the whole
  mural (`HISTORY`) plus any in-progress live strokes; every stroke is
  broadcast as `BEGIN -> APPEND* -> STROKE(commit)`.
- Runs a fixed **20 Hz** loop (a `tokio::interval`) that owns ALL game state:
  painter-bots that trace words/figures, ~20 Hz live cursor snapshots, ~1 Hz
  `PRESENCE`, and a periodic coordinated `GALLERY` fly-through cue.

One tokio task owns the world; connection tasks funnel decoded binary frames in
over an mpsc channel and receive personal frames back over a per-conn channel.

## Run

```sh
cargo run --release
```

- Default port is **4504** (the canonical VANDAL play port — all language
  variants use it; run only ONE at a time).
- Override with `PORT`:

```sh
PORT=4618 cargo run --release
```

Then open <http://localhost:4504/> (or your chosen port).

## Protocol

The wire format is documented in `../server/protocol.js` and mirrored
byte-for-byte here (see the encoders/decoder in `src/main.rs`):

- Every multibyte number is **little-endian**; 1-byte packet id at offset 0.
- Canvas positions are absolute `u16` (0..CANVAS_W / 0..CANVAS_H).
- Strings are `[u8 length][length × u16 code unit]` (UTF-16, JS `charCodeAt`),
  clamped to `NICK_MAX` (15) code units.
- `PROTOCOL_VERSION = 2`; a mismatched `HANDSHAKE` gets `VERSION_OUTDATED` and
  is disconnected.

Tuning constants (canvas 4000×2500, 20 Hz tick, 5 bots, palette/tool/size
counts, stroke caps) match `../server/constants.js` and
`../client/js/constants.js` exactly.

## Verification

Built and run on a temp port (4618) to avoid clashing with sibling builds:

- **HTTP**: serves `index.html`, `js/*.js`, `css/style.css` with correct MIME
  types; `/favicon.ico` → 204; path traversal blocked.
- **Binary WS round-trip**: a scripted client that loads the shared client's
  own `protocol.js` + `constants.js` completes the join handshake and
  decodes/encodes every packet type (`WELCOME`, `HISTORY`, `STROKE`,
  `STROKE_BEGIN/APPEND`, `PRESENCE`, `PONG`, `CURSORS`) with exact field
  values — proving byte-match.
- **Headless Chrome**: the real, unmodified client loads, joins, and renders
  entities (connected, canvas 4000×2500, live bot strokes + cursors).
