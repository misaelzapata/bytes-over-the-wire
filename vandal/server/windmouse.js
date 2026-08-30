"use strict";

// =============================================================================
// windmouse.js — WindMouse algorithm: a physics-based human mouse-movement
//               model (gravity + wind on a mass) for realistic cursor paths.
// Algoritmo WindMouse: modelo fisico de movimiento de raton humano
// (gravedad + viento sobre una masa) para trayectorias de cursor realistas.
//
// Key concepts / Conceptos clave:
//   - Mass-spring model: gravity pulls toward target, wind adds lateral jitter / Modelo masa-resorte: gravedad hacia el objetivo, viento agrega fluctuacion lateral
//   - Produces natural accel, arc bow, tremor & terminal overshoot / Produce aceleracion natural, arco, temblor y sobreimpulso terminal
//   - Seeded PRNG (mulberry32) for deterministic, reproducible runs / PRNG con semilla (mulberry32) para ejecuciones deterministicas y reproducibles
//   - Along-stroke variable speed (1-D WindMouse) for cursor pacing / Velocidad variable a lo largo del trazo (WindMouse 1-D) para ritmo del cursor
// =============================================================================

// ---------------------------------------------------------------------------
// windmouse.js — WindMouse human mouse-movement model (published algorithm).
//
// WindMouse models the pointer as a MASS pulled toward the target by GRAVITY
// while a smoothly-varying WIND shoves it laterally; the velocity is clipped to
// a randomized cap. That single physics loop produces, for free, everything a
// real hand shows: accel from rest, a gently bowed arc, ≥1px tremor, and a
// ballistic-then-settle overshoot as it damps into the target.
//
// This is NOT invented — it is the widely-ported WindMouse algorithm:
//   - ben.land writeup:  https://ben.land/post/2021/04/25/windmouse-human-mouse-movement/
//   - arevi/wind-mouse (MIT, JS):        https://github.com/arevi/wind-mouse
//   - AsfhtgkDavid/windmouse (py):       https://github.com/AsfhtgkDavid/windmouse
// Re-implemented here (constants √3, √5 as published) with a SEEDED PRNG so a
// run is deterministic/reproducible. The published math feeds BOTH of Vandal's
// motion channels: the live cursor uplink AND (for gesture strokes) the
// committed polyline geometry — the wind term IS the tremor/bow, the near-target
// damping IS the overshoot.
//
// No wire involvement — pure geometry produced in-process for server/bots.js.
// ---------------------------------------------------------------------------

const SQRT3 = Math.sqrt(3);
const SQRT5 = Math.sqrt(5);

// Deterministic PRNG (mulberry32) -> [0,1). Seedable so captures reproduce.
function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The published WindMouse. Walk a mass from (x0,y0) to (x1,y1) and return the
// list of {x,y} waypoints it visits. params: { G, W, M, D }
//   G = gravity (pull toward target)      W = wind (lateral random walk)
//   M = max step (speed cap)              D = wait distance (when to damp)
// The waypoint SPACING is naturally variable — dense at the slow accel/settle
// ends, sparse on the fast middle — which is exactly the human velocity profile.
function windMouse(x0, y0, x1, y1, params, rng) {
  rng = rng || Math.random;
  const G = params.G, W = params.W, D = params.D;
  let M = params.M;
  let cx = x0, cy = y0, vx = 0, vy = 0, wx = 0, wy = 0;
  const pts = [{ x: cx, y: cy }];
  let dist = Math.hypot(x1 - cx, y1 - cy);
  let guard = 0;
  while (dist >= 1 && guard++ < 100000) {
    const wStep = Math.min(W, dist); // wind fades as we close in
    if (dist >= D) {
      // wind = first-order low-pass random walk (Ornstein–Uhlenbeck structure):
      // this IS the human tremor + slow arm bow.
      wx = wx / SQRT3 + (2 * rng() - 1) * wStep / SQRT5;
      wy = wy / SQRT3 + (2 * rng() - 1) * wStep / SQRT5;
    } else {
      // close to target: decouple wind + damp the speed cap -> ballistic settle
      // (this is what produces the terminal overshoot/ease-in).
      wx /= SQRT3;
      wy /= SQRT3;
      if (M > 3) M /= SQRT5; else M = 1 + rng() * 2.5;
    }
    // velocity = wind + gravity toward the target
    vx += wx + G * (x1 - cx) / dist;
    vy += wy + G * (y1 - cy) / dist;
    // clip speed to a randomized cap -> natural accel/decel
    const vmag = Math.hypot(vx, vy);
    if (vmag > M) {
      const vClip = M / 2 + rng() * M / 2;
      vx = (vx / vmag) * vClip;
      vy = (vy / vmag) * vClip;
    }
    cx += vx;
    cy += vy;
    pts.push({ x: cx, y: cy });
    dist = Math.hypot(x1 - cx, y1 - cy);
  }
  // land exactly on the target
  const last = pts[pts.length - 1];
  if (Math.hypot(last.x - x1, last.y - y1) > 0.01) pts.push({ x: x1, y: y1 });
  return pts;
}

// Chain WindMouse through a list of control points -> one continuous human
// polyline. Used to build GESTURE strokes (tags / arrows / signatures / drips):
// the returned waypoints already carry bow + tremor + a soft settle, so no
// separate hand-rolled bow/tremor pass is needed on them.
function windPath(control, params, rng) {
  if (!control || control.length === 0) return [];
  if (control.length === 1) return [{ x: control[0].x, y: control[0].y }];
  const out = [{ x: control[0].x, y: control[0].y }];
  for (let i = 1; i < control.length; i++) {
    const a = control[i - 1], b = control[i];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5) continue;
    const seg = windMouse(a.x, a.y, b.x, b.y, params, rng);
    for (let k = 1; k < seg.length; k++) out.push(seg[k]);
  }
  return out;
}

// --- Along-a-stroke variable speed --------------------------------------
// The cursor never free-flies along a defined letter spine (that would deform
// the letter). Instead it ADVANCES along the committed polyline at a WindMouse-
// style variable velocity: ease-in from rest, cruise on straights, ease into
// curves, ease-out at the end, with low-pass wind jitter and a randomized clip.
// This reuses WindMouse's velocity envelope in 1-D (progress along the path),
// measured in POINTS/tick so job throughput ≈ the old fixed-speed loop.
function alongInit() { return { v: 0, w: 0 }; }

// cruise    : target points/tick on a straight (per-kind pacing)
// curv      : local curvature 0..1 (slow into curves)
// remainFrac: fraction of the stroke still ahead (0..1) -> ease-out near the end
// Returns the (fractional) number of points to advance THIS tick.
function alongAdvance(st, cruise, curv, remainFrac, rng) {
  rng = rng || Math.random;
  const G = 0.34;                         // how hard velocity is pulled to target
  const Wamp = cruise * 0.55;             // wind amplitude scales with pace
  // wind: same low-pass random walk as WindMouse (√3 / √5)
  st.w = st.w / SQRT3 + (2 * rng() - 1) * Wamp / SQRT5;
  let target = cruise * (1 - 0.55 * (curv || 0)); // slower into curves
  if (remainFrac < 0.15) target *= 0.32 + 0.68 * (remainFrac / 0.15); // ease-out
  st.v += st.w + G * (target - st.v);     // gravity toward target speed
  const cap = target * (1.15 + 0.55 * rng()); // randomized v-clip
  if (st.v > cap) st.v = cap;
  if (st.v < 0.08) st.v = 0.08;           // may nearly STOP into a corner (real hesitation);
  return st.v;                            // the caller bounds duration by forcing progress

}

module.exports = { makeRng, windMouse, windPath, alongInit, alongAdvance };
