// protocol.rs — binary (de)serialization, byte-for-byte with server/protocol.js
// (SPEC §12). LITTLE-ENDIAN everywhere. 1-byte packet id at offset 0. Strings =
// [u8 len][len × u16 code unit] UTF-16. World coords absolute u16; sizes u16;
// leaderboard mass u32.

use crate::constants as C;

// --- packet ids: server -> client ---
pub const S2C_WELCOME: u8 = 0;
pub const S2C_SNAPSHOT: u8 = 1;
pub const S2C_LEADERBOARD: u8 = 2;
pub const S2C_PONG: u8 = 3;
pub const S2C_DEATH: u8 = 4;
pub const S2C_VERSION_OUTDATED: u8 = 255;

// --- packet ids: client -> server ---
pub const C2S_SET_NICK: u8 = 0;
pub const C2S_PING: u8 = 1;
pub const C2S_INPUT_TARGET: u8 = 2;
pub const C2S_SPLIT: u8 = 3;
pub const C2S_EJECT: u8 = 4;
pub const C2S_RESPAWN: u8 = 5;
pub const C2S_HANDSHAKE: u8 = 255;

// cell-block flag bits (SPEC §12.2)
pub const FLAG_MINE: u8 = 1 << 0;
pub const FLAG_NAME: u8 = 1 << 1;
pub const FLAG_SPLIT: u8 = 1 << 2;

#[inline]
fn clamp_i(v: f64, lo: i64, hi: i64) -> i64 {
    let r = v as i64;
    if r < lo {
        lo
    } else if r > hi {
        hi
    } else {
        r
    }
}

// absolute world coord -> u16 (round then clamp 0..65535)
#[inline]
pub fn enc_pos(v: f64) -> u16 {
    clamp_i(v.round(), 0, 65535) as u16
}
// radius -> u16
#[inline]
pub fn enc_size(v: f64) -> u16 {
    clamp_i(v.round(), 0, 65535) as u16
}

// --- growable little-endian writer ---
pub struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    pub fn with_capacity(n: usize) -> Self {
        Writer {
            buf: Vec::with_capacity(n),
        }
    }
    #[inline]
    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.buf.push(v);
        self
    }
    #[inline]
    pub fn u16(&mut self, v: u16) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }
    #[inline]
    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }
    // [u8 length][length × u16 code unit] UTF-16; clamps to NICK_MAX code units.
    pub fn str(&mut self, s: &str) -> &mut Self {
        let units: Vec<u16> = s.encode_utf16().take(C::NICK_MAX).collect();
        self.buf.push((units.len() & 0xff) as u8);
        for u in units {
            self.buf.extend_from_slice(&u.to_le_bytes());
        }
        self
    }
    pub fn done(self) -> Vec<u8> {
        self.buf
    }
}

// --- reader for client->server frames ---
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }
    fn u8(&mut self) -> u8 {
        let v = self.buf[self.pos];
        self.pos += 1;
        v
    }
    fn u16(&mut self) -> u16 {
        let v = u16::from_le_bytes([self.buf[self.pos], self.buf[self.pos + 1]]);
        self.pos += 2;
        v
    }
    fn u32(&mut self) -> u32 {
        let v = u32::from_le_bytes([
            self.buf[self.pos],
            self.buf[self.pos + 1],
            self.buf[self.pos + 2],
            self.buf[self.pos + 3],
        ]);
        self.pos += 4;
        v
    }
    fn str(&mut self) -> String {
        let len = self.u8() as usize;
        let mut units = Vec::with_capacity(len);
        for _ in 0..len {
            units.push(self.u16());
        }
        String::from_utf16_lossy(&units)
    }
}

// ===========================================================================
// Server -> Client encoders
// ===========================================================================

// id 0 WELCOME: [u8 0][u32 yourPlayerId][u16 worldW][u16 worldH][u32 serverTick]
pub fn welcome(your_id: u32, server_tick: u32) -> Vec<u8> {
    let mut w = Writer::with_capacity(16);
    w.u8(S2C_WELCOME)
        .u32(your_id)
        .u16(C::WORLD_SIZE as u16)
        .u16(C::WORLD_SIZE as u16)
        .u32(server_tick);
    w.done()
}

pub struct EatOut {
    pub eater_id: u32,
    pub eaten_id: u32,
}
pub struct CellOut {
    pub id: u32,
    pub owner_id: u32,
    pub x: f64,
    pub y: f64,
    pub size: f64,
    pub hue: u8,
    pub flags: u8,
    pub name: Option<String>,
}
pub struct FoodOut {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub hue: u8,
}
pub struct VirusOut {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub size: f64,
}
pub struct EjectOut {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub hue: u8,
}

// id 1 SNAPSHOT (SPEC §12.2)
#[allow(clippy::too_many_arguments)]
pub fn snapshot(
    server_tick: u32,
    eats: &[EatOut],
    cells: &[CellOut],
    foods: &[FoodOut],
    viruses: &[VirusOut],
    ejects: &[EjectOut],
    removes: &[u32],
) -> Vec<u8> {
    let mut w = Writer::with_capacity(2048);
    w.u8(S2C_SNAPSHOT).u32(server_tick);

    w.u16(eats.len() as u16);
    for e in eats {
        w.u32(e.eater_id).u32(e.eaten_id);
    }

    w.u16(cells.len() as u16);
    for c in cells {
        w.u32(c.id)
            .u32(c.owner_id)
            .u16(enc_pos(c.x))
            .u16(enc_pos(c.y))
            .u16(enc_size(c.size))
            .u8(c.hue)
            .u8(c.flags);
        if c.flags & FLAG_NAME != 0 {
            w.str(c.name.as_deref().unwrap_or(""));
        }
    }

    w.u16(foods.len() as u16);
    for f in foods {
        w.u32(f.id).u16(enc_pos(f.x)).u16(enc_pos(f.y)).u8(f.hue);
    }

    w.u16(viruses.len() as u16);
    for v in viruses {
        w.u32(v.id)
            .u16(enc_pos(v.x))
            .u16(enc_pos(v.y))
            .u16(enc_size(v.size));
    }

    w.u16(ejects.len() as u16);
    for e in ejects {
        w.u32(e.id).u16(enc_pos(e.x)).u16(enc_pos(e.y)).u8(e.hue);
    }

    w.u16(removes.len() as u16);
    for id in removes {
        w.u32(*id);
    }

    w.done()
}

// id 2 LEADERBOARD: [u8 2][u8 n]{ u32 playerId, u32 mass, str name }[u8 yourRank]
pub struct LbRow {
    pub id: u32,
    pub mass: u32,
    pub name: String,
}
pub fn leaderboard(rows: &[LbRow], your_rank: i64) -> Vec<u8> {
    let mut w = Writer::with_capacity(256);
    w.u8(S2C_LEADERBOARD).u8((rows.len() & 0xff) as u8);
    for r in rows {
        w.u32(r.id).u32(r.mass).str(&r.name);
    }
    let yr = if your_rank < 0 {
        0
    } else if your_rank > 255 {
        255
    } else {
        your_rank as u8
    };
    w.u8(yr);
    w.done()
}

// id 3 PONG: [u8 3][u32 clientMs][u32 serverTick]
pub fn pong(client_ms: u32, server_tick: u32) -> Vec<u8> {
    let mut w = Writer::with_capacity(9);
    w.u8(S2C_PONG).u32(client_ms).u32(server_tick);
    w.done()
}

// id 4 DEATH: [u8 4][u32 finalMass]
pub fn death(final_mass: i64) -> Vec<u8> {
    let mut w = Writer::with_capacity(5);
    let fm = if final_mass < 0 { 0 } else { final_mass as u32 };
    w.u8(S2C_DEATH).u32(fm);
    w.done()
}

// id 255 VERSION_OUTDATED: no payload
pub fn version_outdated() -> Vec<u8> {
    vec![S2C_VERSION_OUTDATED]
}

// ===========================================================================
// Client -> Server decoder
// ===========================================================================

#[derive(Debug)]
pub enum ClientMsg {
    Handshake { version: u32 },
    Nick { name: String },
    Ping { client_ms: u32 },
    Target { x: u16, y: u16 },
    Split,
    Eject,
    Respawn,
    Unknown,
}

pub fn decode_client(buf: &[u8]) -> Option<ClientMsg> {
    if buf.is_empty() {
        return None;
    }
    let mut r = Reader::new(buf);
    let id = r.u8();
    match id {
        C2S_HANDSHAKE => {
            let version = if buf.len() >= 5 { r.u32() } else { 0 };
            Some(ClientMsg::Handshake { version })
        }
        C2S_SET_NICK => {
            if buf.len() < 2 {
                Some(ClientMsg::Nick { name: String::new() })
            } else {
                Some(ClientMsg::Nick { name: r.str() })
            }
        }
        C2S_PING => {
            let client_ms = if buf.len() >= 5 { r.u32() } else { 0 };
            Some(ClientMsg::Ping { client_ms })
        }
        C2S_INPUT_TARGET => {
            if buf.len() < 5 {
                return None;
            }
            let x = r.u16();
            let y = r.u16();
            Some(ClientMsg::Target { x, y })
        }
        C2S_SPLIT => Some(ClientMsg::Split),
        C2S_EJECT => Some(ClientMsg::Eject),
        C2S_RESPAWN => Some(ClientMsg::Respawn),
        _ => Some(ClientMsg::Unknown),
    }
}
