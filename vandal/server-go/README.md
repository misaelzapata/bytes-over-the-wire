# VANDAL — Go server

A Go port of the reference Node server (`../server`). It is functionally
identical and speaks the **exact same binary WebSocket protocol** to the
**unchanged shared client** in `../client`, which it also serves statically.

One HTTP listener does both jobs on a single port:

- `GET /` (and any static path) serves the client from `../client`.
- A WebSocket `Upgrade` on `/` enters the binary game protocol.

## Run

```sh
go mod tidy && go run .
```

- Default port: **4504** (the canonical VANDAL play port — run only one language
  variant at a time).
- Override with `PORT`, e.g. `PORT=4616 go run .`.
- `CLIENT_ROOT` overrides the served client directory (defaults to `../client`).

Then open <http://localhost:4504/>.

## What it does (mirrors the Node reference)

- Authoritative **20 Hz** simulation loop (accumulator, 250 ms catch-up cap).
- Keeps the whole mural as an ordered list of completed strokes plus a map of
  live in-progress strokes (`mural.go`).
- Join sequence: `HANDSHAKE(version) -> SET_NICK(name) -> WELCOME -> HISTORY`,
  then a replay of any in-progress live strokes.
- Every stroke is broadcast as `STROKE_BEGIN -> STROKE_APPEND* -> STROKE`
  (commit). Long live strokes auto-split at the `MAX_POINTS` cap.
- **5 painter bots** (`bots.go`) trace graffiti words and figures, streamed just
  like human strokes, so a solo mural stays alive.
- `~1 Hz` PRESENCE, `~20 Hz` live CURSORS snapshots, and a periodic coordinated
  GALLERY fly-through cue.

## Wire protocol

Little-endian throughout; 1-byte packet id at offset 0 of every frame. Strings
are `[u8 len][len × u16 code unit]` (UTF-16). See `protocol.go` (and the
identical `../server/protocol.js`) for the full documented layout. The byte
layout is verified against the Node reference and the shared client.

## Layout

| file           | role                                             |
| -------------- | ------------------------------------------------ |
| `main.go`      | HTTP + WS wiring, tick loop, message handling    |
| `protocol.go`  | binary encoders/decoders (LE wire format)        |
| `mural.go`     | authoritative stroke history + live strokes      |
| `bots.go`      | painter bots (words, figures, geometry)          |
| `constants.go` | tuning numbers (must match client byte-for-byte) |

## Concurrency

A single `time.Ticker` goroutine drives the tick and owns state mutations; all
shared state is guarded by one mutex. Each connection has its own buffered
outbound channel drained by a dedicated writer goroutine, so a slow client never
stalls the simulation.
