// main.rs — CLASSIC agar.io clone authoritative game server, Rust port.
//
//  - Serves the static client from ../client over HTTP on PORT (default 4100).
//  - Accepts binary WebSocket upgrades at "/" (little-endian frames).
//  - Runs a fixed 25Hz authoritative simulation (world.rs) and speaks the exact
//    binary protocol (protocol.rs): per-viewport AoI SNAPSHOT every tick, ~1Hz
//    LEADERBOARD, PONG on demand, DEATH on last-cell loss.
//  - Spawns BOT_COUNT AI blobs so the arena is always alive.
//
// Join sequence: HANDSHAKE(version) -> SET_NICK(name) -> WELCOME -> SNAPSHOTs.

mod bots;
mod constants;
mod protocol;
mod world;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use bots::BotManager;
use constants as C;
use protocol as proto;
use world::{view_half, World};

// ---------------------------------------------------------------------------
// Channel message types
// ---------------------------------------------------------------------------
enum OutMsg {
    Bytes(Vec<u8>),
    Close,
}

enum GameMsg {
    Connect {
        conn_id: u64,
        tx: mpsc::UnboundedSender<OutMsg>,
    },
    Client {
        conn_id: u64,
        data: Vec<u8>,
    },
    Disconnect {
        conn_id: u64,
    },
}

// ---------------------------------------------------------------------------
// Per-connection state held by the game task
// ---------------------------------------------------------------------------
struct Conn {
    id: u32, // player id (0 until named)
    handshaken: bool,
    named: bool,
    seen_names: HashSet<u32>,
    visible: HashSet<u32>,
    tx: mpsc::UnboundedSender<OutMsg>,
}

// ===========================================================================
// main
// ===========================================================================
#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4100);

    let client_root = client_root();

    let (game_tx, game_rx) = mpsc::unbounded_channel::<GameMsg>();

    // Game task owns all simulation + connection routing state.
    tokio::spawn(game_loop(game_rx));

    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind failed");
    println!("agar-clone (rust) server listening on http://localhost:{port}");
    println!("WebSocket endpoint: ws://localhost:{port}/");
    println!("Serving client from: {}", client_root.display());

    let mut next_conn_id: u64 = 1;
    loop {
        let (stream, _addr) = match listener.accept().await {
            Ok(v) => v,
            Err(_) => continue,
        };
        let conn_id = next_conn_id;
        next_conn_id += 1;
        let tx = game_tx.clone();
        let root = client_root.clone();
        tokio::spawn(async move {
            let _ = handle_connection(stream, conn_id, tx, root).await;
        });
    }
}

fn client_root() -> PathBuf {
    if let Ok(p) = std::env::var("CLIENT_ROOT") {
        return PathBuf::from(p);
    }
    // manifest dir = .../agar-clone/server-rust ; client = .../agar-clone/client
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .map(|p| p.join("client"))
        .unwrap_or_else(|| PathBuf::from("../client"))
}

// ===========================================================================
// HTTP / WebSocket connection handling
// ===========================================================================
async fn handle_connection(
    mut stream: TcpStream,
    conn_id: u64,
    game_tx: mpsc::UnboundedSender<GameMsg>,
    client_root: PathBuf,
) -> std::io::Result<()> {
    // Read the HTTP request head (until CRLFCRLF).
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut tmp = [0u8; 2048];
    loop {
        if let Some(_) = find_headers_end(&buf) {
            break;
        }
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.len() > 64 * 1024 {
            break;
        }
    }

    let head_end = match find_headers_end(&buf) {
        Some(e) => e,
        None => return Ok(()),
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let (method, target, headers) = parse_request(&head);

    let is_ws = headers
        .get("upgrade")
        .map(|v| v.to_ascii_lowercase().contains("websocket"))
        .unwrap_or(false)
        && headers.contains_key("sec-websocket-key");

    if is_ws {
        let key = headers.get("sec-websocket-key").cloned().unwrap_or_default();
        let accept = derive_accept_key(key.as_bytes());
        let resp = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        stream.write_all(resp.as_bytes()).await?;
        stream.flush().await?;

        let ws = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
        serve_websocket(ws, conn_id, game_tx).await;
        return Ok(());
    }

    // Static file serving
    let _ = method;
    serve_static(&mut stream, target, &client_root).await?;
    Ok(())
}

fn find_headers_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

fn parse_request(head: &str) -> (String, String, HashMap<String, String>) {
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some(idx) = line.find(':') {
            let k = line[..idx].trim().to_ascii_lowercase();
            let v = line[idx + 1..].trim().to_string();
            headers.insert(k, v);
        }
    }
    (method, target, headers)
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "json" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn serve_static(
    stream: &mut TcpStream,
    target: String,
    client_root: &Path,
) -> std::io::Result<()> {
    let mut url_path = target.split('?').next().unwrap_or("/").to_string();
    // percent-decode (minimal)
    url_path = percent_decode(&url_path);
    if url_path == "/" {
        url_path = "/index.html".to_string();
    }
    if url_path == "/favicon.ico" {
        let resp = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        stream.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    // Build the file path and ensure it stays under client_root.
    let rel = url_path.trim_start_matches('/');
    let joined = client_root.join(rel);
    let root_canon = client_root.canonicalize().unwrap_or_else(|_| client_root.to_path_buf());
    let path_ok = joined
        .canonicalize()
        .map(|c| c.starts_with(&root_canon))
        .unwrap_or(false);

    if !path_ok {
        // could be 403 (outside root) or 404 (missing); mirror server behavior:
        // if the normalized path escapes root -> 403, else 404.
        let normalized = normalize(&joined);
        if !normalized.starts_with(&root_canon) && !normalized.starts_with(client_root) {
            write_simple(stream, 403, "Forbidden").await?;
        } else {
            write_simple(stream, 404, "Not found").await?;
        }
        return Ok(());
    }

    let data = match tokio::fs::read(&joined).await {
        Ok(d) => d,
        Err(_) => {
            write_simple(stream, 404, "Not found").await?;
            return Ok(());
        }
    };
    let ext = joined
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = mime_for(&ext);

    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        data.len()
    );
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(&data).await?;
    stream.flush().await?;
    Ok(())
}

fn normalize(p: &Path) -> PathBuf {
    // lexical normalization (no filesystem access), resolves .. and .
    let mut out = PathBuf::new();
    for comp in p.components() {
        use std::path::Component::*;
        match comp {
            ParentDir => {
                out.pop();
            }
            CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

async fn write_simple(stream: &mut TcpStream, code: u16, body: &str) -> std::io::Result<()> {
    let reason = match code {
        403 => "Forbidden",
        404 => "Not Found",
        _ => "OK",
    };
    let resp = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(resp.as_bytes()).await?;
    stream.flush().await?;
    Ok(())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = hex_val(bytes[i + 1]);
            let l = hex_val(bytes[i + 2]);
            if let (Some(h), Some(l)) = (h, l) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}
fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

async fn serve_websocket(
    ws: WebSocketStream<TcpStream>,
    conn_id: u64,
    game_tx: mpsc::UnboundedSender<GameMsg>,
) {
    let (mut ws_write, mut ws_read) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<OutMsg>();

    // register connection with the game task
    if game_tx
        .send(GameMsg::Connect {
            conn_id,
            tx: out_tx,
        })
        .is_err()
    {
        return;
    }

    // writer task: drain out_rx -> ws
    let writer = tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            match m {
                OutMsg::Bytes(b) => {
                    if ws_write.send(Message::Binary(b.into())).await.is_err() {
                        break;
                    }
                }
                OutMsg::Close => {
                    let _ = ws_write.send(Message::Close(None)).await;
                    break;
                }
            }
        }
        let _ = ws_write.close().await;
    });

    // reader loop: forward binary frames to the game task
    while let Some(msg) = ws_read.next().await {
        match msg {
            Ok(Message::Binary(data)) => {
                if game_tx
                    .send(GameMsg::Client {
                        conn_id,
                        data: data.to_vec(),
                    })
                    .is_err()
                {
                    break;
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }

    let _ = game_tx.send(GameMsg::Disconnect { conn_id });
    writer.abort();
}

// ===========================================================================
// Game loop task
// ===========================================================================
async fn game_loop(mut rx: mpsc::UnboundedReceiver<GameMsg>) {
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9e3779b97f4a7c15);

    let mut world = World::new(seed ^ 0xd1b54a32d192ed03);
    let mut bots = BotManager::new(seed ^ 0xa0761d6478bd642f);
    bots.spawn_all(&mut world, C::BOT_COUNT);

    let mut conns: HashMap<u64, Conn> = HashMap::new();

    let mut interval = tokio::time::interval(Duration::from_millis(C::STEP_MS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last = Instant::now();
    let mut acc: f64 = 0.0;

    loop {
        tokio::select! {
            maybe = rx.recv() => {
                match maybe {
                    Some(msg) => handle_game_msg(&mut world, &mut conns, msg),
                    None => break,
                }
            }
            _ = interval.tick() => {
                let now = Instant::now();
                acc += (now - last).as_secs_f64() * 1000.0;
                last = now;
                if acc > 250.0 { acc = 250.0; }
                while acc >= C::STEP_MS as f64 {
                    step_once(&mut world, &mut bots);
                    broadcast_tick(&mut world, &mut conns);
                    acc -= C::STEP_MS as f64;
                }
            }
        }
    }
}

fn step_once(world: &mut World, bots: &mut BotManager) {
    world.tick_begin();
    bots.update(world);
    world.apply_input();
    world.integrate();
    world.rebuild_grids();
    world.resolve_own_cells();
    world.feed_viruses();
    world.eat_pass();
    world.replenish();
    world.decay();
    world.record_final_mass();
}

fn send(conn: &Conn, frame: Vec<u8>) {
    let _ = conn.tx.send(OutMsg::Bytes(frame));
}

fn handle_game_msg(world: &mut World, conns: &mut HashMap<u64, Conn>, msg: GameMsg) {
    match msg {
        GameMsg::Connect { conn_id, tx } => {
            conns.insert(
                conn_id,
                Conn {
                    id: 0,
                    handshaken: false,
                    named: false,
                    seen_names: HashSet::new(),
                    visible: HashSet::new(),
                    tx,
                },
            );
        }
        GameMsg::Disconnect { conn_id } => {
            if let Some(c) = conns.remove(&conn_id) {
                if c.id != 0 {
                    world.remove_player(c.id);
                }
            }
        }
        GameMsg::Client { conn_id, data } => {
            let decoded = proto::decode_client(&data);
            if let Some(m) = decoded {
                handle_client_message(world, conns, conn_id, m);
            }
        }
    }
}

fn handle_client_message(
    world: &mut World,
    conns: &mut HashMap<u64, Conn>,
    conn_id: u64,
    msg: proto::ClientMsg,
) {
    use proto::ClientMsg::*;
    match msg {
        Handshake { version } => {
            if let Some(c) = conns.get_mut(&conn_id) {
                c.handshaken = true;
                if version != C::PROTOCOL_VERSION {
                    let _ = c.tx.send(OutMsg::Bytes(proto::version_outdated()));
                    let _ = c.tx.send(OutMsg::Close);
                }
            }
        }
        Nick { name } => {
            let clamped = clamp_nick(&name);
            let (cid, exists) = match conns.get(&conn_id) {
                Some(c) => (c.id, c.id != 0 && world.players.contains_key(&c.id)),
                None => return,
            };
            if exists {
                if let Some(p) = world.players.get_mut(&cid) {
                    p.name = clamped;
                }
                return;
            }
            let pid = world.add_player(&clamped, false);
            let tick = world.sim_tick;
            if let Some(c) = conns.get_mut(&conn_id) {
                c.id = pid;
                c.named = true;
                c.seen_names = HashSet::new();
                c.visible = HashSet::new();
                send(c, proto::welcome(pid, tick));
            }
        }
        Target { x, y } => {
            if let Some(c) = conns.get(&conn_id) {
                if c.id != 0 {
                    if let Some(p) = world.players.get(&c.id) {
                        if !p.dead {
                            world.set_target(c.id, x as f64, y as f64);
                        }
                    }
                }
            }
        }
        Split => {
            if let Some(c) = conns.get(&conn_id) {
                if c.id != 0 {
                    if let Some(p) = world.players.get(&c.id) {
                        if !p.dead {
                            world.request_split(c.id);
                        }
                    }
                }
            }
        }
        Eject => {
            if let Some(c) = conns.get(&conn_id) {
                if c.id != 0 {
                    if let Some(p) = world.players.get(&c.id) {
                        if !p.dead {
                            world.request_eject(c.id);
                        }
                    }
                }
            }
        }
        Ping { client_ms } => {
            let tick = world.sim_tick;
            if let Some(c) = conns.get(&conn_id) {
                send(c, proto::pong(client_ms, tick));
            }
        }
        Respawn => {
            let cid = match conns.get(&conn_id) {
                Some(c) => c.id,
                None => return,
            };
            if cid != 0 {
                let is_dead = world.players.get(&cid).map(|p| p.dead).unwrap_or(false);
                if is_dead {
                    world.respawn_player(cid);
                    let tick = world.sim_tick;
                    if let Some(c) = conns.get_mut(&conn_id) {
                        c.seen_names = HashSet::new();
                        c.visible = HashSet::new();
                        send(c, proto::welcome(cid, tick));
                    }
                }
            }
        }
        Unknown => {}
    }
}

fn clamp_nick(name: &str) -> String {
    let units: Vec<u16> = name.encode_utf16().take(C::NICK_MAX).collect();
    String::from_utf16_lossy(&units)
}

// ===========================================================================
// AoI + snapshot building (per viewer)
// ===========================================================================
fn build_snapshot_for(world: &World, conn: &mut Conn, viewer_id: u32) -> Vec<u8> {
    let r = world.player_sum_radius(viewer_id).max(32.0);
    let half = view_half(r);
    let (cx, cy) = world.player_centroid(viewer_id);

    let mut current_ids: HashSet<u32> = HashSet::new();
    let mut visible_owners: HashSet<u32> = HashSet::new();

    // cells in view
    let mut cell_blocks: Vec<proto::CellOut> = Vec::new();
    for c in world.cells.values() {
        let cr = c.radius();
        if (c.x - cx).abs() <= half + cr && (c.y - cy).abs() <= half + cr {
            current_ids.insert(c.id);
            let owner = c.owner_id;
            visible_owners.insert(owner);
            let mut flags: u8 = 0;
            if owner == viewer_id {
                flags |= proto::FLAG_MINE;
            }
            if c.boosting() {
                flags |= proto::FLAG_SPLIT;
            }
            let mut name: Option<String> = None;
            if !conn.seen_names.contains(&owner) {
                flags |= proto::FLAG_NAME;
                conn.seen_names.insert(owner);
                name = Some(
                    world
                        .players
                        .get(&owner)
                        .map(|p| p.name.clone())
                        .unwrap_or_default(),
                );
            }
            cell_blocks.push(proto::CellOut {
                id: c.id,
                owner_id: owner,
                x: c.x,
                y: c.y,
                size: cr,
                hue: c.hue,
                flags,
                name,
            });
        }
    }
    // drop owners no longer visible so a re-appearance re-sends the name
    let stale: Vec<u32> = conn
        .seen_names
        .iter()
        .filter(|o| !visible_owners.contains(o))
        .copied()
        .collect();
    for o in stale {
        conn.seen_names.remove(&o);
    }

    // food via spatial grid
    let mut foods: Vec<proto::FoodOut> = Vec::new();
    for fid in world.food_grid.query_circle(cx, cy, half + 32.0) {
        if let Some(f) = world.food.get(&fid) {
            if (f.x - cx).abs() <= half && (f.y - cy).abs() <= half {
                current_ids.insert(f.id);
                foods.push(proto::FoodOut {
                    id: f.id,
                    x: f.x,
                    y: f.y,
                    hue: f.hue,
                });
            }
        }
    }

    // viruses
    let mut viruses: Vec<proto::VirusOut> = Vec::new();
    for v in world.viruses.values() {
        let vr = v.radius();
        if (v.x - cx).abs() <= half + vr && (v.y - cy).abs() <= half + vr {
            current_ids.insert(v.id);
            viruses.push(proto::VirusOut {
                id: v.id,
                x: v.x,
                y: v.y,
                size: vr,
            });
        }
    }

    // ejects
    let mut ejects: Vec<proto::EjectOut> = Vec::new();
    for e in world.ejects.values() {
        let er = e.radius();
        if (e.x - cx).abs() <= half + er && (e.y - cy).abs() <= half + er {
            current_ids.insert(e.id);
            ejects.push(proto::EjectOut {
                id: e.id,
                x: e.x,
                y: e.y,
                hue: e.hue,
            });
        }
    }

    // removals: previously-visible ids now gone / out of view
    let mut removes: Vec<u32> = Vec::new();
    for id in conn.visible.iter() {
        if !current_ids.contains(id) {
            removes.push(*id);
        }
    }
    conn.visible = current_ids;

    // eat FX near this viewport
    let mut eats: Vec<proto::EatOut> = Vec::new();
    for ev in world.eat_events.iter() {
        if (ev.x - cx).abs() <= half && (ev.y - cy).abs() <= half {
            eats.push(proto::EatOut {
                eater_id: ev.eater_id,
                eaten_id: ev.eaten_id,
            });
        }
    }

    proto::snapshot(
        world.sim_tick,
        &eats,
        &cell_blocks,
        &foods,
        &viruses,
        &ejects,
        &removes,
    )
}

// ===========================================================================
// Broadcast pump (after each sim step)
// ===========================================================================
fn broadcast_tick(world: &mut World, conns: &mut HashMap<u64, Conn>) {
    let tick = world.sim_tick;

    // SNAPSHOT every tick, per viewport
    for conn in conns.values_mut() {
        if conn.id == 0 {
            continue;
        }
        let alive = world
            .players
            .get(&conn.id)
            .map(|p| !p.dead)
            .unwrap_or(false);
        if !alive {
            continue;
        }
        let frame = build_snapshot_for(world, conn, conn.id);
        send(conn, frame);
    }
    world.eat_events.clear();

    // DEATH events
    if !world.death_events.is_empty() {
        let deaths: Vec<(u32, i64)> = world
            .death_events
            .iter()
            .map(|d| (d.player_id, d.final_mass))
            .collect();
        for (pid, fm) in deaths {
            for conn in conns.values() {
                if conn.id == pid {
                    send(conn, proto::death(fm));
                    break;
                }
            }
        }
        world.death_events.clear();
    }

    // LEADERBOARD (~1 Hz)
    if tick % C::LEADERBOARD_EVERY == 0 {
        let all_rows = world.leaderboard_rows();
        let top: Vec<proto::LbRow> = all_rows
            .iter()
            .take(10)
            .map(|(id, mass, name)| proto::LbRow {
                id: *id,
                mass: *mass as u32,
                name: name.clone(),
            })
            .collect();
        let mut rank_by_id: HashMap<u32, i64> = HashMap::new();
        for (i, (id, _, _)) in all_rows.iter().enumerate() {
            rank_by_id.insert(*id, (i as i64) + 1);
        }
        for conn in conns.values() {
            if conn.id == 0 {
                continue;
            }
            let r = rank_by_id.get(&conn.id).copied().unwrap_or(0);
            let your_rank = if r >= 1 && r <= 10 { r } else { 0 };
            send(conn, proto::leaderboard(&top, your_rank));
        }
    }

    // RESYNC safety net (~10s)
    if tick % C::RESYNC_EVERY == 0 {
        for conn in conns.values_mut() {
            if conn.id == 0 {
                continue;
            }
            conn.seen_names = HashSet::new();
            conn.visible = HashSet::new();
        }
    }
}
