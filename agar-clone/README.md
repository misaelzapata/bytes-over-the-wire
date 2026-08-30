# agar-clone — Classic agar.io Server

A faithful clone of the **original** agar.io: FFA blobs, mouse-drift movement,
food, split/merge, eject, viruses, mass decay, and a top-10 leaderboard —
nothing modern (no skins/shop, teams, XP, accounts, chat, or alternate modes).

This repository contains the **authoritative Node + `ws` game server**. It
runs a fixed 25 Hz simulation of the classic mechanics, streams a per-viewport
binary snapshot to each client through an Area-of-Interest spatial hash, and
serves the static client from `./client` on port **4100**. See `SPEC.md` for the
precise mechanics, constants, and wire protocol; the design reuses the
`bullseye.io/server` framework (fixed-tick accumulator loop, hand-rolled
little-endian `Writer`/`Reader`, AoI grid, snapshot/name-delta broadcast,
static host + WS-URL rewrite).

## Run

```bash
npm install        # installs ws
node server/index.js   # (or: node server/server.js, or: npm start)
```

Then open <http://localhost:4100> in a browser. Override the port with
`PORT=5000 node server/index.js`.

> The `client/` directory is served as static files at `/`. If it is empty the
> HTTP host still runs (requests 404) and the WebSocket endpoint at `ws://<host>/`
> is fully functional — this package implements the server half.

## What the server simulates (SPEC §3–§10)

- **World**: 14142 × 14142 square arena, hard border clamp.
- **Movement**: each cell drifts toward the player's mouse world-target with
  `speed(mass) = 1100 · mass^-0.44` (bigger = slower), decelerating onto the
  cursor. A separate momentum engine carries split/eject/pop impulses and decays
  each tick.
- **Mass ↔ radius**: `radius = sqrt(100 · mass)`.
- **Food**: 1500-pellet cap, +1 mass, eaten by body overlap, batch-replenished.
- **Eating**: A eats B iff `A.mass ≥ 1.25·B.mass` **and**
  `dist < A.radius − 0.4·B.radius`.
- **Split (space)**: every cell ≥ 35 mass halves and launches (boost 780), cap
  16 cells; per-cell recombine timer `30 + 0.02·mass` s with a 15-tick lockout.
- **Merge**: own cells collide until both timers elapse, then the larger absorbs
  the smaller.
- **Eject (W)**: cell −18 mass → a 13-mass pellet flung at boost 780 with ±0.3
  rad spread (5 mass lost to the void).
- **Viruses**: mass 100, kept in [10, 30]; a cell ≥ 125 covering the center pops
  and scatters into up to 16 pieces; small cells pass under; 7 fed ejected
  pellets make a virus shoot a new virus (boost 780).
- **Mass decay**: 0.2 %/s on cells above mass 100.
- **Bots**: 15 simple AI blobs (flee bigger, chase smaller, graze food, roam,
  snipe-split) so single-player is alive.

## Networking (SPEC §11–§12)

- Fixed-tick accumulator loop at **25 Hz** (`STEP_MS = 40`, 250 ms catch-up cap).
- **SNAPSHOT** every tick, viewport-only via the AoI grid; positions are absolute
  `u16` world coords, sizes `u16`, all little-endian, 1-byte packet ids.
- **Name deltas**: each player's nick is sent once per connection (keyed by
  owner id) and suppressed thereafter; the client caches it.
- **Removal list** per snapshot tells the client which entities left the
  viewport / were consumed, so it can distinguish "eaten" from "moved away".
- **LEADERBOARD** ~1 Hz (top-10 by total mass, with per-viewer `yourRank`),
  **PONG** on demand for clock/RTT sync, **DEATH** when your last cell is eaten.
- No velocity on the wire — the client interpolates remote cells between two
  buffered snapshots and predicts its own cells using the shared `physics.js`
  formulas.

## Server file tree

```
server/
├── server.js     # convenience entrypoint (require ./index.js)
├── index.js      # HTTP static host + WS transport + join sequence + AoI + broadcast pump (25Hz loop)
├── world.js      # authoritative sim: entity maps, tick order, eat/split/merge/eject/virus/decay, leaderboard
├── cell.js       # PlayerCell / Food / Virus / EjectedMass entities
├── player.js     # PlayerTracker: cells[], nick, hue, mouse target, split/eject queue
├── physics.js    # shared formulas: radius↔mass, speed^-0.44, recombine, viewScale/viewHalf
├── protocol.js   # binary LE Writer/Reader + all encoders/decoders (SPEC §12)
├── aoi.js        # uniform spatial hash (AOI_CELL = 1024)
├── constants.js  # SPEC §15 single source of truth
├── bots.js       # simple AI blobs
└── package.json  # deps: ws
```

## Protocol quick reference

**Client → Server**: `0 SET_NICK`, `1 PING`, `2 INPUT_TARGET`, `3 SPLIT`,
`4 EJECT`, `5 RESPAWN`, `255 HANDSHAKE`.

**Server → Client**: `0 WELCOME`, `1 SNAPSHOT`, `2 LEADERBOARD`, `3 PONG`,
`4 DEATH`, `255 VERSION_OUTDATED`.

Full byte layouts are in `SPEC.md` §12 and implemented verbatim in
`server/protocol.js`.
