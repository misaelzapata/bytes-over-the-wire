// bots.rs — simple AI blobs, port of server/bots.js. Each bot is a normal
// Player(is_bot=true) driven through the same set_target / request_split path.

use crate::constants as C;
use crate::world::{Rng, World};

pub const BOT_NAMES: [&str; 20] = [
    "Blobby", "Nomz", "Gulp", "Squish", "Pac", "Chonk", "Orbit", "Gooey", "Wobble", "Munch",
    "Bubble", "Jelly", "Splat", "Zippy", "Void", "Puddle", "Dot", "Marble", "Cell", "Nibble",
];

struct Bot {
    id: u32,
    roam_x: f64,
    roam_y: f64,
}

pub struct BotManager {
    bots: Vec<Bot>,
    rng: Rng,
}

impl BotManager {
    pub fn new(seed: u64) -> Self {
        BotManager {
            bots: Vec::new(),
            rng: Rng::new(seed),
        }
    }

    pub fn spawn_all(&mut self, world: &mut World, count: usize) {
        for i in 0..count {
            let name = BOT_NAMES[i % BOT_NAMES.len()];
            let id = world.add_player(name, true);
            self.bots.push(Bot {
                id,
                roam_x: 0.0,
                roam_y: 0.0,
            });
        }
    }

    pub fn update(&mut self, world: &mut World) {
        for bot in self.bots.iter_mut() {
            let p = match world.players.get(&bot.id) {
                Some(p) => p,
                None => continue,
            };
            if p.dead {
                world.respawn_player(bot.id);
                continue;
            }
            if p.cells.is_empty() {
                continue;
            }

            // reference point = the bot's largest cell
            let mut big_id = p.cells[0];
            let mut big_mass = world.cells.get(&big_id).map(|c| c.mass).unwrap_or(0.0);
            for &cid in &p.cells {
                if let Some(c) = world.cells.get(&cid) {
                    if c.mass > big_mass {
                        big_mass = c.mass;
                        big_id = cid;
                    }
                }
            }
            let big = match world.cells.get(&big_id) {
                Some(c) => *c,
                None => continue,
            };
            let cx = big.x;
            let cy = big.y;

            let rr = 1300.0_f64;
            let mut threat: Option<(f64, f64)> = None; // position
            let mut threat_d2 = rr * rr;
            let mut prey: Option<(f64, f64, f64)> = None; // x,y,mass
            let mut prey_d2 = rr * rr;
            for cand in world.cell_grid.query_circle(cx, cy, rr) {
                let c = match world.cells.get(&cand) {
                    Some(c) => c,
                    None => continue,
                };
                if c.owner_id == big.owner_id {
                    continue;
                }
                let dx = c.x - cx;
                let dy = c.y - cy;
                let d2 = dx * dx + dy * dy;
                if c.mass >= big.mass * C::EAT_RATIO {
                    if d2 < threat_d2 {
                        threat_d2 = d2;
                        threat = Some((c.x, c.y));
                    }
                } else if big.mass >= c.mass * 1.3 && d2 < prey_d2 {
                    prey_d2 = d2;
                    prey = Some((c.x, c.y, c.mass));
                }
            }

            if let Some((tx, ty)) = threat {
                let ax = cx - tx;
                let ay = cy - ty;
                let d = {
                    let h = (ax * ax + ay * ay).sqrt();
                    if h == 0.0 {
                        1.0
                    } else {
                        h
                    }
                };
                world.set_target(bot.id, cx + (ax / d) * 900.0, cy + (ay / d) * 900.0);
            } else if let Some((px, py, pmass)) = prey {
                world.set_target(bot.id, px, py);
                if big.mass >= C::SPLIT_MIN_MASS
                    && big.mass >= pmass * 2.5
                    && prey_d2 < (big.radius() + 200.0) * (big.radius() + 200.0)
                    && self.rng.next_f64() < 0.05
                {
                    world.request_split(bot.id);
                }
            } else {
                let mut food: Option<(f64, f64)> = None;
                let mut fd2 = f64::INFINITY;
                for cand in world.food_grid.query_circle(cx, cy, 1000.0) {
                    if let Some(f) = world.food.get(&cand) {
                        let dx = f.x - cx;
                        let dy = f.y - cy;
                        let d2 = dx * dx + dy * dy;
                        if d2 < fd2 {
                            fd2 = d2;
                            food = Some((f.x, f.y));
                        }
                    }
                }
                if let Some((fx, fy)) = food {
                    world.set_target(bot.id, fx, fy);
                } else {
                    let near = (cx - bot.roam_x).abs() < 80.0 && (cy - bot.roam_y).abs() < 80.0;
                    if near
                        || self.rng.next_f64() < 0.02
                        || (bot.roam_x == 0.0 && bot.roam_y == 0.0)
                    {
                        let pos = world.random_pos(300.0);
                        bot.roam_x = pos.0;
                        bot.roam_y = pos.1;
                    }
                    world.set_target(bot.id, bot.roam_x, bot.roam_y);
                }
            }
        }
    }
}
