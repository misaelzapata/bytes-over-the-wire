// world.rs — authoritative simulation, port of server/world.js (+ physics.js,
// cell.js, aoi.js). Full-precision f64 sim; the wire quantizes only for
// transport. Entities live in id-keyed maps; players hold cell ids.

use std::collections::HashMap;

use crate::constants as C;

// --- tiny deterministic-ish PRNG (xorshift64), stands in for Math.random() ---
pub struct Rng {
    state: u64,
}
impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng {
            state: seed | 1, // never zero
        }
    }
    #[inline]
    pub fn next_f64(&mut self) -> f64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        // top 53 bits -> [0,1)
        ((x >> 11) as f64) / ((1u64 << 53) as f64)
    }
}

const DT: f64 = 1.0 / C::TICK_HZ;
const BOOST_THRESH2: f64 = C::BOOST_SPEED * C::BOOST_SPEED;

// --- physics formulas (SPEC §2,§3,§7,§1.3) ---
#[inline]
pub fn radius(mass: f64) -> f64 {
    (100.0 * mass).sqrt()
}
#[inline]
pub fn speed(mass: f64) -> f64 {
    C::SPEED_BASE * mass.powf(C::SPEED_EXP)
}
#[inline]
pub fn recombine_ticks(mass: f64) -> i64 {
    let s = C::MERGE_BASE_S + C::MERGE_PER_MASS_S * mass;
    let t = (s * C::TICK_HZ).round() as i64;
    if C::NO_MERGE_TICKS > t {
        C::NO_MERGE_TICKS
    } else {
        t
    }
}
#[inline]
pub fn view_scale(r: f64) -> f64 {
    (64.0 / r).min(1.0).powf(0.4)
}
#[inline]
pub fn view_half(r: f64) -> f64 {
    C::BASE_VIEW_H / 2.0 / view_scale(r) + C::AOI_PAD
}
#[inline]
pub fn clampf(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

// --- entities ---
#[derive(Clone, Copy)]
pub struct PlayerCell {
    pub id: u32,
    pub owner_id: u32,
    pub x: f64,
    pub y: f64,
    pub mass: f64,
    pub hue: u8,
    pub mx: f64,
    pub my: f64,
    pub born_tick: u32,
}
impl PlayerCell {
    #[inline]
    pub fn radius(&self) -> f64 {
        (100.0 * self.mass).sqrt()
    }
    #[inline]
    pub fn boosting(&self) -> bool {
        self.mx * self.mx + self.my * self.my > BOOST_THRESH2
    }
}

#[derive(Clone, Copy)]
pub struct Food {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub hue: u8,
}

#[derive(Clone, Copy)]
pub struct Virus {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub mass: f64,
    pub mx: f64,
    pub my: f64,
    pub feed: u32,
    pub fx: f64,
    pub fy: f64,
}
impl Virus {
    #[inline]
    pub fn radius(&self) -> f64 {
        (100.0 * self.mass).sqrt()
    }
}

#[derive(Clone, Copy)]
pub struct Eject {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub hue: u8,
    pub mass: f64,
    pub mx: f64,
    pub my: f64,
}
impl Eject {
    #[inline]
    pub fn radius(&self) -> f64 {
        (100.0 * self.mass).sqrt()
    }
}

pub struct Player {
    pub id: u32,
    pub name: String,
    pub is_bot: bool,
    pub hue: u8,
    pub cells: Vec<u32>,
    pub target_x: f64,
    pub target_y: f64,
    pub queue_split: bool,
    pub queue_eject: bool,
    pub dead: bool,
    pub final_mass: f64,
}

pub struct EatEvent {
    pub eater_id: u32,
    pub eaten_id: u32,
    pub x: f64,
    pub y: f64,
}
pub struct DeathEvent {
    pub player_id: u32,
    pub final_mass: i64,
}

// --- uniform spatial hash (AOI_CELL) storing entity ids per bucket ---
pub struct Grid {
    cell: f64,
    map: HashMap<i64, Vec<u32>>,
}
impl Grid {
    fn new() -> Self {
        Grid {
            cell: C::AOI_CELL,
            map: HashMap::new(),
        }
    }
    fn clear(&mut self) {
        self.map.clear();
    }
    #[inline]
    fn cell_of(&self, x: f64, y: f64) -> (i64, i64) {
        ((x / self.cell).floor() as i64, (y / self.cell).floor() as i64)
    }
    #[inline]
    fn key(cx: i64, cy: i64) -> i64 {
        cx * 100000 + cy
    }
    fn insert(&mut self, x: f64, y: f64, id: u32) {
        let (cx, cy) = self.cell_of(x, y);
        self.map.entry(Grid::key(cx, cy)).or_default().push(id);
    }
    // ids of every entry whose cell overlaps the square bounding (x,y,radius).
    pub fn query_circle(&self, x: f64, y: f64, radius: f64) -> Vec<u32> {
        let mut out = Vec::new();
        let (min_x, min_y) = self.cell_of(x - radius, y - radius);
        let (max_x, max_y) = self.cell_of(x + radius, y + radius);
        let mut cx = min_x;
        while cx <= max_x {
            let mut cy = min_y;
            while cy <= max_y {
                if let Some(b) = self.map.get(&Grid::key(cx, cy)) {
                    out.extend_from_slice(b);
                }
                cy += 1;
            }
            cx += 1;
        }
        out
    }
}

pub struct World {
    pub sim_tick: u32,
    pub players: HashMap<u32, Player>,
    pub cells: HashMap<u32, PlayerCell>,
    pub food: HashMap<u32, Food>,
    pub viruses: HashMap<u32, Virus>,
    pub ejects: HashMap<u32, Eject>,

    pub eat_events: Vec<EatEvent>,
    pub death_events: Vec<DeathEvent>,

    pub cell_grid: Grid,
    pub food_grid: Grid,
    pub virus_grid: Grid,
    pub eject_grid: Grid,

    next_id: u64,
    rng: Rng,
}

impl World {
    pub fn new(seed: u64) -> Self {
        let mut w = World {
            sim_tick: 0,
            players: HashMap::new(),
            cells: HashMap::new(),
            food: HashMap::new(),
            viruses: HashMap::new(),
            ejects: HashMap::new(),
            eat_events: Vec::new(),
            death_events: Vec::new(),
            cell_grid: Grid::new(),
            food_grid: Grid::new(),
            virus_grid: Grid::new(),
            eject_grid: Grid::new(),
            next_id: 1,
            rng: Rng::new(seed),
        };
        w.seed_food();
        w.seed_viruses();
        w.rebuild_grids();
        w
    }

    fn alloc_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        if self.next_id > 0xffffffff {
            self.next_id = 1;
        }
        id as u32
    }

    #[inline]
    fn rand(&mut self) -> f64 {
        self.rng.next_f64()
    }

    // --- spawning ---
    pub fn random_pos(&mut self, pad: f64) -> (f64, f64) {
        let x = pad + self.rand() * (C::WORLD_SIZE - 2.0 * pad);
        let y = pad + self.rand() * (C::WORLD_SIZE - 2.0 * pad);
        (x, y)
    }

    fn safe_spawn(&mut self) -> (f64, f64) {
        let safe = 700.0_f64;
        let safe2 = safe * safe;
        for _ in 0..24 {
            let pos = self.random_pos(200.0);
            let mut ok = true;
            for c in self.cells.values() {
                if c.mass <= C::SPAWN_MASS * C::EAT_RATIO {
                    continue;
                }
                let dx = c.x - pos.0;
                let dy = c.y - pos.1;
                if dx * dx + dy * dy < safe2 {
                    ok = false;
                    break;
                }
            }
            if ok {
                return pos;
            }
        }
        self.random_pos(200.0)
    }

    pub fn add_player(&mut self, name: &str, is_bot: bool) -> u32 {
        let id = self.alloc_id();
        let hue = (self.rand() * 256.0) as u8;
        let p = Player {
            id,
            name: name.to_string(),
            is_bot,
            hue,
            cells: Vec::new(),
            target_x: 0.0,
            target_y: 0.0,
            queue_split: false,
            queue_eject: false,
            dead: false,
            final_mass: 0.0,
        };
        self.players.insert(id, p);
        self.spawn_player(id);
        id
    }

    fn spawn_player(&mut self, pid: u32) {
        let pos = self.safe_spawn();
        let hue = self.players.get(&pid).map(|p| p.hue).unwrap_or(0);
        if let Some(p) = self.players.get_mut(&pid) {
            p.dead = false;
            p.target_x = pos.0;
            p.target_y = pos.1;
        }
        let cid = self.new_cell(pid, pos.0, pos.1, C::SPAWN_MASS, hue);
        if let Some(p) = self.players.get_mut(&pid) {
            p.cells.push(cid);
        }
    }

    pub fn respawn_player(&mut self, pid: u32) {
        if let Some(p) = self.players.get_mut(&pid) {
            let ids: Vec<u32> = p.cells.drain(..).collect();
            for cid in ids {
                self.cells.remove(&cid);
            }
        }
        self.spawn_player(pid);
    }

    pub fn remove_player(&mut self, pid: u32) {
        if let Some(p) = self.players.remove(&pid) {
            for cid in p.cells {
                self.cells.remove(&cid);
            }
        }
    }

    fn new_cell(&mut self, owner_id: u32, x: f64, y: f64, mass: f64, hue: u8) -> u32 {
        let id = self.alloc_id();
        let c = PlayerCell {
            id,
            owner_id,
            x,
            y,
            mass,
            hue,
            mx: 0.0,
            my: 0.0,
            born_tick: self.sim_tick,
        };
        self.cells.insert(id, c);
        id
    }

    // Remove one player cell; if it was the owner's last, the player dies.
    fn remove_cell(&mut self, cell_id: u32) {
        if self.cells.remove(&cell_id).is_none() {
            return;
        }
        // find owner via any remaining record: we stored owner on the cell, but
        // it's now removed — look through players for the id.
        for p in self.players.values_mut() {
            if let Some(pos) = p.cells.iter().position(|&x| x == cell_id) {
                p.cells.remove(pos);
                if p.cells.is_empty() && !p.dead {
                    p.dead = true;
                    let fm = p.final_mass.round() as i64;
                    self.death_events.push(DeathEvent {
                        player_id: p.id,
                        final_mass: fm,
                    });
                }
                return;
            }
        }
    }

    fn seed_food(&mut self) {
        while self.food.len() < C::FOOD_CAP {
            self.spawn_food();
        }
    }
    fn spawn_food(&mut self) {
        let pos = self.random_pos(20.0);
        let hue = (self.rand() * 256.0) as u8;
        let id = self.alloc_id();
        self.food.insert(
            id,
            Food {
                id,
                x: pos.0,
                y: pos.1,
                hue,
            },
        );
    }
    fn seed_viruses(&mut self) {
        while self.viruses.len() < C::VIRUS_MIN {
            self.spawn_virus();
        }
    }
    fn spawn_virus(&mut self) {
        let pos = self.random_pos(300.0);
        let id = self.alloc_id();
        self.viruses.insert(
            id,
            Virus {
                id,
                x: pos.0,
                y: pos.1,
                mass: C::VIRUS_MASS,
                mx: 0.0,
                my: 0.0,
                feed: 0,
                fx: 0.0,
                fy: 0.0,
            },
        );
    }

    // --- input ---
    pub fn set_target(&mut self, pid: u32, x: f64, y: f64) {
        if let Some(p) = self.players.get_mut(&pid) {
            if p.dead {
                return;
            }
            p.target_x = clampf(x, 0.0, C::WORLD_SIZE);
            p.target_y = clampf(y, 0.0, C::WORLD_SIZE);
        }
    }
    pub fn request_split(&mut self, pid: u32) {
        if let Some(p) = self.players.get_mut(&pid) {
            if !p.dead {
                p.queue_split = true;
            }
        }
    }
    pub fn request_eject(&mut self, pid: u32) {
        if let Some(p) = self.players.get_mut(&pid) {
            if !p.dead {
                p.queue_eject = true;
            }
        }
    }

    // --- main tick sub-steps (bots.update is called between tick++ and apply) ---
    pub fn tick_begin(&mut self) {
        self.sim_tick += 1;
    }

    pub fn apply_input(&mut self) {
        let pids: Vec<u32> = self.players.keys().copied().collect();
        for pid in pids {
            let (dead, qs, qe) = match self.players.get(&pid) {
                Some(p) => (p.dead, p.queue_split, p.queue_eject),
                None => continue,
            };
            if dead {
                continue;
            }
            if qs {
                self.do_split(pid);
            }
            if qe {
                self.do_eject(pid);
            }
            if let Some(p) = self.players.get_mut(&pid) {
                p.queue_split = false;
                p.queue_eject = false;
            }
        }
    }

    pub fn integrate(&mut self) {
        // player cells
        let cell_ids: Vec<u32> = self.cells.keys().copied().collect();
        for cid in cell_ids {
            let (owner, cx, cy, mass) = match self.cells.get(&cid) {
                Some(c) => (c.owner_id, c.x, c.y, c.mass),
                None => continue,
            };
            let (tx, ty) = match self.players.get(&owner) {
                Some(p) => (p.target_x, p.target_y),
                None => (cx, cy),
            };
            let dx = tx - cx;
            let dy = ty - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            let c = self.cells.get_mut(&cid).unwrap();
            if dist > 1e-6 {
                let step = dist.min(speed(mass) * DT);
                c.x += (dx / dist) * step;
                c.y += (dy / dist) * step;
            }
            c.x += c.mx * DT;
            c.y += c.my * DT;
            c.mx *= C::MOVEENGINE_DECAY;
            c.my *= C::MOVEENGINE_DECAY;
            let r = c.radius();
            c.x = clampf(c.x, r, C::WORLD_SIZE - r);
            c.y = clampf(c.y, r, C::WORLD_SIZE - r);
        }

        // ejected pellets
        let ej_ids: Vec<u32> = self.ejects.keys().copied().collect();
        for eid in ej_ids {
            let e = self.ejects.get_mut(&eid).unwrap();
            if e.mx != 0.0 || e.my != 0.0 {
                e.x += e.mx * DT;
                e.y += e.my * DT;
                e.mx *= C::MOVEENGINE_DECAY;
                e.my *= C::MOVEENGINE_DECAY;
                if (e.mx * e.mx + e.my * e.my).sqrt() < 5.0 {
                    e.mx = 0.0;
                    e.my = 0.0;
                }
                let r = e.radius();
                e.x = clampf(e.x, r, C::WORLD_SIZE - r);
                e.y = clampf(e.y, r, C::WORLD_SIZE - r);
            }
        }

        // shot viruses
        let v_ids: Vec<u32> = self.viruses.keys().copied().collect();
        for vid in v_ids {
            let v = self.viruses.get_mut(&vid).unwrap();
            if v.mx != 0.0 || v.my != 0.0 {
                v.x += v.mx * DT;
                v.y += v.my * DT;
                v.mx *= C::MOVEENGINE_DECAY;
                v.my *= C::MOVEENGINE_DECAY;
                if (v.mx * v.mx + v.my * v.my).sqrt() < 5.0 {
                    v.mx = 0.0;
                    v.my = 0.0;
                }
                let r = v.radius();
                v.x = clampf(v.x, r, C::WORLD_SIZE - r);
                v.y = clampf(v.y, r, C::WORLD_SIZE - r);
            }
        }
    }

    pub fn rebuild_grids(&mut self) {
        self.cell_grid.clear();
        for c in self.cells.values() {
            self.cell_grid.insert(c.x, c.y, c.id);
        }
        self.food_grid.clear();
        for f in self.food.values() {
            self.food_grid.insert(f.x, f.y, f.id);
        }
        self.virus_grid.clear();
        for v in self.viruses.values() {
            self.virus_grid.insert(v.x, v.y, v.id);
        }
        self.eject_grid.clear();
        for e in self.ejects.values() {
            self.eject_grid.insert(e.x, e.y, e.id);
        }
    }

    // --- own-cell collision + merge (SPEC §7) ---
    fn mergeable(&self, c: &PlayerCell) -> bool {
        if c.boosting() {
            return false;
        }
        (self.sim_tick as i64 - c.born_tick as i64) >= recombine_ticks(c.mass)
    }

    pub fn resolve_own_cells(&mut self) {
        let mut merges: Vec<(u32, u32)> = Vec::new(); // (big, small)
        let pids: Vec<u32> = self.players.keys().copied().collect();
        for pid in pids {
            let cs: Vec<u32> = match self.players.get(&pid) {
                Some(p) => p.cells.clone(),
                None => continue,
            };
            for i in 0..cs.len() {
                for j in (i + 1)..cs.len() {
                    let ai = cs[i];
                    let bi = cs[j];
                    let a = match self.cells.get(&ai) {
                        Some(c) => *c,
                        None => continue,
                    };
                    let b = match self.cells.get(&bi) {
                        Some(c) => *c,
                        None => continue,
                    };
                    let mut dx = b.x - a.x;
                    let mut dy = b.y - a.y;
                    let mut d = (dx * dx + dy * dy).sqrt();
                    let both_merge = self.mergeable(&a) && self.mergeable(&b);
                    if both_merge {
                        if d < a.radius().max(b.radius()) {
                            let (big, small) = if a.mass >= b.mass {
                                (ai, bi)
                            } else {
                                (bi, ai)
                            };
                            merges.push((big, small));
                        }
                    } else {
                        let rsum = a.radius() + b.radius();
                        if d < rsum {
                            if d < 1e-6 {
                                dx = 1.0;
                                dy = 0.0;
                                d = 1.0;
                            }
                            let push = (rsum - d) / 2.0;
                            let nx = dx / d;
                            let ny = dy / d;
                            {
                                let ca = self.cells.get_mut(&ai).unwrap();
                                ca.x -= nx * push;
                                ca.y -= ny * push;
                                let r = ca.radius();
                                ca.x = clampf(ca.x, r, C::WORLD_SIZE - r);
                                ca.y = clampf(ca.y, r, C::WORLD_SIZE - r);
                            }
                            {
                                let cb = self.cells.get_mut(&bi).unwrap();
                                cb.x += nx * push;
                                cb.y += ny * push;
                                let r = cb.radius();
                                cb.x = clampf(cb.x, r, C::WORLD_SIZE - r);
                                cb.y = clampf(cb.y, r, C::WORLD_SIZE - r);
                            }
                        }
                    }
                }
            }
        }
        for (big, small) in merges {
            if !self.cells.contains_key(&big) || !self.cells.contains_key(&small) {
                continue;
            }
            let sm = self.cells.get(&small).unwrap().mass;
            self.cells.get_mut(&big).unwrap().mass += sm;
            self.remove_cell(small);
        }
    }

    // --- feed viruses (SPEC §9) ---
    pub fn feed_viruses(&mut self) {
        if self.ejects.is_empty() || self.viruses.is_empty() {
            return;
        }
        let ej_ids: Vec<u32> = self.ejects.keys().copied().collect();
        for eid in ej_ids {
            let e = match self.ejects.get(&eid) {
                Some(e) => *e,
                None => continue,
            };
            let near = self
                .virus_grid
                .query_circle(e.x, e.y, e.radius() + radius(C::VIRUS_MASS));
            for vid in near {
                let v = match self.viruses.get(&vid) {
                    Some(v) => *v,
                    None => continue,
                };
                let dx = e.x - v.x;
                let dy = e.y - v.y;
                if dx * dx + dy * dy < v.radius() * v.radius() {
                    let mut fx = e.mx;
                    let mut fy = e.my;
                    if fx == 0.0 && fy == 0.0 {
                        fx = dx;
                        fy = dy;
                    }
                    let fl = {
                        let h = (fx * fx + fy * fy).sqrt();
                        if h == 0.0 {
                            1.0
                        } else {
                            h
                        }
                    };
                    let vm = self.viruses.get_mut(&vid).unwrap();
                    vm.fx += fx / fl;
                    vm.fy += fy / fl;
                    vm.feed += 1;
                    let feed_now = vm.feed;
                    self.ejects.remove(&eid);
                    if feed_now >= C::VIRUS_FEED_COUNT {
                        self.shoot_virus(vid);
                    }
                    break;
                }
            }
        }
    }

    fn shoot_virus(&mut self, vid: u32) {
        let v = match self.viruses.get(&vid) {
            Some(v) => *v,
            None => return,
        };
        let mut dx = v.fx;
        let mut dy = v.fy;
        let dl = (dx * dx + dy * dy).sqrt();
        if dl < 1e-6 {
            let a = self.rand() * std::f64::consts::PI * 2.0;
            dx = a.cos();
            dy = a.sin();
        } else {
            dx /= dl;
            dy /= dl;
        }
        let vr = v.radius();
        let id = self.alloc_id();
        let mut nv = Virus {
            id,
            x: v.x + dx * vr,
            y: v.y + dy * vr,
            mass: C::VIRUS_MASS,
            mx: dx * C::VIRUS_SPLIT_BOOST,
            my: dy * C::VIRUS_SPLIT_BOOST,
            feed: 0,
            fx: 0.0,
            fy: 0.0,
        };
        let r = nv.radius();
        nv.x = clampf(nv.x, r, C::WORLD_SIZE - r);
        nv.y = clampf(nv.y, r, C::WORLD_SIZE - r);
        self.viruses.insert(id, nv);
        let vm = self.viruses.get_mut(&vid).unwrap();
        vm.feed = 0;
        vm.fx = 0.0;
        vm.fy = 0.0;
    }

    // --- eat pass (SPEC §4,§5,§8,§9) ---
    pub fn eat_pass(&mut self) {
        // larger cells act first
        let mut sorted: Vec<u32> = self.cells.keys().copied().collect();
        sorted.sort_by(|&x, &y| {
            let mx = self.cells[&x].mass;
            let my = self.cells[&y].mass;
            my.partial_cmp(&mx).unwrap_or(std::cmp::Ordering::Equal)
        });

        for aid in sorted {
            let a = match self.cells.get(&aid) {
                Some(c) => *c,
                None => continue, // already eaten
            };
            let ar = a.radius();
            let ax = a.x;
            let ay = a.y;
            let a_owner = a.owner_id;

            // food
            let nf = self.food_grid.query_circle(ax, ay, ar);
            for fid in nf {
                let f = match self.food.get(&fid) {
                    Some(f) => *f,
                    None => continue,
                };
                let dx = f.x - ax;
                let dy = f.y - ay;
                if dx * dx + dy * dy < ar * ar {
                    self.cells.get_mut(&aid).unwrap().mass += C::FOOD_MASS;
                    self.food.remove(&fid);
                    self.eat_events.push(EatEvent {
                        eater_id: aid,
                        eaten_id: fid,
                        x: f.x,
                        y: f.y,
                    });
                }
            }

            // ejected pellets
            let ne = self.eject_grid.query_circle(ax, ay, ar);
            for eid in ne {
                let e = match self.ejects.get(&eid) {
                    Some(e) => *e,
                    None => continue,
                };
                let dx = e.x - ax;
                let dy = e.y - ay;
                let reach = ar - C::EAT_OVERLAP * e.radius();
                if dx * dx + dy * dy < reach * reach {
                    self.cells.get_mut(&aid).unwrap().mass += e.mass;
                    self.ejects.remove(&eid);
                    self.eat_events.push(EatEvent {
                        eater_id: aid,
                        eaten_id: eid,
                        x: e.x,
                        y: e.y,
                    });
                }
            }

            // virus pop
            if self.cells.get(&aid).map(|c| c.mass).unwrap_or(0.0) >= C::VIRUS_POP_MIN_MASS {
                let nv = self.virus_grid.query_circle(ax, ay, ar);
                for vid in nv {
                    let v = match self.viruses.get(&vid) {
                        Some(v) => *v,
                        None => continue,
                    };
                    let dx = v.x - ax;
                    let dy = v.y - ay;
                    let reach = ar - C::EAT_OVERLAP * v.radius();
                    if dx * dx + dy * dy < reach * reach {
                        self.cells.get_mut(&aid).unwrap().mass += v.mass;
                        self.viruses.remove(&vid);
                        self.eat_events.push(EatEvent {
                            eater_id: aid,
                            eaten_id: vid,
                            x: v.x,
                            y: v.y,
                        });
                        self.explode(aid);
                        break;
                    }
                }
                if !self.cells.contains_key(&aid) {
                    continue;
                }
            }

            // other players' cells
            let nc = self.cell_grid.query_circle(ax, ay, ar);
            for bid in nc {
                if bid == aid {
                    continue;
                }
                let b = match self.cells.get(&bid) {
                    Some(c) => *c,
                    None => continue,
                };
                if b.owner_id == a_owner {
                    continue;
                }
                let a_mass = self.cells.get(&aid).map(|c| c.mass).unwrap_or(0.0);
                if a_mass < C::EAT_RATIO * b.mass {
                    continue;
                }
                let dx = b.x - ax;
                let dy = b.y - ay;
                let reach = ar - C::EAT_OVERLAP * b.radius();
                if dx * dx + dy * dy < reach * reach {
                    self.cells.get_mut(&aid).unwrap().mass += b.mass;
                    self.eat_events.push(EatEvent {
                        eater_id: aid,
                        eaten_id: bid,
                        x: b.x,
                        y: b.y,
                    });
                    self.remove_cell(bid);
                }
            }
        }
    }

    // --- split / eject / pop ---
    fn do_split(&mut self, pid: u32) {
        let mut eligible: Vec<u32> = match self.players.get(&pid) {
            Some(p) => p
                .cells
                .iter()
                .copied()
                .filter(|cid| self.cells.get(cid).map(|c| c.mass >= C::SPLIT_MIN_MASS).unwrap_or(false))
                .collect(),
            None => return,
        };
        eligible.sort_by(|&x, &y| {
            let mx = self.cells[&x].mass;
            let my = self.cells[&y].mass;
            my.partial_cmp(&mx).unwrap_or(std::cmp::Ordering::Equal)
        });
        let (tx, ty, hue_default) = {
            let p = self.players.get(&pid).unwrap();
            (p.target_x, p.target_y, p.hue)
        };
        let _ = hue_default;
        for cid in eligible {
            if self.players.get(&pid).map(|p| p.cells.len()).unwrap_or(0) >= C::MAX_CELLS {
                break;
            }
            let (cx, cy, hue) = {
                let c = match self.cells.get(&cid) {
                    Some(c) => c,
                    None => continue,
                };
                (c.x, c.y, c.hue)
            };
            let half;
            {
                let c = self.cells.get_mut(&cid).unwrap();
                c.mass /= 2.0;
                half = c.mass;
                c.born_tick = self.sim_tick;
            }
            let mut dx = tx - cx;
            let mut dy = ty - cy;
            let d = {
                let h = (dx * dx + dy * dy).sqrt();
                if h == 0.0 {
                    1.0
                } else {
                    h
                }
            };
            dx /= d;
            dy /= d;
            let r = radius(half);
            let nx = cx + dx * (r + C::SPLIT_OFFSET);
            let ny = cy + dy * (r + C::SPLIT_OFFSET);
            let nid = self.new_cell(pid, nx, ny, half, hue);
            {
                let nc = self.cells.get_mut(&nid).unwrap();
                nc.mx = dx * C::SPLIT_BOOST;
                nc.my = dy * C::SPLIT_BOOST;
                let rr = nc.radius();
                nc.x = clampf(nc.x, rr, C::WORLD_SIZE - rr);
                nc.y = clampf(nc.y, rr, C::WORLD_SIZE - rr);
            }
            self.players.get_mut(&pid).unwrap().cells.push(nid);
        }
    }

    fn do_eject(&mut self, pid: u32) {
        let (cids, tx, ty) = match self.players.get(&pid) {
            Some(p) => (p.cells.clone(), p.target_x, p.target_y),
            None => return,
        };
        for cid in cids {
            let (cx, cy, cr, hue) = {
                let c = match self.cells.get(&cid) {
                    Some(c) => c,
                    None => continue,
                };
                if c.mass < C::EJECT_MIN_MASS {
                    continue;
                }
                (c.x, c.y, c.radius(), c.hue)
            };
            self.cells.get_mut(&cid).unwrap().mass -= C::EJECT_LOSS;
            let mut dx = tx - cx;
            let mut dy = ty - cy;
            let d = {
                let h = (dx * dx + dy * dy).sqrt();
                if h == 0.0 {
                    1.0
                } else {
                    h
                }
            };
            let mut ang = (dy / d).atan2(dx / d);
            ang += (self.rand() * 2.0 - 1.0) * C::EJECT_DISPERSION;
            dx = ang.cos();
            dy = ang.sin();
            let r = cr + radius(C::EJECT_MASS);
            let ex = cx + dx * r;
            let ey = cy + dy * r;
            let id = self.alloc_id();
            let mut e = Eject {
                id,
                x: ex,
                y: ey,
                hue,
                mass: C::EJECT_MASS,
                mx: dx * C::EJECT_BOOST,
                my: dy * C::EJECT_BOOST,
            };
            let rr = e.radius();
            e.x = clampf(e.x, rr, C::WORLD_SIZE - rr);
            e.y = clampf(e.y, rr, C::WORLD_SIZE - rr);
            self.ejects.insert(id, e);
        }
    }

    fn explode(&mut self, cell_id: u32) {
        let (owner, cx, cy, mass, hue) = match self.cells.get(&cell_id) {
            Some(c) => (c.owner_id, c.x, c.y, c.mass, c.hue),
            None => return,
        };
        let plen = match self.players.get(&owner) {
            Some(p) => p.cells.len(),
            None => return,
        };
        let room = C::MAX_CELLS as i64 - plen as i64;
        let by_mass = (mass / C::SPLIT_MIN_MASS).floor() as i64 - 1;
        let pieces = room.min(by_mass);
        if pieces <= 0 {
            return;
        }
        let piece_mass = mass / (pieces as f64 + 1.0);
        {
            let c = self.cells.get_mut(&cell_id).unwrap();
            c.mass = piece_mass;
            c.born_tick = self.sim_tick;
        }
        for i in 0..pieces {
            let ang = (i as f64 / pieces as f64) * std::f64::consts::PI * 2.0 + self.rand() * 0.3;
            let dx = ang.cos();
            let dy = ang.sin();
            let nid = self.new_cell(owner, cx, cy, piece_mass, hue);
            {
                let nc = self.cells.get_mut(&nid).unwrap();
                nc.mx = dx * C::SPLIT_BOOST;
                nc.my = dy * C::SPLIT_BOOST;
            }
            self.players.get_mut(&owner).unwrap().cells.push(nid);
        }
    }

    // --- mass decay (SPEC §10) ---
    pub fn decay(&mut self) {
        for c in self.cells.values_mut() {
            if c.mass <= C::DECAY_MIN_MASS {
                continue;
            }
            c.mass -= c.mass * C::DECAY_RATE * DT;
            if c.mass < C::MIN_CELL_MASS {
                c.mass = C::MIN_CELL_MASS;
            }
        }
    }

    // --- replenishment ---
    pub fn replenish(&mut self) {
        if self.sim_tick % C::FOOD_SPAWN_TICKS == 0 {
            let mut budget = C::FOOD_SPAWN_BATCH;
            while budget > 0 && self.food.len() < C::FOOD_CAP {
                self.spawn_food();
                budget -= 1;
            }
        }
        while self.viruses.len() < C::VIRUS_MIN {
            self.spawn_virus();
        }
    }

    pub fn record_final_mass(&mut self) {
        let pids: Vec<u32> = self.players.keys().copied().collect();
        for pid in pids {
            let dead = self.players.get(&pid).map(|p| p.dead).unwrap_or(true);
            if dead {
                continue;
            }
            let tm = self.player_total_mass(pid);
            if let Some(p) = self.players.get_mut(&pid) {
                p.final_mass = tm;
            }
        }
    }

    // --- player-derived quantities ---
    pub fn player_total_mass(&self, pid: u32) -> f64 {
        match self.players.get(&pid) {
            Some(p) => {
                let mut m = 0.0;
                for cid in &p.cells {
                    if let Some(c) = self.cells.get(cid) {
                        m += c.mass;
                    }
                }
                m
            }
            None => 0.0,
        }
    }

    pub fn player_centroid(&self, pid: u32) -> (f64, f64) {
        match self.players.get(&pid) {
            Some(p) => {
                let mut sx = 0.0;
                let mut sy = 0.0;
                let mut tm = 0.0;
                for cid in &p.cells {
                    if let Some(c) = self.cells.get(cid) {
                        sx += c.x * c.mass;
                        sy += c.y * c.mass;
                        tm += c.mass;
                    }
                }
                if tm == 0.0 {
                    (p.target_x, p.target_y)
                } else {
                    (sx / tm, sy / tm)
                }
            }
            None => (0.0, 0.0),
        }
    }

    pub fn player_sum_radius(&self, pid: u32) -> f64 {
        match self.players.get(&pid) {
            Some(p) => {
                let mut r = 0.0;
                for cid in &p.cells {
                    if let Some(c) = self.cells.get(cid) {
                        r += c.radius();
                    }
                }
                r
            }
            None => 0.0,
        }
    }

    // --- leaderboard (SPEC §13) ---
    pub fn leaderboard_rows(&self) -> Vec<(u32, i64, String)> {
        let mut rows: Vec<(u32, i64, String)> = Vec::new();
        for p in self.players.values() {
            if p.dead || p.cells.is_empty() {
                continue;
            }
            rows.push((p.id, self.player_total_mass(p.id).round() as i64, p.name.clone()));
        }
        rows.sort_by(|a, b| b.1.cmp(&a.1));
        rows
    }
}
