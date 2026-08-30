# agar-clone — Go server variant

A functionally identical port of the reference Node server (`../server`) to Go.
It serves the **unchanged** shared client (`../client`) and speaks the **exact
same little-endian binary protocol**, so the same browser client works against
either server without modification.

## Run

```bash
go mod tidy
go run .
```

- Default port: **4100** (the canonical agar-clone play port).
- Override with the `PORT` env var, e.g. `PORT=4610 go run .`.
- Open `http://localhost:4100/` in a browser and press **Play**.

Run only one language variant on the canonical port at a time.

## What it does

- **One port** serves both the static client over HTTP and the WebSocket upgrade
  at `/` (net/http + gorilla/websocket). Non-upgrade requests get static files;
  `Upgrade: websocket` requests get the game socket.
- A **25 Hz** (`time.Ticker`, 40 ms, accumulator with 250 ms catch-up cap)
  authoritative simulation owns all state. A single mutex guards the world and
  the connection set; the tick goroutine and per-connection reader goroutines
  serialize through it, so all socket writes are ordered.
- Binary frames are encoded/decoded with `encoding/binary` (little-endian),
  matching `../server/protocol.js` byte-for-byte: 1-byte packet id, `u16`
  positions/sizes, `u32` ids/masses, and `[u8 len][len × u16 code unit]` UTF-16
  strings.
- **Bots** (`BotCount = 15`) drive themselves through the same input path as
  humans, so the arena is always alive.

## Parity with the reference

Every gameplay/tuning number lives in `constants.go` (mirroring
`constants.js`), and the physics formulas in `physics.go` (radius, speed
`mass^-0.44`, recombine ticks, view scale/half) match `physics.js` verbatim.
The tick order in `world.go`'s `step()` follows SPEC §11:

1. `simTick++`  2. bots  3. queued input (split/eject)  4. integrate
5. own-cell merge/collision  6. eat pass (feed viruses → eat food/eject/virus/cells)
7. food + virus replenish  8. mass decay  9. record final mass / death events.

Snapshots are per-viewport AoI (culled by the same `viewHalf(R)` the client
zooms with), with name-delta and removal tracking per connection, a ~1 Hz
leaderboard, and a ~10 s resync safety net — identical to the Node server.

## File map

| Go file        | Reference (`../server`) |
|----------------|-------------------------|
| `constants.go` | `constants.js`          |
| `physics.go`   | `physics.js`            |
| `protocol.go`  | `protocol.js`           |
| `cell.go`      | `cell.js`               |
| `player.go`    | `player.js`             |
| `aoi.go`       | `aoi.js`                |
| `world.go`     | `world.js`              |
| `bots.go`      | `bots.js`               |
| `main.go`      | `index.js` / `server.js`|

## Protocol conformance (verified)

- HTTP serves `index.html`, `js/*.js`, and `css/*.css` with correct MIME types.
- `WELCOME` frames are byte-identical to the reference encoder for identical ids.
- Live `SNAPSHOT` frames decode with **zero leftover bytes** and, when decoded
  and re-encoded with the reference `protocol.js` encoder, are **byte-identical**
  (verified over 120 consecutive snapshots, covering cell/name/food/virus/remove
  blocks). `PING → PONG` round-trips the client clock; `LEADERBOARD` and `DEATH`
  match the reference layout.
