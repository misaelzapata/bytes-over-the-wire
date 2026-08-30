# agar-clone — Python server variant

A Python 3.12 + aiohttp port of the Node reference server
(`../server`). It is functionally identical and speaks the **exact same
little-endian binary protocol** to the **shared, unmodified client**
(`../client`), which it also serves statically over the same HTTP port.

One process, one port:
- `GET /` (and any static path) → serves `../client`.
- `GET /` with an `Upgrade: websocket` header → binary WebSocket game endpoint.

## Run

PEP-668 (externally-managed environments) requires a venv:

```bash
cd agar-clone/server-python
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python main.py
```

Then open http://localhost:4100/ in a browser.

### Port

The canonical play port for **all** agar-clone language variants is **4100**
(run only one variant at a time). Override with the `PORT` env var:

```bash
PORT=4611 .venv/bin/python main.py
```

## Parity with the Node reference

- **Tick rate:** fixed 25 Hz authoritative sim (`STEP_MS=40`), accumulator loop
  with a 250 ms catch-up cap — identical to `server/index.js`.
- **Constants:** every gameplay number in `constants.py` matches
  `server/constants.js` byte-for-byte in value.
- **Physics:** `radius=sqrt(100·mass)`, `speed=1100·mass^-0.44`,
  recombine ticks, view-scale/AoI half-extent — verbatim from `physics.js`.
  `js_round()` reproduces JavaScript `Math.round` (round-half-up) so wire
  quantization matches exactly.
- **Simulation:** entity model (player cells, food, viruses, ejected mass),
  eat pass, own-cell merge/collision, split/eject/virus-pop, mass decay, bots,
  and the SPEC §11 tick order are all replicated.
- **Protocol:** `protocol.py` mirrors `server/protocol.js` exactly — little
  endian, 1-byte packet ids, absolute-u16 positions, u16 sizes, u32 masses,
  `[u8 len][len × u16 UTF-16 code unit]` strings, and the cell-block name/flag
  deltas (`FLAG_MINE|FLAG_NAME|FLAG_SPLIT`).

### Verification performed

- **Byte-match:** every S→C encoder (WELCOME, SNAPSHOT with eats/cells/food/
  viruses/ejects/removes and a UTF-16 multibyte name, LEADERBOARD, PONG, DEATH,
  VERSION_OUTDATED) produces hex output **identical** to the Node reference
  `protocol.js` for the same inputs.
- **Live round-trip:** a scripted binary WebSocket client completes the join
  handshake (HANDSHAKE → SET_NICK → WELCOME), receives per-tick SNAPSHOTs and
  decodes cells/food/viruses, sees its own `FLAG_MINE` cell, gets a PONG that
  echoes its `clientMs`, and receives a top-10 LEADERBOARD.

## Files

| file           | role                                                    |
|----------------|---------------------------------------------------------|
| `main.py`      | aiohttp HTTP + WS server, AoI, snapshot build, 25Hz loop|
| `world.py`     | authoritative simulation + tick order                   |
| `physics.py`   | shared formulas (radius/speed/recombine/view)           |
| `cell.py`      | entity classes (PlayerCell/Food/Virus/EjectedMass)      |
| `player.py`    | per-player roster + input state                         |
| `aoi.py`       | uniform spatial-hash broad phase                        |
| `bots.py`      | AI blobs                                                 |
| `protocol.py`  | binary (de)serialization                                |
| `constants.py` | all tuning numbers                                      |
