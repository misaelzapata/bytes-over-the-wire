# agar-clone — Rust server

A Rust port of the reference Node server at `../server`. It is functionally
identical and speaks the **exact same binary protocol** to the **shared client**
at `../client`, so the same client runs unchanged against either server.

- **Runtime:** `tokio` + `tokio-tungstenite` (WebSocket) with a tiny hand-rolled
  HTTP/1.1 responder that serves `../client` statically on the **same port**.
- **Simulation:** a `tokio::time::interval` drives a fixed **25 Hz** authoritative
  tick (40 ms step, accumulator with 250 ms catch-up cap) that owns all world
  state on a single task. Binary frames are little-endian via `to_le_bytes`.

## Run

```bash
cargo run --release
```

- HTTP + WebSocket both listen on `PORT` (default **4100**, the canonical
  agar-clone play port). Open <http://localhost:4100/>.
- WebSocket endpoint is `ws://<host>/` on the same port.
- `PORT` env var overrides the port (e.g. `PORT=4612 cargo run --release`).
- `CLIENT_ROOT` env var overrides the static client directory (defaults to
  `../client` relative to this crate).

## Protocol parity

Byte-for-byte with `../server/protocol.js` (SPEC §12), all little-endian:

- 1-byte packet id at offset 0 of every frame (both directions).
- World positions/sizes are absolute `u16`; leaderboard mass is `u32`.
- Strings are `[u8 len][len × u16 code unit]` UTF-16, names clamped to 15 units.
- Quantization is wire-only; the sim runs on full-precision `f64`.

**S→C:** `0` WELCOME, `1` SNAPSHOT (AoI-culled per viewer, every tick), `2`
LEADERBOARD (~1 Hz), `3` PONG, `4` DEATH, `255` VERSION_OUTDATED.
**C→S:** `0` SET_NICK, `1` PING, `2` INPUT_TARGET, `3` SPLIT, `4` EJECT,
`5` RESPAWN, `255` HANDSHAKE.

Join sequence: `HANDSHAKE(version)` → `SET_NICK(name)` → `WELCOME` → per-tick
`SNAPSHOT`. `PING`↔`PONG` for clock sync.

## Layout

| file | mirrors | purpose |
|------|---------|---------|
| `src/constants.rs` | `constants.js` | all tuning numbers (identical values) |
| `src/protocol.rs`  | `protocol.js`  | LE Writer + encoders + client decoder |
| `src/world.rs`     | `world.js`, `physics.js`, `cell.js`, `aoi.js` | entities, 25 Hz step, eat/split/eject/merge/virus/decay, spatial hash |
| `src/bots.rs`      | `bots.js`      | 15 AI blobs driven through the same input path |
| `src/main.rs`      | `index.js`, `server.js` | HTTP static + WS upgrade, game loop, per-viewer AoI snapshots |

## Notes on fidelity

- Entities live in id-keyed maps; players hold cell-id lists (Rust cannot share
  mutable object references the way the JS reference does). Tick order,
  formulas, quantization, and byte layouts are preserved exactly.
- `Math.random()` is replaced by a small xorshift PRNG — randomness differs run
  to run (as it does in the reference), but all deterministic gameplay math is
  identical.
