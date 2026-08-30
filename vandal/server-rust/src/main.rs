// ===========================================================================
// VANDAL — cooperative collaborative-mural game server (Rust + tokio).
//
// A functional port of the reference Node server (../server). It:
//   - Serves the static client from ../client over HTTP on PORT (default 4504).
//   - Accepts binary WebSocket upgrades at "/" (little-endian frames; see
//     protocol.js for the documented wire spec — mirrored byte-for-byte here).
//   - Keeps the authoritative stroke history (Mural). New joiners are handed the
//     whole mural (HISTORY) plus any in-progress live strokes; every stroke is
//     broadcast to everyone as BEGIN -> APPEND* -> STROKE(commit).
//   - Runs a fixed 20 Hz loop for painter-bots, ~20 Hz live cursor snapshots,
//     ~1 Hz PRESENCE, and a periodic coordinated GALLERY fly-through cue.
//
// One tokio task owns ALL game state; connection tasks funnel decoded frames in
// over an mpsc channel and receive personal frames back over a per-conn channel.
// The same TCP port serves static HTTP and upgrades "/" WS conns (routed by
// peeking the request head).  Run:  cargo run --release
// ===========================================================================

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{interval, Duration, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;

// ---------------------------------------------------------------------------
// Tuning constants — mirror constants.js (and client/js/constants.js) exactly.
// ---------------------------------------------------------------------------
mod c {
    pub const CANVAS_W: i32 = 4000;
    pub const CANVAS_H: i32 = 2500;

    pub const STEP_MS: u64 = 50; // 20 Hz

    pub const PRESENCE_EVERY: u32 = 20; // ~1 Hz
    pub const CURSORS_EVERY: u32 = 1; // ~20 Hz
    pub const GALLERY_EVERY: u32 = 1600; // ~80 s
    pub const GALLERY_MS: i32 = 9000;

    pub const TOOL_COUNT: i32 = 6;
    pub const SIZE_COUNT: i32 = 3;
    pub const PALETTE_COUNT: i32 = 14;

    pub const MAX_POINTS: usize = 600;
    pub const MAX_STROKES: usize = 4000;

    pub const PROTOCOL_VERSION: u32 = 3;
    pub const NICK_MAX: usize = 15;

    pub const BOT_COUNT: usize = 5;
}

// --- packet ids: server -> client ------------------------------------------
mod s2c {
    pub const WELCOME: u8 = 0;
    pub const HISTORY: u8 = 1;
    pub const STROKE: u8 = 2;
    pub const UNDO: u8 = 3;
    pub const PRESENCE: u8 = 4;
    pub const GALLERY: u8 = 5;
    pub const PONG: u8 = 6;
    pub const CURSORS: u8 = 7;
    pub const STROKE_BEGIN: u8 = 8;
    pub const STROKE_APPEND: u8 = 9;
    pub const VERSION_OUTDATED: u8 = 255;
}

const CUR_PRESSING: u8 = 1 << 0;

fn clampf(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}
fn clampi(v: i32, lo: i32, hi: i32) -> i32 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}
// Round-then-clamp, matching mural.js clampInt (Math.round + clamp).
fn clamp_int(v: f64, lo: i32, hi: i32) -> i32 {
    clampi(v.round() as i32, lo, hi)
}

// ---------------------------------------------------------------------------
// Tiny xorshift RNG (keeps deps lean — matches Math.random() behavior/ranges).
// ---------------------------------------------------------------------------
struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed | 1)
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    // [0,1)
    fn f(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.f()
    }
    // inclusive integer [lo,hi] — matches randInt = floor(rand(lo,hi+1))
    fn range_int(&mut self, lo: i32, hi: i32) -> i32 {
        (self.range(lo as f64, (hi + 1) as f64)).floor() as i32
    }
    fn pick<'a, T>(&mut self, a: &'a [T]) -> &'a T {
        &a[self.range_int(0, a.len() as i32 - 1) as usize]
    }
}

fn seed_now(salt: u64) -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9e37_79b9_7f4a_7c15);
    n ^ salt.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1
}

// ---------------------------------------------------------------------------
// Little-endian byte Writer. str layout = [u8 len][len x u16 UTF-16 code unit],
// matching JS charCodeAt; nick clamped to NICK_MAX code units like Writer.str.
// ---------------------------------------------------------------------------
struct Writer(Vec<u8>);
impl Writer {
    fn with_id(id: u8) -> Self {
        Writer(vec![id])
    }
    fn u8(&mut self, v: u8) -> &mut Self {
        self.0.push(v);
        self
    }
    fn u16(&mut self, v: u16) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn u32(&mut self, v: u32) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn str(&mut self, s: &str) -> &mut Self {
        let units: Vec<u16> = s.encode_utf16().take(c::NICK_MAX).collect();
        self.0.push(units.len() as u8);
        for u in units {
            self.0.extend_from_slice(&u.to_le_bytes());
        }
        self
    }
    fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}

// Little-endian byte Reader for client->server frames.
struct Reader<'a> {
    d: &'a [u8],
    p: usize,
}
impl<'a> Reader<'a> {
    fn new(d: &'a [u8]) -> Self {
        Reader { d, p: 0 }
    }
    fn u8(&mut self) -> Option<u8> {
        let v = *self.d.get(self.p)?;
        self.p += 1;
        Some(v)
    }
    fn u16(&mut self) -> Option<u16> {
        let b = self.d.get(self.p..self.p + 2)?;
        self.p += 2;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Option<u32> {
        let b = self.d.get(self.p..self.p + 4)?;
        self.p += 4;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn str(&mut self) -> Option<String> {
        let len = self.u8()? as usize;
        let mut units = Vec::with_capacity(len);
        for _ in 0..len {
            units.push(self.u16()?);
        }
        Some(String::from_utf16_lossy(&units))
    }
    fn remaining(&self) -> usize {
        self.d.len().saturating_sub(self.p)
    }
}

// ---------------------------------------------------------------------------
// Stroke model — the wire STROKE_BLOCK plus in-memory open-stroke bookkeeping.
// ---------------------------------------------------------------------------
#[derive(Clone)]
struct Stroke {
    id: u32,
    owner: u32,
    tool: u8,
    color: u8,
    size: u8,
    flags: u8,
    points: Vec<(i32, i32)>, // already round+clamped to canvas
}

#[derive(Clone, Copy)]
struct Meta {
    tool: u8,
    color: u8,
    size: u8,
    flags: u8,
}

fn norm(tool: i32, color: i32, size: i32, flags: i32) -> Meta {
    Meta {
        tool: clampi(tool, 0, c::TOOL_COUNT - 1) as u8,
        color: clampi(color, 0, c::PALETTE_COUNT - 1) as u8,
        size: clampi(size, 0, c::SIZE_COUNT - 1) as u8,
        flags: (flags & 0xff) as u8,
    }
}

// SHAPE tools (line/rect/circle) need >=2 points.
fn is_shape_tool(t: u8) -> bool {
    t == 1 || t == 2 || t == 3
}

// ---------------------------------------------------------------------------
// Mural — authoritative shared-canvas history (never rasterizes).
// ---------------------------------------------------------------------------
struct Mural {
    strokes: Vec<Stroke>,        // ordered oldest -> newest (completed)
    open: HashMap<u32, Stroke>,  // ownerId -> open stroke being streamed
    order: Vec<u32>,             // stable open-iteration order (for join replay)
    next_stroke_id: u32,
}

struct AppendResult {
    appended: Vec<(i32, i32)>,
    full: bool,
}

impl Mural {
    fn new() -> Self {
        Mural {
            strokes: Vec::new(),
            open: HashMap::new(),
            order: Vec::new(),
            next_stroke_id: 1,
        }
    }

    fn alloc_stroke_id(&mut self) -> u32 {
        let id = self.next_stroke_id;
        self.next_stroke_id += 1;
        id
    }

    fn push_capped(&mut self, stroke: Stroke) {
        self.strokes.push(stroke);
        if self.strokes.len() > c::MAX_STROKES {
            let drop = self.strokes.len() - c::MAX_STROKES;
            self.strokes.drain(0..drop);
        }
    }

    // one-shot completed stroke (shapes + eraser). Returns Some or None.
    fn commit_stroke(
        &mut self,
        owner: u32,
        m: Meta,
        raw_points: &[(i32, i32)],
    ) -> Option<Stroke> {
        let mut pts = raw_points;
        if pts.len() > c::MAX_POINTS {
            pts = &pts[..c::MAX_POINTS];
        }
        let mut points: Vec<(i32, i32)> = Vec::with_capacity(pts.len());
        for &(x, y) in pts {
            points.push((
                clamp_int(x as f64, 0, c::CANVAS_W),
                clamp_int(y as f64, 0, c::CANVAS_H),
            ));
        }
        if points.is_empty() {
            return None;
        }
        if is_shape_tool(m.tool) && points.len() < 2 {
            return None;
        }
        let stroke = Stroke {
            id: self.alloc_stroke_id(),
            owner,
            tool: m.tool,
            color: m.color,
            size: m.size,
            flags: m.flags,
            points,
        };
        self.push_capped(stroke.clone());
        Some(stroke)
    }

    // streaming: begin a fresh open stroke, returns a clone for broadcast.
    fn begin(&mut self, owner: u32, m: Meta, x: f64, y: f64) -> Stroke {
        let stroke = Stroke {
            id: self.alloc_stroke_id(),
            owner,
            tool: m.tool,
            color: m.color,
            size: m.size,
            flags: m.flags,
            points: vec![(
                clamp_int(x, 0, c::CANVAS_W),
                clamp_int(y, 0, c::CANVAS_H),
            )],
        };
        if !self.open.contains_key(&owner) {
            self.order.push(owner);
        }
        self.open.insert(owner, stroke.clone());
        stroke
    }

    fn append(&mut self, owner: u32, pts: &[(f64, f64)]) -> AppendResult {
        let open = match self.open.get_mut(&owner) {
            Some(o) => o,
            None => {
                return AppendResult {
                    appended: Vec::new(),
                    full: false,
                }
            }
        };
        let mut appended = Vec::new();
        for &(x, y) in pts {
            if open.points.len() >= c::MAX_POINTS {
                break;
            }
            let q = (
                clamp_int(x, 0, c::CANVAS_W),
                clamp_int(y, 0, c::CANVAS_H),
            );
            open.points.push(q);
            appended.push(q);
        }
        AppendResult {
            appended,
            full: open.points.len() >= c::MAX_POINTS,
        }
    }

    fn is_open(&self, owner: u32) -> bool {
        self.open.contains_key(&owner)
    }

    fn open_id(&self, owner: u32) -> Option<u32> {
        self.open.get(&owner).map(|s| s.id)
    }

    // finalize an owner's open stroke into history. Returns it or None.
    fn end(&mut self, owner: u32) -> Option<Stroke> {
        let open = self.open.remove(&owner)?;
        self.order.retain(|&o| o != owner);
        if open.points.is_empty() {
            return None;
        }
        self.push_capped(open.clone());
        Some(open)
    }

    // remove the most recent completed stroke by owner. Returns id or 0.
    fn undo_last(&mut self, owner: u32) -> u32 {
        for i in (0..self.strokes.len()).rev() {
            if self.strokes[i].owner == owner {
                let id = self.strokes[i].id;
                self.strokes.remove(i);
                return id;
            }
        }
        0
    }
}

// ===========================================================================
// Server -> Client encoders (mirror protocol.js byte-for-byte).
// ===========================================================================

fn write_stroke_block(w: &mut Writer, s: &Stroke) {
    w.u32(s.id)
        .u32(s.owner)
        .u8(s.tool)
        .u8(s.color)
        .u8(s.size)
        .u8(s.flags)
        .u16(s.points.len() as u16);
    for &(x, y) in &s.points {
        w.u16(clamp_int(x as f64, 0, c::CANVAS_W) as u16)
            .u16(clamp_int(y as f64, 0, c::CANVAS_H) as u16);
    }
}

fn enc_welcome(your_id: u32, server_tick: u32) -> Vec<u8> {
    let mut w = Writer::with_id(s2c::WELCOME);
    w.u32(your_id)
        .u16(c::CANVAS_W as u16)
        .u16(c::CANVAS_H as u16)
        .u32(server_tick);
    w.into_bytes()
}

fn enc_history(strokes: &[Stroke]) -> Vec<u8> {
    let mut w = Writer::with_id(s2c::HISTORY);
    w.u32(strokes.len() as u32);
    for s in strokes {
        write_stroke_block(&mut w, s);
    }
    w.into_bytes()
}

fn enc_stroke(s: &Stroke) -> Vec<u8> {
    let mut w = Writer::with_id(s2c::STROKE);
    write_stroke_block(&mut w, s);
    w.into_bytes()
}

fn enc_stroke_begin(s: &Stroke) -> Vec<u8> {
    let p0 = s.points.first().copied().unwrap_or((0, 0));
    let mut w = Writer::with_id(s2c::STROKE_BEGIN);
    w.u32(s.id)
        .u32(s.owner)
        .u8(s.tool)
        .u8(s.color)
        .u8(s.size)
        .u8(s.flags)
        .u16(clamp_int(p0.0 as f64, 0, c::CANVAS_W) as u16)
        .u16(clamp_int(p0.1 as f64, 0, c::CANVAS_H) as u16);
    w.into_bytes()
}

fn enc_stroke_append(id: u32, pts: &[(i32, i32)]) -> Vec<u8> {
    let mut w = Writer::with_id(s2c::STROKE_APPEND);
    w.u32(id).u16(pts.len() as u16);
    for &(x, y) in pts {
        w.u16(clamp_int(x as f64, 0, c::CANVAS_W) as u16)
            .u16(clamp_int(y as f64, 0, c::CANVAS_H) as u16);
    }
    w.into_bytes()
}

fn enc_undo(stroke_id: u32) -> Vec<u8> {
    let mut w = Writer::with_id(s2c::UNDO);
    w.u32(stroke_id);
    w.into_bytes()
}

fn enc_presence(count: u16) -> Vec<u8> {
    let mut w = Writer::with_id(s2c::PRESENCE);
    w.u16(count);
    w.into_bytes()
}

struct CursorOut {
    id: u32,
    x: f64,
    y: f64,
    pressing: bool,
    color: u8,
    tool: u8,
    name: String,
}

fn enc_cursors(list: &[CursorOut]) -> Vec<u8> {
    let mut w = Writer::with_id(s2c::CURSORS);
    w.u16(list.len() as u16);
    for cch in list {
        w.u32(cch.id)
            .u16(clamp_int(cch.x, 0, 65535) as u16)
            .u16(clamp_int(cch.y, 0, 65535) as u16)
            .u8(if cch.pressing { CUR_PRESSING } else { 0 })
            .u8(cch.color)
            .u8(cch.tool)
            .str(&cch.name);
    }
    w.into_bytes()
}

fn enc_gallery(cx: f64, cy: f64, half: f64, dur_ms: i32) -> Vec<u8> {
    let mut w = Writer::with_id(s2c::GALLERY);
    w.u16(clamp_int(cx, 0, 65535) as u16)
        .u16(clamp_int(cy, 0, 65535) as u16)
        .u16(clamp_int(half, 1, 65535) as u16)
        .u16(clamp_int(dur_ms as f64, 0, 65535) as u16);
    w.into_bytes()
}

fn enc_pong(client_ms: u32, server_tick: u32) -> Vec<u8> {
    let mut w = Writer::with_id(s2c::PONG);
    w.u32(client_ms).u32(server_tick);
    w.into_bytes()
}

fn enc_version_outdated() -> Vec<u8> {
    vec![s2c::VERSION_OUTDATED]
}

// ===========================================================================
// Client -> Server decoding.
// ===========================================================================

enum ClientMsg {
    Handshake { version: u32 },
    Nick { name: String },
    Ping { client_ms: u32 },
    Stroke { meta: Meta, points: Vec<(i32, i32)> },
    StrokeBegin { meta: Meta, x: i32, y: i32 },
    StrokeAppend { points: Vec<(i32, i32)> },
    StrokeEnd,
    Cursor { x: i32, y: i32, pressing: bool, color: u8, tool: u8 },
    Undo,
}

fn read_points(r: &mut Reader, cap: usize) -> Vec<(i32, i32)> {
    let mut n = r.u16().unwrap_or(0) as usize;
    if n > cap {
        n = cap;
    }
    let mut points = Vec::with_capacity(n);
    for _ in 0..n {
        if r.remaining() < 4 {
            break;
        }
        let x = r.u16().unwrap_or(0) as i32;
        let y = r.u16().unwrap_or(0) as i32;
        points.push((x, y));
    }
    points
}

fn decode_client(buf: &[u8]) -> Option<ClientMsg> {
    if buf.is_empty() {
        return None;
    }
    let mut r = Reader::new(buf);
    let id = r.u8()?;
    match id {
        255 => {
            let version = if buf.len() >= 5 { r.u32().unwrap_or(0) } else { 0 };
            Some(ClientMsg::Handshake { version })
        }
        0 => {
            if buf.len() < 2 {
                return Some(ClientMsg::Nick { name: String::new() });
            }
            Some(ClientMsg::Nick {
                name: r.str().unwrap_or_default(),
            })
        }
        1 => {
            let client_ms = if buf.len() >= 5 { r.u32().unwrap_or(0) } else { 0 };
            Some(ClientMsg::Ping { client_ms })
        }
        2 => {
            if buf.len() < 7 {
                return None;
            }
            let tool = r.u8()? as i32;
            let color = r.u8()? as i32;
            let size = r.u8()? as i32;
            let flags = r.u8()? as i32;
            let points = read_points(&mut r, c::MAX_POINTS);
            Some(ClientMsg::Stroke {
                meta: norm(tool, color, size, flags),
                points,
            })
        }
        4 => {
            if buf.len() < 9 {
                return None;
            }
            let tool = r.u8()? as i32;
            let color = r.u8()? as i32;
            let size = r.u8()? as i32;
            let flags = r.u8()? as i32;
            let x = r.u16()? as i32;
            let y = r.u16()? as i32;
            Some(ClientMsg::StrokeBegin {
                meta: norm(tool, color, size, flags),
                x,
                y,
            })
        }
        5 => {
            if buf.len() < 3 {
                return None;
            }
            let points = read_points(&mut r, c::MAX_POINTS);
            Some(ClientMsg::StrokeAppend { points })
        }
        6 => Some(ClientMsg::StrokeEnd),
        7 => {
            if buf.len() < 8 {
                return None;
            }
            let x = r.u16()? as i32;
            let y = r.u16()? as i32;
            let flags = r.u8()?;
            let color = r.u8()?;
            let tool = r.u8()?;
            Some(ClientMsg::Cursor {
                x,
                y,
                pressing: (flags & CUR_PRESSING) != 0,
                color,
                tool,
            })
        }
        3 => Some(ClientMsg::Undo),
        _ => None,
    }
}

// ===========================================================================
// Painter bots — cooperative co-creators tracing words/figures (port bots.js).
// ===========================================================================

const VIVID: [u8; 10] = [3, 4, 5, 7, 8, 9, 10, 11, 12, 13];
const WORDS: [&str; 13] = [
    "HI", "YO", "OK", "ART", "SUN", "WOW", "HEY", "LOVE", "COOL", "PLAY", "STAR",
    "VIBE", "NICE",
];
const FIGURES: [&str; 8] = [
    "heart", "star", "sun", "house", "flower", "smiley", "bolt", "spiral",
];
const BOT_NAMES: [&str; 15] = [
    "Sable", "Ochre", "Marigold", "Sienna", "Clementine", "Poppy", "Hazel",
    "Saffron", "Coral", "Amber", "Rusty", "Juniper", "Cleo", "Bruno", "Pixel",
];

const TOOL_BRUSH: u8 = 0;
const TOOL_SPRAY: u8 = 5;
const FLAG_SOFT: u8 = 1;

type P = (f64, f64);

struct Plan {
    meta: Meta,
    strokes: Vec<Vec<P>>,
    si: usize,
    pi: usize,
    open: bool,
}

struct Bot {
    id: u32,
    name: String,
    cx: f64,
    cy: f64,
    color: u8,
    plan: Option<Plan>,
    cooldown: i32,
    press: i32,
}

enum BotEvent {
    Begin { owner: u32, meta: Meta, x: f64, y: f64 },
    Append { owner: u32, points: Vec<P> },
    End { owner: u32 },
}

struct BotManager {
    bots: Vec<Bot>,
    rng: Rng,
}

impl BotManager {
    fn new(seed: u64) -> Self {
        BotManager {
            bots: Vec::new(),
            rng: Rng::new(seed),
        }
    }

    fn spawn(&mut self, id: u32) {
        let name = self.rng.pick(&BOT_NAMES).to_string();
        let cx = self.rng.range(0.15, 0.85) * c::CANVAS_W as f64;
        let cy = self.rng.range(0.15, 0.85) * c::CANVAS_H as f64;
        let color = *self.rng.pick(&VIVID);
        let cooldown = self.rng.range_int(10, 70);
        self.bots.push(Bot {
            id,
            name,
            cx,
            cy,
            color,
            plan: None,
            cooldown,
            press: 0,
        });
    }

    fn count(&self) -> usize {
        self.bots.len()
    }

    fn cursors(&self) -> Vec<CursorOut> {
        self.bots
            .iter()
            .map(|b| CursorOut {
                id: b.id,
                x: b.cx,
                y: b.cy,
                pressing: b.press > 0,
                color: b.color,
                tool: 5, // bots use spray can
                name: b.name.clone(),
            })
            .collect()
    }

    fn update(&mut self) -> Vec<BotEvent> {
        let mut events = Vec::new();
        for i in 0..self.bots.len() {
            if self.bots[i].press > 0 {
                self.bots[i].press -= 1;
            }
            if self.bots[i].plan.is_none() {
                self.bots[i].cooldown -= 1;
                if self.bots[i].cooldown > 0 {
                    // idle drift so the hovering cursor feels alive
                    let dx = self.rng.range(-6.0, 6.0);
                    let dy = self.rng.range(-6.0, 6.0);
                    self.bots[i].cx =
                        clampf(self.bots[i].cx + dx, 20.0, c::CANVAS_W as f64 - 20.0);
                    self.bots[i].cy =
                        clampf(self.bots[i].cy + dy, 20.0, c::CANVAS_H as f64 - 20.0);
                    continue;
                }
                let plan = self.make_plan(i);
                self.bots[i].plan = Some(plan);
            }
            self.advance(i, &mut events);
        }
        events
    }

    fn make_plan(&mut self, i: usize) -> Plan {
        let want_word = self.rng.f() < 0.5;
        let color = *self.rng.pick(&VIVID);
        self.bots[i].color = color;
        let spray = self.rng.f() < 0.35;
        let meta = Meta {
            tool: if spray { TOOL_SPRAY } else { TOOL_BRUSH },
            color,
            size: if spray { 2 } else { self.rng.range_int(1, 2) as u8 },
            flags: if spray { 0 } else { FLAG_SOFT },
        };

        let (local_subs, em_w, em_h): (Vec<Vec<P>>, f64, f64) = if want_word {
            let word = self.rng.pick(&WORDS).to_string();
            let (subs, w) = build_word(&word);
            (subs, w, 1.0)
        } else {
            let fig = self.rng.pick(&FIGURES).to_string();
            (build_figure(&fig), 1.0, 1.0)
        };

        let mut em = self.rng.range(180.0, 340.0);
        let margin = 80.0_f64;
        let max_w = c::CANVAS_W as f64 - margin * 2.0;
        let max_h = c::CANVAS_H as f64 - margin * 2.0;
        if em_w * em > max_w {
            em = max_w / em_w;
        }
        if em_h * em > max_h {
            em = max_h / em_h;
        }
        let world_w = em_w * em;
        let world_h = em_h * em;
        let ox = self.rng.range(margin, c::CANVAS_W as f64 - margin - world_w);
        let oy = self.rng.range(margin, c::CANVAS_H as f64 - margin - world_h);

        let step = (em * 0.06).max(10.0);
        let mut strokes: Vec<Vec<P>> = Vec::new();
        for sub in &local_subs {
            let world: Vec<P> = sub
                .iter()
                .map(|p| (ox + p.0 * em, oy + p.1 * em))
                .collect();
            let rs = resample(&world, step);
            if !rs.is_empty() {
                strokes.push(rs);
            }
        }

        Plan {
            meta,
            strokes,
            si: 0,
            pi: 0,
            open: false,
        }
    }

    fn advance(&mut self, i: usize, events: &mut Vec<BotEvent>) {
        // done?
        {
            let done = {
                let plan = self.bots[i].plan.as_ref().unwrap();
                plan.si >= plan.strokes.len()
            };
            if done {
                self.bots[i].plan = None;
                self.bots[i].cooldown = self.rng.range_int(30, 110);
                return;
            }
        }

        let owner = self.bots[i].id;
        let bot = &mut self.bots[i];
        let plan = bot.plan.as_mut().unwrap();
        let sub_len = plan.strokes[plan.si].len();

        if !plan.open {
            let p0 = plan.strokes[plan.si][0];
            bot.cx = p0.0;
            bot.cy = p0.1;
            bot.press = 4;
            plan.open = true;
            plan.pi = 1;
            events.push(BotEvent::Begin {
                owner,
                meta: plan.meta,
                x: p0.0,
                y: p0.1,
            });
            if sub_len == 1 {
                events.push(BotEvent::End { owner });
                plan.open = false;
                plan.si += 1;
            }
            return;
        }

        const BATCH: usize = 3;
        let mut pts: Vec<P> = Vec::new();
        let mut k = 0;
        while k < BATCH && plan.pi < sub_len {
            pts.push(plan.strokes[plan.si][plan.pi]);
            plan.pi += 1;
            k += 1;
        }
        if let Some(last) = pts.last().copied() {
            bot.cx = last.0;
            bot.cy = last.1;
            bot.press = 4;
            events.push(BotEvent::Append { owner, points: pts });
        }
        if plan.pi >= sub_len {
            events.push(BotEvent::End { owner });
            plan.open = false;
            plan.si += 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Geometry helpers (port bots.js).
// ---------------------------------------------------------------------------
fn resample(pts: &[P], spacing: f64) -> Vec<P> {
    if pts.is_empty() {
        return Vec::new();
    }
    if pts.len() == 1 {
        return vec![pts[0]];
    }
    let mut out = vec![pts[0]];
    let mut px = pts[0].0;
    let mut py = pts[0].1;
    for i in 1..pts.len() {
        let cx = pts[i].0;
        let cy = pts[i].1;
        let mut dx = cx - px;
        let mut dy = cy - py;
        let mut seg = (dx * dx + dy * dy).sqrt();
        if seg == 0.0 {
            continue;
        }
        let ux = dx / seg;
        let uy = dy / seg;
        while seg >= spacing {
            px += ux * spacing;
            py += uy * spacing;
            out.push((px, py));
            dx = cx - px;
            dy = cy - py;
            seg = (dx * dx + dy * dy).sqrt();
        }
        px = cx;
        py = cy;
    }
    let last = *out.last().unwrap();
    let end = pts[pts.len() - 1];
    if ((end.0 - last.0).powi(2) + (end.1 - last.1).powi(2)).sqrt() > 1.0 {
        out.push(end);
    }
    out
}

fn arc(cx: f64, cy: f64, r: f64, a0: f64, a1: f64, n: usize) -> Vec<P> {
    let mut out = Vec::with_capacity(n + 1);
    for i in 0..=n {
        let a = a0 + (a1 - a0) * (i as f64 / n as f64);
        out.push((cx + a.cos() * r, cy + a.sin() * r));
    }
    out
}
fn circle(cx: f64, cy: f64, r: f64, n: usize) -> Vec<P> {
    arc(cx, cy, r, 0.0, std::f64::consts::PI * 2.0, if n == 0 { 28 } else { n })
}

fn normalize(pts: &[P]) -> Vec<P> {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for p in pts {
        if p.0 < min_x {
            min_x = p.0;
        }
        if p.1 < min_y {
            min_y = p.1;
        }
        if p.0 > max_x {
            max_x = p.0;
        }
        if p.1 > max_y {
            max_y = p.1;
        }
    }
    let w = if max_x - min_x == 0.0 { 1.0 } else { max_x - min_x };
    let h = if max_y - min_y == 0.0 { 1.0 } else { max_y - min_y };
    let s = 0.9 / w.max(h);
    let off_x = 0.5 - ((min_x + max_x) / 2.0) * s;
    let off_y = 0.5 - ((min_y + max_y) / 2.0) * s;
    pts.iter().map(|p| (p.0 * s + off_x, p.1 * s + off_y)).collect()
}

fn build_figure(name: &str) -> Vec<Vec<P>> {
    let pi = std::f64::consts::PI;
    match name {
        "heart" => {
            let mut pts = Vec::new();
            for i in 0..=40 {
                let t = (i as f64 / 40.0) * pi * 2.0;
                let x = 16.0 * t.sin().powi(3);
                let y = 13.0 * t.cos() - 5.0 * (2.0 * t).cos() - 2.0 * (3.0 * t).cos()
                    - (4.0 * t).cos();
                pts.push((x, -y));
            }
            vec![normalize(&pts)]
        }
        "star" => {
            let mut pts = Vec::new();
            let (cx, cy) = (0.5, 0.5);
            for i in 0..=10 {
                let a = -pi / 2.0 + (i as f64 * pi) / 5.0;
                let r = if i % 2 == 0 { 0.5 } else { 0.21 };
                pts.push((cx + a.cos() * r, cy + a.sin() * r));
            }
            vec![pts]
        }
        "sun" => {
            let mut subs = vec![circle(0.5, 0.5, 0.24, 26)];
            for i in 0..8 {
                let a = (i as f64 / 8.0) * pi * 2.0;
                subs.push(vec![
                    (0.5 + a.cos() * 0.32, 0.5 + a.sin() * 0.32),
                    (0.5 + a.cos() * 0.48, 0.5 + a.sin() * 0.48),
                ]);
            }
            subs
        }
        "house" => vec![
            vec![
                (0.14, 1.0),
                (0.14, 0.46),
                (0.86, 0.46),
                (0.86, 1.0),
                (0.14, 1.0),
            ],
            vec![(0.05, 0.47), (0.5, 0.08), (0.95, 0.47)],
            vec![(0.4, 1.0), (0.4, 0.68), (0.6, 0.68), (0.6, 1.0)],
        ],
        "flower" => {
            let mut subs = Vec::new();
            for i in 0..5 {
                let a = -pi / 2.0 + (i as f64 / 5.0) * pi * 2.0;
                let px = 0.5 + a.cos() * 0.22;
                let py = 0.42 + a.sin() * 0.22;
                subs.push(circle(px, py, 0.16, 18));
            }
            subs.push(circle(0.5, 0.42, 0.09, 14));
            subs.push(vec![(0.5, 0.56), (0.5, 1.0)]);
            subs.push(vec![(0.5, 0.8), (0.74, 0.72)]);
            subs
        }
        "smiley" => vec![
            circle(0.5, 0.5, 0.47, 30),
            vec![(0.34, 0.36), (0.34, 0.46)],
            vec![(0.66, 0.36), (0.66, 0.46)],
            arc(0.5, 0.52, 0.26, pi * 0.2, pi * 0.8, 14),
        ],
        "bolt" => vec![vec![
            (0.62, 0.02),
            (0.24, 0.5),
            (0.5, 0.5),
            (0.14, 0.98),
        ]],
        "spiral" => {
            let mut pts = Vec::new();
            for i in 0..=60 {
                let t = (i as f64 / 60.0) * pi * 5.0;
                let r = 0.05 + (i as f64 / 60.0) * 0.45;
                pts.push((0.5 + t.cos() * r, 0.5 + t.sin() * r));
            }
            vec![pts]
        }
        _ => vec![],
    }
}

// Stroke font (capitals) — cell x in [0,0.6], y in [0,1]; advance 0.75 per char.
fn o_loop() -> Vec<P> {
    circle(0.3, 0.5, 0.3, 24)
        .into_iter()
        .map(|p| (p.0, (p.1 - 0.5) * (1.0 / 0.6) * 0.5 + 0.5))
        .collect()
}

fn glyph(ch: char) -> Option<Vec<Vec<P>>> {
    let g: Vec<Vec<P>> = match ch {
        'A' => vec![
            vec![(0.0, 1.0), (0.3, 0.0), (0.6, 1.0)],
            vec![(0.12, 0.6), (0.48, 0.6)],
        ],
        'B' => vec![
            vec![(0.0, 0.0), (0.0, 1.0)],
            vec![(0.0, 0.0), (0.42, 0.12), (0.42, 0.38), (0.0, 0.5)],
            vec![(0.0, 0.5), (0.48, 0.62), (0.48, 0.88), (0.0, 1.0)],
        ],
        'C' => vec![vec![
            (0.56, 0.18),
            (0.3, 0.02),
            (0.08, 0.22),
            (0.03, 0.5),
            (0.08, 0.78),
            (0.3, 0.98),
            (0.56, 0.82),
        ]],
        'E' => vec![
            vec![(0.55, 0.0), (0.0, 0.0), (0.0, 1.0), (0.55, 1.0)],
            vec![(0.0, 0.5), (0.42, 0.5)],
        ],
        'H' => vec![
            vec![(0.0, 0.0), (0.0, 1.0)],
            vec![(0.55, 0.0), (0.55, 1.0)],
            vec![(0.0, 0.5), (0.55, 0.5)],
        ],
        'I' => vec![
            vec![(0.28, 0.0), (0.28, 1.0)],
            vec![(0.08, 0.0), (0.48, 0.0)],
            vec![(0.08, 1.0), (0.48, 1.0)],
        ],
        'K' => vec![
            vec![(0.0, 0.0), (0.0, 1.0)],
            vec![(0.5, 0.0), (0.0, 0.55), (0.52, 1.0)],
        ],
        'L' => vec![vec![(0.0, 0.0), (0.0, 1.0), (0.5, 1.0)]],
        'N' => vec![vec![(0.0, 1.0), (0.0, 0.0), (0.55, 1.0), (0.55, 0.0)]],
        'O' => vec![o_loop()],
        'P' => vec![vec![
            (0.0, 1.0),
            (0.0, 0.0),
            (0.45, 0.1),
            (0.45, 0.4),
            (0.0, 0.5),
        ]],
        'R' => vec![
            vec![(0.0, 1.0), (0.0, 0.0), (0.45, 0.1), (0.45, 0.4), (0.0, 0.5)],
            vec![(0.12, 0.5), (0.54, 1.0)],
        ],
        'S' => vec![vec![
            (0.55, 0.15),
            (0.3, 0.02),
            (0.08, 0.16),
            (0.1, 0.4),
            (0.5, 0.58),
            (0.5, 0.85),
            (0.28, 0.98),
            (0.05, 0.85),
        ]],
        'T' => vec![
            vec![(0.0, 0.0), (0.6, 0.0)],
            vec![(0.3, 0.0), (0.3, 1.0)],
        ],
        'U' => vec![vec![
            (0.0, 0.0),
            (0.0, 0.72),
            (0.16, 0.96),
            (0.44, 0.96),
            (0.6, 0.72),
            (0.6, 0.0),
        ]],
        'V' => vec![vec![(0.0, 0.0), (0.3, 1.0), (0.6, 0.0)]],
        'W' => vec![vec![
            (0.0, 0.0),
            (0.15, 1.0),
            (0.3, 0.4),
            (0.45, 1.0),
            (0.6, 0.0),
        ]],
        'Y' => vec![
            vec![(0.0, 0.0), (0.3, 0.5), (0.6, 0.0)],
            vec![(0.3, 0.5), (0.3, 1.0)],
        ],
        _ => return None,
    };
    Some(g)
}

fn build_word(word: &str) -> (Vec<Vec<P>>, f64) {
    let advance = 0.75;
    let mut subs: Vec<Vec<P>> = Vec::new();
    let mut x = 0.0_f64;
    for ch in word.chars() {
        if let Some(g) = glyph(ch) {
            for sub in g {
                subs.push(sub.into_iter().map(|p| (p.0 + x, p.1)).collect());
            }
        }
        x += advance;
    }
    let w = (x - (advance - 0.6)).max(0.6);
    (subs, w)
}

// ===========================================================================
// Connection state (one per WS client).
// ===========================================================================
struct Conn {
    id: u32, // 0 until named
    name: String,
    named: bool,
    cx: f64,
    cy: f64,
    pressing: bool,
    color: u8,
    tool: u8,
    cursor_at: Option<Instant>,
    meta: Meta, // _meta for the live stroke in progress
    out: mpsc::UnboundedSender<Vec<u8>>,
}

// ===========================================================================
// Messages from connection tasks into the single game task.
// ===========================================================================
enum GameMsg {
    Connect {
        out: mpsc::UnboundedSender<Vec<u8>>,
        reply: oneshot::Sender<u64>,
    },
    Disconnect(u64),
    Frame(u64, Vec<u8>),
}

// ===========================================================================
// Game world — owns ALL state; driven by one task.
// ===========================================================================
struct Game {
    conns: HashMap<u64, Conn>,
    conn_order: Vec<u64>, // stable broadcast order
    mural: Mural,
    bots: BotManager,
    next_entity_id: u32,
    next_conn_key: u64,
    sim_tick: u32,
    gallery_rng: Rng,
}

impl Game {
    fn new() -> Self {
        let mut g = Game {
            conns: HashMap::new(),
            conn_order: Vec::new(),
            mural: Mural::new(),
            bots: BotManager::new(seed_now(0xB075)),
            next_entity_id: 1,
            next_conn_key: 1,
            sim_tick: 0,
            gallery_rng: Rng::new(seed_now(0x6A11)),
        };
        for _ in 0..c::BOT_COUNT {
            let id = g.alloc_entity_id();
            g.bots.spawn(id);
        }
        g
    }

    fn alloc_entity_id(&mut self) -> u32 {
        let id = self.next_entity_id;
        self.next_entity_id += 1;
        id
    }

    fn human_count(&self) -> usize {
        self.conns.values().filter(|c| c.named).count()
    }
    fn painter_count(&self) -> u16 {
        (self.human_count() + self.bots.count()) as u16
    }

    fn send(&self, key: u64, frame: Vec<u8>) {
        if let Some(c) = self.conns.get(&key) {
            let _ = c.out.send(frame);
        }
    }

    fn broadcast(&self, frame: &[u8]) {
        for &key in &self.conn_order {
            if let Some(c) = self.conns.get(&key) {
                if c.named {
                    let _ = c.out.send(frame.to_vec());
                }
            }
        }
    }

    // ---- streaming orchestration (shared by humans + bots) ----------------
    fn stream_begin(&mut self, owner: u32, meta: Meta, x: f64, y: f64) {
        let s = self.mural.begin(owner, meta, x, y);
        let frame = enc_stroke_begin(&s);
        self.broadcast(&frame);
    }

    fn stream_append(&mut self, owner: u32, meta: Option<Meta>, pts: Vec<P>) {
        if !self.mural.is_open(owner) {
            return;
        }
        let mut remaining = pts;
        for _ in 0..64 {
            if remaining.is_empty() {
                break;
            }
            let res = self.mural.append(owner, &remaining);
            if !res.appended.is_empty() {
                if let Some(open_id) = self.mural.open_id(owner) {
                    let frame = enc_stroke_append(open_id, &res.appended);
                    self.broadcast(&frame);
                }
            }
            let used = res.appended.len();
            remaining = remaining[used..].to_vec();
            if res.full && !remaining.is_empty() {
                // capture last point + fallback meta from the open stroke
                let (last, open_meta) = {
                    let open = self.mural.open.get(&owner).unwrap();
                    let lp = *open.points.last().unwrap();
                    (
                        (lp.0 as f64, lp.1 as f64),
                        Meta {
                            tool: open.tool,
                            color: open.color,
                            size: open.size,
                            flags: open.flags,
                        },
                    )
                };
                if let Some(committed) = self.mural.end(owner) {
                    let frame = enc_stroke(&committed);
                    self.broadcast(&frame);
                }
                let reopen_meta = meta.unwrap_or(open_meta);
                self.stream_begin(owner, reopen_meta, last.0, last.1);
            } else if used == 0 {
                break;
            }
        }
    }

    fn stream_end(&mut self, owner: u32) {
        if let Some(committed) = self.mural.end(owner) {
            let frame = enc_stroke(&committed);
            self.broadcast(&frame);
        }
    }

    // ---- client message handling ------------------------------------------
    fn handle_frame(&mut self, key: u64, buf: &[u8]) {
        let msg = match decode_client(buf) {
            Some(m) => m,
            None => return,
        };
        // Need conn existence.
        if !self.conns.contains_key(&key) {
            return;
        }
        match msg {
            ClientMsg::Handshake { version } => {
                if version != c::PROTOCOL_VERSION {
                    self.send(key, enc_version_outdated());
                    // finalize + drop the connection (writer closes when out drops)
                    self.remove_conn(key);
                }
            }
            ClientMsg::Nick { name } => {
                let id = {
                    let c = self.conns.get(&key).unwrap();
                    c.id
                };
                let id = if id == 0 { self.alloc_entity_id() } else { id };
                let sliced: String = name.chars().take(c::NICK_MAX).collect();
                {
                    let c = self.conns.get_mut(&key).unwrap();
                    c.name = sliced;
                    c.id = id;
                    c.named = true;
                }
                self.send(key, enc_welcome(id, self.sim_tick));
                self.send(key, enc_history(&self.mural.strokes));
                // replay in-progress live strokes so a joiner sees them mid-paint
                let opens: Vec<u32> = self.mural.order.clone();
                for owner in opens {
                    if let Some(open) = self.mural.open.get(&owner) {
                        let begin = enc_stroke_begin(open);
                        self.send(key, begin);
                        if open.points.len() > 1 {
                            let rest: Vec<(i32, i32)> = open.points[1..].to_vec();
                            self.send(key, enc_stroke_append(open.id, &rest));
                        }
                    }
                }
                let pc = self.painter_count();
                self.send(key, enc_presence(pc));
                let frame = enc_presence(pc);
                self.broadcast(&frame);
            }
            ClientMsg::Stroke { meta, points } => {
                let (named, id) = self.named_id(key);
                if !named || id == 0 {
                    return;
                }
                if let Some(stored) = self.mural.commit_stroke(id, meta, &points) {
                    let frame = enc_stroke(&stored);
                    self.broadcast(&frame);
                }
            }
            ClientMsg::StrokeBegin { meta, x, y } => {
                let (named, id) = self.named_id(key);
                if !named || id == 0 {
                    return;
                }
                if self.mural.is_open(id) {
                    self.stream_end(id);
                }
                {
                    let c = self.conns.get_mut(&key).unwrap();
                    c.meta = meta;
                }
                self.stream_begin(id, meta, x as f64, y as f64);
            }
            ClientMsg::StrokeAppend { points } => {
                let (named, id) = self.named_id(key);
                if !named || id == 0 {
                    return;
                }
                if !points.is_empty() {
                    let meta = self.conns.get(&key).unwrap().meta;
                    let pf: Vec<P> = points.iter().map(|&(x, y)| (x as f64, y as f64)).collect();
                    self.stream_append(id, Some(meta), pf);
                }
            }
            ClientMsg::StrokeEnd => {
                let (named, id) = self.named_id(key);
                if !named || id == 0 {
                    return;
                }
                self.stream_end(id);
            }
            ClientMsg::Cursor { x, y, pressing, color, tool } => {
                let (named, id) = self.named_id(key);
                if !named || id == 0 {
                    return;
                }
                let c = self.conns.get_mut(&key).unwrap();
                c.cx = x as f64;
                c.cy = y as f64;
                c.pressing = pressing;
                c.color = color;
                c.tool = tool;
                c.cursor_at = Some(Instant::now());
            }
            ClientMsg::Undo => {
                let (named, id) = self.named_id(key);
                if !named || id == 0 {
                    return;
                }
                let removed = self.mural.undo_last(id);
                if removed != 0 {
                    let frame = enc_undo(removed);
                    self.broadcast(&frame);
                }
            }
            ClientMsg::Ping { client_ms } => {
                self.send(key, enc_pong(client_ms, self.sim_tick));
            }
        }
    }

    fn named_id(&self, key: u64) -> (bool, u32) {
        match self.conns.get(&key) {
            Some(c) => (c.named, c.id),
            None => (false, 0),
        }
    }

    fn add_conn(&mut self, out: mpsc::UnboundedSender<Vec<u8>>) -> u64 {
        let key = self.next_conn_key;
        self.next_conn_key += 1;
        self.conns.insert(
            key,
            Conn {
                id: 0,
                name: String::new(),
                named: false,
                cx: 0.0,
                cy: 0.0,
                pressing: false,
                color: 4,
                tool: 0,
                cursor_at: None,
                meta: Meta {
                    tool: 0,
                    color: 4,
                    size: 0,
                    flags: 0,
                },
                out,
            },
        );
        self.conn_order.push(key);
        key
    }

    fn remove_conn(&mut self, key: u64) {
        let id = self.conns.get(&key).map(|c| c.id).unwrap_or(0);
        if id != 0 && self.mural.is_open(id) {
            self.stream_end(id); // finalize a dropped live stroke
        }
        self.conns.remove(&key);
        self.conn_order.retain(|&k| k != key);
        let frame = enc_presence(self.painter_count());
        self.broadcast(&frame);
    }

    // ---- gallery fly-through ----------------------------------------------
    fn trigger_gallery(&mut self) {
        let mut cx = c::CANVAS_W as f64 / 2.0;
        let mut cy = c::CANVAS_H as f64 / 2.0;
        let n = self.mural.strokes.len();
        if n > 0 {
            let span = std::cmp::min(60, n);
            let idx = n - 1 - (self.gallery_rng.f() * span as f64).floor() as usize;
            let s = &self.mural.strokes[idx];
            let p = s.points[s.points.len() / 2];
            cx = p.0 as f64;
            cy = p.1 as f64;
        }
        let half = 320.0 + self.gallery_rng.f() * 380.0;
        let frame = enc_gallery(cx, cy, half, c::GALLERY_MS);
        self.broadcast(&frame);
    }

    // ---- live cursor snapshot ---------------------------------------------
    fn broadcast_cursors(&self) {
        let mut list: Vec<CursorOut> = Vec::new();
        let now = Instant::now();
        for &key in &self.conn_order {
            if let Some(c) = self.conns.get(&key) {
                if c.named && c.id != 0 {
                    if let Some(t) = c.cursor_at {
                        if now.duration_since(t).as_millis() < 2000 {
                            list.push(CursorOut {
                                id: c.id,
                                x: c.cx,
                                y: c.cy,
                                pressing: c.pressing,
                                color: c.color,
                                tool: c.tool,
                                name: c.name.clone(),
                            });
                        }
                    }
                }
            }
        }
        for bc in self.bots.cursors() {
            list.push(bc);
        }
        if !list.is_empty() {
            let frame = enc_cursors(&list);
            self.broadcast(&frame);
        }
    }

    // ---- one authoritative tick -------------------------------------------
    fn step(&mut self) {
        self.sim_tick += 1;

        let events = self.bots.update();
        for ev in events {
            match ev {
                BotEvent::Begin { owner, meta, x, y } => self.stream_begin(owner, meta, x, y),
                BotEvent::Append { owner, points } => self.stream_append(owner, None, points),
                BotEvent::End { owner } => self.stream_end(owner),
            }
        }

        if self.sim_tick % c::CURSORS_EVERY == 0 {
            self.broadcast_cursors();
        }
        if self.sim_tick % c::PRESENCE_EVERY == 0 {
            let frame = enc_presence(self.painter_count());
            self.broadcast(&frame);
        }
        if self.sim_tick % c::GALLERY_EVERY == 0 {
            self.trigger_gallery();
        }
    }
}

// ===========================================================================
// The single game task: interval tick + inbound GameMsg handling.
// ===========================================================================
async fn game_loop(mut rx: mpsc::UnboundedReceiver<GameMsg>) {
    let mut game = Game::new();
    let mut ticker = interval(Duration::from_millis(c::STEP_MS));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                game.step();
            }
            Some(msg) = rx.recv() => {
                match msg {
                    GameMsg::Connect { out, reply } => {
                        let key = game.add_conn(out);
                        let _ = reply.send(key);
                    }
                    GameMsg::Disconnect(key) => {
                        if game.conns.contains_key(&key) {
                            game.remove_conn(key);
                        }
                    }
                    GameMsg::Frame(key, buf) => {
                        game.handle_frame(key, &buf);
                    }
                }
            }
        }
    }
}

// ===========================================================================
// Networking: one TCP port serves static HTTP + WebSocket (routed by peeking).
// ===========================================================================
#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4504);
    let client_dir = resolve_client_dir();

    println!("VANDAL server  (protocol v{})", c::PROTOCOL_VERSION);
    println!("  serving client: {}", client_dir.display());
    println!("  http + ws:      http://localhost:{}/", port);

    let (tx, rx) = mpsc::unbounded_channel::<GameMsg>();
    tokio::spawn(game_loop(rx));

    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind port");
    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                let tx = tx.clone();
                let dir = client_dir.clone();
                tokio::spawn(async move {
                    let _ = handle_conn(stream, tx, dir).await;
                });
            }
            Err(_) => continue,
        }
    }
}

// Resolve ../client relative to the crate, with a CWD fallback.
fn resolve_client_dir() -> PathBuf {
    let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/../client");
    let p = PathBuf::from(manifest);
    if p.join("index.html").exists() {
        return p.canonicalize().unwrap_or(p);
    }
    let cwd = PathBuf::from("../client");
    if cwd.join("index.html").exists() {
        return cwd;
    }
    let cwd2 = PathBuf::from("client");
    if cwd2.join("index.html").exists() {
        return cwd2;
    }
    p
}

async fn handle_conn(
    stream: TcpStream,
    tx: mpsc::UnboundedSender<GameMsg>,
    client_dir: PathBuf,
) -> std::io::Result<()> {
    // Peek the request head to route WS-upgrade vs plain HTTP.
    let mut buf = [0u8; 1024];
    let n = stream.peek(&mut buf).await?;
    if n == 0 {
        return Ok(());
    }
    let head = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
    if head.contains("upgrade: websocket") {
        handle_ws(stream, tx).await;
    } else {
        handle_http(stream, &client_dir).await?;
    }
    Ok(())
}

async fn handle_ws(stream: TcpStream, tx: mpsc::UnboundedSender<GameMsg>) {
    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(_) => return,
    };
    let (mut sink, mut source) = ws.split();

    // Outbound: personal channel -> ws sink.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let writer = tokio::spawn(async move {
        while let Some(bytes) = out_rx.recv().await {
            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // Register with the game task, obtain our connection key.
    let (reply_tx, reply_rx) = oneshot::channel();
    if tx
        .send(GameMsg::Connect {
            out: out_tx,
            reply: reply_tx,
        })
        .is_err()
    {
        writer.abort();
        return;
    }
    let key = match reply_rx.await {
        Ok(k) => k,
        Err(_) => {
            writer.abort();
            return;
        }
    };

    // Inbound: forward binary frames to the game task.
    while let Some(msg) = source.next().await {
        match msg {
            Ok(Message::Binary(data)) => {
                if tx.send(GameMsg::Frame(key, data.to_vec())).is_err() {
                    break;
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    let _ = tx.send(GameMsg::Disconnect(key));
    writer.abort();
}

// --- Minimal static file HTTP responder ---
async fn handle_http(mut stream: TcpStream, client_dir: &Path) -> std::io::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut req = Vec::new();
    let mut tmp = [0u8; 1024];
    loop {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            break;
        }
        req.extend_from_slice(&tmp[..n]);
        if req.windows(4).any(|w| w == b"\r\n\r\n") || req.len() > 8192 {
            break;
        }
    }
    let head = String::from_utf8_lossy(&req);
    let path = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("/");

    let raw = path.split('?').next().unwrap_or("/");
    // favicon shortcut (matches Node's 204).
    if raw == "/favicon.ico" {
        let resp = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        stream.write_all(resp.as_bytes()).await?;
        stream.flush().await?;
        return Ok(());
    }
    let mut rel = raw.to_string();
    if rel == "/" {
        rel = "/index.html".to_string();
    }
    let safe = rel.trim_start_matches('/');
    let mut file = client_dir.to_path_buf();
    let mut ok = true;
    for seg in safe.split('/') {
        if seg == ".." || seg.contains('\\') {
            ok = false;
            break;
        }
        if !seg.is_empty() {
            file.push(seg);
        }
    }

    let (status, ctype, body) = if ok {
        match tokio::fs::read(&file).await {
            Ok(bytes) => ("200 OK", content_type(&file), bytes),
            Err(_) => ("404 Not Found", "text/plain", b"Not found".to_vec()),
        }
    } else {
        ("403 Forbidden", "text/plain", b"Forbidden".to_vec())
    };

    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-cache\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(&body).await?;
    stream.flush().await?;
    Ok(())
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("json") => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}
