# AGAR-CLONE — Classic agar.io Implementation Spec

A faithful clone of the **ORIGINAL** agar.io: FFA blobs, mouse-drift movement,
food, split/merge, eject, viruses, mass decay, leaderboard. Nothing modern.

**Explicitly EXCLUDED** (do not implement): skins/shop, XP/levels, quests,
minions, accounts/login, chat, teams / experimental / battle-royale / rush /
self-feed modes. Just the classic FFA core.

The networking framework (fixed-tick loop, binary `Writer`/`Reader`, AoI spatial
hash, snapshot/delta broadcast, static-file host + WS-URL rewrite) is **reused
verbatim in pattern** from `../bullseye.io/server/{index,world,protocol,aoi,constants}.js`.
`ws` is a raw binary transport only; all bytes are hand-rolled little-endian.

---

## 0. Wire conventions (identical discipline to the reference)

- Every multibyte number is **little-endian** (`Buffer.*LE` / `DataView(..., true)`).
- Every frame (both directions) starts with a **1-byte packet id** at offset 0.
- Strings = `[u8 length][length × u16 code unit]` (UTF-16 via `charCodeAt`),
  clamped to `NICK_MAX = 15` code units server-side.
- **Quantization is wire-only**; the simulation runs on full-precision floats.
- Coordinate quantization: world positions are sent as **absolute `u16`**
  (world is 0..14142, fits `u16` 0..65535, 1-unit resolution). No signed/offset
  math needed. Sizes (radii) sent as `u16`. Masses on the leaderboard as `u32`.

---

## 1. World, camera, zoom

### 1.1 World
- Square arena, **side `WORLD_SIZE = 14142`** (classic ~14142×14142). Coords run
  `[0, 14142]` on both axes; center is `(7071, 7071)`.
- Hard **world border**: a cell's center is clamped so `radius ≤ x ≤ WORLD_SIZE−radius`
  (same clamp-to-edge as reference `Cell.borderCheck`, but no bounce for players).
- **Faint grid** drawn client-side: light lines every `GRID_STEP = 50` world units,
  plus a solid border rectangle at the world edge.

### 1.2 Camera
- Camera follows the **mass-weighted centroid** of the local player's own cells:
  `cx = Σ(cell.mass·cell.x)/Σmass`, `cy = Σ(cell.mass·cell.y)/Σmass`.
- Smoothed toward the target centroid each frame: `cam += (target − cam)·0.20`.

### 1.3 Zoom (classic formula)
- Let `R = Σ cell.radius` over own cells (the classic "view size" proxy).
- `viewScale = pow( min(64 / R, 1), 0.4 )`  → bigger you are ⇒ smaller scale ⇒ see more.
- Render scale (world→screen px): `scale = viewScale · (screenHeight / BASE_VIEW_H)`,
  with `BASE_VIEW_H = 1080`. A fresh cell (R≈32) renders at scale≈1 (sees ~1080 world
  units tall); a big blob zooms out smoothly.
- Server derives an AoI **view half-extent** from the same `R` so it only streams
  what the client can see (see §9): `viewHalf = (BASE_VIEW_H / 2) / viewScale + AOI_PAD`.

---

## 2. Mass ↔ radius (the single geometric law, from Ogar `Cell.getSize`)

- **`radius = sqrt(100 · mass)` = 10·√mass**   (Ogar: `Math.sqrt(100*mass)`)
- **`mass  = radius² / 100`**
- Examples: mass 1 → r 10 (food); mass 10 → r ≈ 31.6 (spawn); mass 100 → r 100
  (virus); mass 1000 → r ≈ 316.

---

## 3. Movement (mouse drift, speed ∝ mass^-0.44)

Signature agar control: each of your cells continuously drifts toward the **mouse
world target**, decelerating as it arrives.

- Speed (world units / second): **`speed(mass) = SPEED_BASE · mass^(-0.44)`**,
  `SPEED_BASE = 1100` (tunable). Bigger ⇒ slower. (Exponent `-0.44` is the classic
  agar figure; Ogar expresses the equivalent as `playerSpeed·1.6/size^0.32` — same
  monotonic "big = slow" law. We implement the prompt's mass-form exponent.)
- Per-tick integration toward the cursor (Ogar `PlayerCell.move`, deceleration
  built in):
  ```
  dx = mouseX − cell.x ;  dy = mouseY − cell.y ;  dist = hypot(dx,dy)
  step = min(dist, speed(cell.mass) · dt)          // dt = 1/TICK_HZ
  if (dist > 0) { cell.x += dx/dist · step ; cell.y += dy/dist · step }
  ```
  When the cell is within `speed·dt` of the cursor it stops exactly on it — the
  natural agar "ease-in" near the pointer.
- **Momentum engine** (split/eject/pop impulses) is a separate additive vector
  `moveEngine`, applied and decayed each tick: `pos += moveEngine ; moveEngine *= 0.75`
  (Ogar uses 0.89 @25tps; 0.75 chosen for our tick — see §11). While `|moveEngine|`
  is significant the cell is "boosting" and ignores merge collisions.

---

## 4. Food pellets

- Static pellets scattered uniformly. **`FOOD_MASS = 1`** (radius 10),
  **`FOOD_CAP = 1500`**. Colors: random hue per pellet.
- Replenish toward cap in batches: every `FOOD_SPAWN_TICKS = 2` ticks add up to
  `FOOD_SPAWN_BATCH = 20` pellets while `count < FOOD_CAP` (reference `replenishFood`).
- **Eaten by touch**: any player cell whose body overlaps a pellet consumes it
  (`dist(centers) < cell.radius`), `cell.mass += FOOD_MASS`. Food is never subject
  to the 1.25 ratio (it's tiny). Removal is streamed in the snapshot removal list.

---

## 5. Eating (cells)

Cell **A eats cell B** iff BOTH:
1. **Size ratio**: `A.mass ≥ EAT_RATIO · B.mass`, `EAT_RATIO = 1.25`.
2. **Overlap**: `dist(A.center, B.center) < A.radius − EAT_OVERLAP · B.radius`,
   `EAT_OVERLAP = 0.4` (A's center-region must cover B — Ogar's overlap rule).

On eat: `A.mass += B.mass`; B is removed (if B is a player cell, that cell dies;
player dies when their last cell is eaten). Your own cells never eat each other
except during a merge (§7). Food & ejected mass use only the overlap test (rule 1
is auto-satisfied by their tiny mass).

---

## 6. Split (spacebar)

- On SPLIT, **every** own cell with `mass ≥ SPLIT_MIN_MASS (35)` splits, subject to
  the player-wide cap **`MAX_CELLS = 16`** (split the largest cells first until the
  cap is reached).
- Each split: parent keeps `mass/2`; a new cell of `mass/2` spawns at the parent's
  edge offset `SPLIT_OFFSET = 40` toward the cursor, with an impulse
  `moveEngine += dir · SPLIT_BOOST`, `SPLIT_BOOST = 780` (Ogar `splitVelocity`).
- New cell inherits owner, color, position; its **recombine timer** starts (§7).
- Direction = unit vector from cell center to the current mouse world target.

---

## 7. Merge / recombine

- A split cell may **re-merge** with another of the same owner only after its
  recombine timer elapses:
  **`recombineSeconds = 30 + 0.02 · mass`** (Ogar `calcMergeTime`: `base(30) + 0.02·mass`).
- Minimum no-merge lockout of `NO_MERGE_TICKS = 15` right after a split regardless
  of the formula.
- Before both cells are mergeable, own cells **collide** (push apart, cannot
  overlap past `radiusA + radiusB`). Once BOTH are past their timers, collision is
  disabled between them and, when overlapping enough (`dist < max(rA,rB)`), the
  smaller is absorbed into the larger: `big.mass += small.mass`, small removed.
- While a cell is boosting (`|moveEngine|` large, e.g. just split), merge is
  suppressed so freshly-launched cells separate cleanly.

---

## 8. Eject mass (W)

- Each own cell with `mass ≥ EJECT_MIN_MASS (35)` ejects one pellet toward the
  cursor: `cell.mass −= EJECT_LOSS (18)`; spawn an **EjectedMass** entity of
  `EJECT_MASS (13)` (radius ≈ 36) at the cell edge, with
  `moveEngine = dir · EJECT_BOOST(780)` and a small random spread
  `dir` jittered by ±`EJECT_DISPERSION (0.3)` rad.
- The 5-mass difference (`LOSS − MASS`) is lost to the void (anti-inflation).
- Ejected pellets are static once their boost decays; they can be **eaten** by any
  cell (overlap test) or **fed to viruses** (§9). They render smaller/different
  from food and carry the ejector's color.

---

## 9. Viruses (green spiky cells)

- **`VIRUS_MASS = 100`** (radius 100), spiky green. Count kept in
  `[VIRUS_MIN(10), VIRUS_MAX(30)]`; spawn new ones at random empty spots while
  below min. Viruses are static (no drift) unless shot (below).
- **Pop rule**: a player cell **pops** a virus iff `cell.mass ≥ 1.25·VIRUS_MASS`
  (i.e. mass ≥ 125) **and** it covers the virus center
  (`dist < cell.radius − 0.4·virus.radius`). On pop:
  - `cell.mass += VIRUS_MASS`, virus removed.
  - The cell **explodes** into as many pieces as the cap allows:
    `pieces = min(MAX_CELLS − ownCells + 1, floor(cell.mass / SPLIT_MIN_MASS))`.
    Mass is divided across pieces; each new piece launches outward with a
    `moveEngine` impulse (`≈ SPLIT_BOOST`) at spread angles, each starting a fresh
    recombine timer. Result: the classic "you got popped" scatter.
- **Small cells pass under** viruses safely: if `cell.mass < 125`, no interaction
  (virus renders above the cell).
- **Feeding**: an ejected pellet that overlaps a virus is absorbed:
  virus feed counter++ and the virus remembers the feed direction. After
  **`VIRUS_FEED_COUNT = 7`** feeds the virus **shoots a new virus**: it emits a
  fresh `VIRUS_MASS` virus with `moveEngine = feedDir · VIRUS_SPLIT_BOOST(780)`,
  resets its own feed counter, and stays at base mass. The shot virus travels then
  settles (border-clamped). Total viruses may exceed `VIRUS_MAX` transiently via
  feeding; natural spawns stop while at/above max.

---

## 10. Mass decay

- Every own cell above `DECAY_MIN_MASS = 100` slowly bleeds mass:
  **`mass −= mass · DECAY_RATE · dt`** each tick, `DECAY_RATE = 0.002` /s (0.2%/s;
  Ogar's `playerMassDecay` scaled to our tick). Cells at/under 100 don't decay.
- Nothing decays below spawn floor; a cell never drops under `MIN_CELL_MASS = 10`.

---

## 11. Tick, snapshot & broadcast cadence

- **Fixed-tick loop reused from `index.js`**: accumulator, `STEP_MS` step,
  250 ms catch-up cap. **`TICK_HZ = 25`, `STEP_MS = 40`** — matches the tick the
  Ogar constants (boost 780, moveEngine decay, `0.02·mass` merge) were tuned for.
- **Tick order** (mirrors reference `world.step`):
  1. `simTick++`
  2. update bots (share the input path)
  3. apply queued inputs (mouse target, split, eject) per player
  4. integrate cells: mouse-drift move + `moveEngine` + border clamp
  5. own-cell collision / merge resolution
  6. eat pass (cells eat cells, food, ejected mass; virus pop; virus feed) via AoI grid
  7. food replenish (every `FOOD_SPAWN_TICKS`); virus replenish
  8. mass decay
  9. cull dead players / removed entities → build removal list
  10. broadcast (index.js pump)
- **SNAPSHOT** to each client **every tick (25 Hz)** — viewport only (AoI).
- **LEADERBOARD** every `LEADERBOARD_EVERY = 25` ticks (~1 Hz), broadcast to all.
- **PONG** answered immediately on PING. Optional `FULL_STATE`-style resync every
  `RESYNC_EVERY = 250` ticks (~10 s) as a safety net.
- Client renders at `requestAnimationFrame` and **interpolates** remote cells
  between the last two snapshots (buffer ~2 snapshots, render ~1 snapshot behind);
  own cells are client-predicted from local mouse for zero input lag, reconciled to
  server state.

---

## 12. Binary protocol

### 12.1 Packet id tables

**Client → Server**
| id  | name          | payload |
|-----|---------------|---------|
| 0   | SET_NICK      | `[u8 len][len × u16 char]` |
| 1   | PING          | `[u32 clientMs]` |
| 2   | INPUT_TARGET  | `[u16 mouseWorldX][u16 mouseWorldY]` (mouse drift target; throttle ~20–30 Hz) |
| 3   | SPLIT         | *(no payload)* — spacebar |
| 4   | EJECT         | *(no payload)* — W |
| 5   | RESPAWN       | *(no payload)* — request respawn after death |
| 255 | HANDSHAKE     | `[u32 protocolVersion]` |

**Server → Client**
| id  | name             | payload |
|-----|------------------|---------|
| 0   | WELCOME          | `[u32 yourPlayerId][u16 worldW][u16 worldH][u32 serverTick]` |
| 1   | SNAPSHOT         | viewport delta — see §12.2 |
| 2   | LEADERBOARD      | `[u8 n]{ u32 playerId, u32 mass, str name } [u8 yourRank]` (yourRank 0 = outside top-10) |
| 3   | PONG             | `[u32 clientMs][u32 serverTick]` |
| 4   | DEATH            | `[u32 finalMass]` — your last cell was eaten |
| 255 | VERSION_OUTDATED | *(no payload)* |

### 12.2 SNAPSHOT layout (id 1) — viewport of cells / food / viruses / eject
```
u8   id = 1
u32  serverTick
u16  nEat            ; { u32 eaterId, u32 eatenId }  (for eat FX / prompt removal)
u16  nCells          ; CELL_BLOCK ×nCells
u16  nFood           ; { u32 id, u16 x, u16 y, u8 hue }
u16  nVirus          ; { u32 id, u16 x, u16 y, u16 size }
u16  nEject          ; { u32 id, u16 x, u16 y, u8 hue }
u16  nRemove         ; { u32 id }   (entities that left the viewport / were consumed)
```
**CELL_BLOCK**
```
u32  id
u32  ownerPlayerId
u16  x
u16  y
u16  size            ; radius; mass = size²/100
u8   hue             ; 0..255 → HSL color (cheap, always sent)
u8   flags           ; bit0 isMine, bit1 namePresent, bit2 isSplitting(boosting)
[if namePresent] str name    ; sent once per ownerId (first appearance for this client)
```
- **Name deltas**: the server tracks `seenNames` per connection keyed by
  `ownerPlayerId` (reference pattern). First time a client sees any cell of a
  player, `namePresent=1` and the nick is included; afterwards suppressed (`u8 0`).
  Client caches nick by ownerId and reuses it for all that player's cells.
- **No velocity on the wire** — the client interpolates positions between the two
  most recent snapshots (agar approach); own cells are locally predicted.

### 12.3 Join / clock sequence (reference §4.2 pattern)
`HANDSHAKE(version)` → server checks `PROTOCOL_VERSION`, replies `VERSION_OUTDATED`
+ close on mismatch → `SET_NICK(name)` → server allocates player, safe-spawns one
cell, sends **`WELCOME`** (yourId + world dims + serverTick to seed the client
clock) → first `SNAPSHOT` next tick. `PING`↔`PONG` for RTT/clock sync.

---

## 13. Leaderboard

- Top-10 players by **total mass** (`Σ cell.mass` over the player's live cells),
  sorted desc, sent at ~1 Hz (`LEADERBOARD_EVERY`).
- `yourRank` byte lets the client **highlight your row** even if you're #1..#10;
  if you're outside the top-10 (`yourRank == 0`) the client still shows your name/rank
  locally from your own known mass.
- Rendered top-right, classic agar style: numbered list, own row highlighted.

---

## 14. Rendering & feel (client)

- Cells: filled circle (hue→HSL), slightly darker ring, white centered **name**
  and (optional) mass label; sized by `radius` in screen px via §1.3 scale.
- **Smooth interpolation** of remote cells (lerp between buffered snapshots);
  size also lerps so growth/eat looks smooth. Own cells predicted locally.
- Viruses: green spiky polygon ring at `radius`. Food/eject: small solid dots.
- Faint grid + world border (§1.1). Leaderboard + your-mass HUD + FPS/ping debug.
- Death → dim overlay + `RESPAWN` on click/enter.

---

## 15. Constants (server `constants.js`; client mirrors numeric values + formulas)

| name | value | name | value |
|------|-------|------|-------|
| `WORLD_SIZE` | 14142 | `TICK_HZ` | 25 |
| `GRID_STEP` | 50 | `STEP_MS` | 40 |
| `SPAWN_MASS` | 10 | `MIN_CELL_MASS` | 10 |
| `MAX_CELLS` | 16 | `EAT_RATIO` | 1.25 |
| `EAT_OVERLAP` | 0.4 | `SPEED_BASE` | 1100 |
| `SPEED_EXP` | −0.44 | `MOVEENGINE_DECAY` | 0.75 |
| `SPLIT_MIN_MASS` | 35 | `SPLIT_BOOST` | 780 |
| `SPLIT_OFFSET` | 40 | `NO_MERGE_TICKS` | 15 |
| `MERGE_BASE_S` | 30 | `MERGE_PER_MASS_S` | 0.02 |
| `EJECT_MIN_MASS` | 35 | `EJECT_LOSS` | 18 |
| `EJECT_MASS` | 13 | `EJECT_BOOST` | 780 |
| `EJECT_DISPERSION` | 0.3 | `FOOD_MASS` | 1 |
| `FOOD_CAP` | 1500 | `FOOD_SPAWN_TICKS` | 2 |
| `FOOD_SPAWN_BATCH` | 20 | `VIRUS_MASS` | 100 |
| `VIRUS_MIN` | 10 | `VIRUS_MAX` | 30 |
| `VIRUS_FEED_COUNT` | 7 | `VIRUS_SPLIT_BOOST` | 780 |
| `DECAY_MIN_MASS` | 100 | `DECAY_RATE` | 0.002 /s |
| `LEADERBOARD_EVERY` | 25 | `RESYNC_EVERY` | 250 |
| `BASE_VIEW_H` | 1080 | `AOI_PAD` | 400 |
| `AOI_CELL` | 1024 | `PROTOCOL_VERSION` | 1 |
| `NICK_MAX` | 15 | `BOT_COUNT` | 15 |

**Shared formulas (client duplicates verbatim):**
```
radius(mass)      = Math.sqrt(100 * mass)
mass(radius)      = radius*radius / 100
speed(mass)       = SPEED_BASE * Math.pow(mass, -0.44)
recombineS(mass)  = MERGE_BASE_S + MERGE_PER_MASS_S * mass
viewScale(R)      = Math.pow(Math.min(64 / R, 1), 0.4)     // R = Σ own radii
```

---

## 16. File tree

```
agar-clone/
├── SPEC.md
├── server/
│   ├── server.js          # entrypoint (require index.js) — reference pattern
│   ├── index.js           # HTTP static host + WS-URL rewrite + ws transport +
│   │                      #   join sequence + AoI collect + broadcast pump (60→25Hz loop)
│   ├── world.js           # authoritative sim: entity maps, tick order, eat/split/merge/
│   │                      #   eject/virus/decay, leaderboard rows
│   ├── cell.js            # Cell base + PlayerCell / Food / Virus / EjectedMass classes
│   ├── player.js          # PlayerTracker: cells[], nick, hue, mouse target, split/eject queue
│   ├── physics.js         # shared formulas: radius↔mass, speed, merge time, eat test, decay
│   ├── protocol.js        # binary Writer/Reader + all encoders/decoders (§12)
│   ├── aoi.js             # uniform spatial hash (reused verbatim; AOI_CELL=1024)
│   ├── constants.js       # §15 single source of truth
│   ├── bots.js            # simple AI (wander→food, flee bigger, chase smaller); reference pattern
│   └── package.json       # deps: ws
└── client/
    ├── index.html         # canvas + nick menu overlay + HUD
    ├── css/
    │   └── style.css       # menu, leaderboard, HUD styling
    └── js/
        ├── main.js         # bootstrap, menu→join, game loop (rAF), state store
        ├── net.js          # WebSocket (ws://location.host), send/recv dispatch, snapshot buffer
        ├── protocol.js      # mirrors server byte layouts EXACTLY (§12)
        ├── constants.js     # mirrors §15 numbers + shared formulas
        ├── input.js         # mouse→INPUT_TARGET (throttled), space→SPLIT, W→EJECT
        ├── interpolate.js   # remote-cell snapshot interpolation + own-cell prediction
        └── render.js        # camera/zoom, grid+border, cells+names, food, viruses, eject,
                             #   leaderboard, HUD, death overlay
```

---

## 17. Server↔client parity checklist

- `constants.js` numeric values identical on both sides; `physics.js` formulas
  (radius/mass, speed^-0.44, viewScale, recombineS) duplicated verbatim client-side.
- `protocol.js` byte layouts byte-for-byte mirrored (LE, 1-byte ids, `u16` abs
  coords, UTF-16 strings).
- Own-cell client prediction uses the SAME `speed(mass)` + move integration so
  prediction matches server; server state is authoritative and reconciles.
```
