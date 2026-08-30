# VANDAL — Python server (aiohttp)

A functionally identical Python 3.12 port of the reference Node server
(`../server`). It serves the **unchanged** shared client (`../client`) and
speaks the **exact same little-endian binary protocol**, so the same browser
client works against it byte-for-byte.

- Serves the static client from `../client` over HTTP **and** accepts the
  WebSocket upgrade at `/` on **one port**.
- Authoritative `asyncio` fixed-tick loop at ~20 Hz (accumulator, 250 ms
  catch-up cap) driving painter bots, ~20 Hz cursor snapshots, ~1 Hz presence,
  and the periodic gallery fly-through cue.
- Binary framing via `struct` (little-endian); strings are
  `[u8 len][len × u16 code unit]` UTF-16, matching the reference.

## Run

Python 3.12 is externally managed (PEP 668), so a venv is required:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python main.py
```

Then open http://localhost:4504/.

### Port

The canonical play port for vandal is **4504** (default; all language variants
share it — run one at a time). Override with the `PORT` env var:

```bash
PORT=4617 .venv/bin/python main.py
```

## Files

- `main.py` — aiohttp HTTP + WebSocket server, world state, 20 Hz game loop.
- `protocol.py` — binary (de)serialization; byte-for-byte mirror of the reference.
- `mural.py` — authoritative stroke history + live open strokes.
- `bots.py` — cooperative painter bots that trace words/figures.
- `constants.py` — shared tuning numbers (must match the client).

## Protocol parity

Verified against the Node reference:

- All 12 server→client encoders produce byte-identical frames.
- Client→server decoders produce identical parses in both directions.
- The unchanged shared client joins in headless Chrome (WELCOME → HISTORY →
  live STROKE/CURSORS/PRESENCE/PONG) with zero console errors.
