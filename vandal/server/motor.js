"use strict";

// =============================================================================
// motor.js — Human motor-control timing model for bot painting speed, based
//            on published psychomotor laws (Steering, Fitts, Two-Thirds Power).
// Modelo de temporizado de control motor humano para la velocidad de pintado
// de los bots, basado en leyes psicomotoras publicadas (Steering, Fitts, Dos Tercios).
//
// Key concepts / Conceptos clave:
//   - Steering Law (Accot & Zhai): stroke time from path length & tolerance / Ley de Steering: tiempo de trazo segun longitud y tolerancia
//   - Two-Thirds Power Law: tip speed varies with curvature radius / Ley de Dos Tercios: velocidad de punta varia con el radio de curvatura
//   - Fitts's Law: discrete reach times for pen-up repositioning / Ley de Fitts: tiempos de alcance discretos para reposicionamiento
//   - Per-kind speed ceilings scaled by bot personality (precision) / Techos de velocidad por tipo escalados por personalidad del bot (precision)
// =============================================================================

// ---------------------------------------------------------------------------
// motor.js — human MOTOR-CONTROL timing for the painter bots.
//
// Paint speed is NOT a knob. Each committed stroke's execution TIME is CALCULATED
// from its geometric COMPLEXITY measured against human motor capacity, using
// established, named, published laws:
//
//   1) STEERING LAW  (Accot & Zhai, CHI 1997) — the trajectory generalisation of
//      Fitts's Law and the canonical model of the difficulty of steering through
//      a constrained path. For a path "tunnel" of arc-length A and tolerance W:
//              MT = a + b · (A / W)          (integral form: a + b·∫ ds/W(s))
//      TIGHT tolerance W (outline / keyline / fine detail) => high index of
//      difficulty => SLOW; WIDE W (fills / throw-ups / tags) => fast.
//
//   2) TWO-THIRDS POWER LAW  (Viviani & Lacquaniti, 1983) — during curved hand
//      motion the tangential speed obeys  v(s) = K · R(s)^(1/3)  (R = local
//      radius of curvature). We normalise the gain K so that  ∫ ds/v(s) == MT
//      from the Steering Law: the hand slows in tight curves and speeds on
//      straights, and the TOTAL stroke time is exactly the Steering-Law time.
//
//   3) FITTS'S LAW  (Fitts, 1954) for DISCRETE reaches (scout travel + reposition
//      hops):  MT = a + b · log2(D / W + 1).
//
//   4) REACTION TIME ~200 ms at each motor decision point (phase / stroke / cap /
//      colour change) — simple-reaction-time literature (~180–250 ms).
//
//   5) A hard human hand-drawing SPEED CEILING (~30–50 cm/s) that v(s) may never
//      exceed, converted to world px/s through the wall scale.
//
// px/s is converted to committed points/tick at 20 Hz via a fractional ARC-LENGTH
// carry, so a hard/precise stroke emits < 1 point/tick and its committed mark
// visibly crawls out behind the tip. No wire involvement — pure timing.
// ---------------------------------------------------------------------------

const TICK_HZ = 20;

// --- world scale -----------------------------------------------------------
// The 4000×2500 px wall depicts a large graffiti wall ~8 m wide, so:
const WALL_WIDTH_CM = 800;                          // 8 m real wall
const PX_PER_CM = 4000 / WALL_WIDTH_CM;             // = 5 world px per real cm
const HAND_CEILING_CM_S = 40;                       // fine-line reference (~30–50 cm/s)
const V_ABS_MAX = 180 * PX_PER_CM;                  // biophysical arm max (~180 cm/s) = 900 px/s
const V_CEILING = V_ABS_MAX;                        // absolute safety cap; per-kind cap below
const V_FLOOR = 2;                                  // px/s, never fully frozen

// PER-KIND, PER-BOT speed ceiling (px/s). Real pen-tip speeds (HMD §5): fine
// liner/keyline ~5–40 cm/s, fills/large sweeps ~60–160 cm/s, ballistic gestures
// fastest. A messy/loose bot (low precision → high 2−precision) runs hotter than
// a patient piecer, so a bomber and a piecer no longer move identically.
function kindCeilingCmS(kind) {
  switch (kind) {
    case "keyline": case "inline": return 30;
    case "outline": return 45;
    case "sign": case "sketch": return 70;
    case "drip": return 55;
    case "threeD": return 120;
    case "fade": case "spray": return 110;
    case "gesture": case "arrow": return 130;      // ballistic flicks
    case "fill": case "scan": case "cloud": return 150;
    default: return 60;
  }
}
function kindCeiling(kind, precision) {
  const loose = precision ? (2 - precision) : 1;    // 0.6..1.3 -> hotter when loose
  return Math.min(V_ABS_MAX, kindCeilingCmS(kind) * PX_PER_CM * (0.85 + 0.32 * loose));
}

// --- Steering-Law constants (Accot & Zhai) ---------------------------------
// a = entry/reaction intercept (lit. 0.05–0.20 s); b = s per unit index-of-
// difficulty. With the W table below the mean tip speed (~W/b) lands below the
// V_CEILING for loose work and well below it for precise work.
const STEER_A = 0.10;
const STEER_B = 0.045; // s per index-of-difficulty; precise outline mean ~25 cm/s, fills clamp to ceiling

// Path tolerance W (world px): how tightly the tunnel must be tracked. Small W =
// precise = hard = slow; large W = loose = easy = fast (then ceiling-capped).
function toleranceW(kind) {
  switch (kind) {
    case "keyline": case "inline": return 5;         // finest liner work
    case "outline": return 6;                        // hard silhouette re-cut
    case "highlight": return 7;
    case "sign": return 8;                           // signature handstyle
    case "sketch": return 10;                        // guide sketch
    case "threeD": return 16;                        // block bulk (some care on edges)
    case "arrow": return 12;
    case "drip": return 13;
    case "fade": case "spray": return 20;            // soft misting, forgiving
    case "gesture": return 22;                       // quick tag flick
    case "fill": case "scan": case "cloud": return 30; // bulk coverage, loosest
    default: return 12;
  }
}

// Steering-Law movement time (s) for one committed stroke tunnel of length A.
// wMul scales the tolerance by a bot's PERSONALITY (a loose, confident bomber has
// wider tolerance => faster/rougher; a patient piecer tighter => slower/cleaner)
// and by whether this is a quick re-trace pass (looser => faster second pass).
function steeringMT(arcLen, kind, wMul) {
  const W = toleranceW(kind) * (wMul || 1);
  return STEER_A + STEER_B * (arcLen / W);
}

// Radius of curvature R(s) at each point (px) via the circumradius (Menger
// curvature) of a windowed triple — robust to the ±1 px tremor.
function radiusArr(pts, k) {
  const n = pts.length; const R = new Array(n).fill(1500);
  k = k || 2;
  for (let i = k; i < n - k; i++) {
    const a = pts[i - k], b = pts[i], c = pts[i + k];
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ca = Math.hypot(a.x - c.x, a.y - c.y);
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    if (area < 1e-3) { R[i] = 1500; continue; }      // ~collinear => straight
    let r = (ab * bc * ca) / (4 * area);             // circumradius
    if (r > 1500) r = 1500; if (r < 4) r = 4;
    R[i] = r;
  }
  for (let i = 0; i < k; i++) { R[i] = R[Math.min(n - 1, k)]; R[n - 1 - i] = R[Math.max(0, n - 1 - k)]; }
  return R;
}

// Build the per-stroke motor plan: cumulative arc, radius, Steering-Law MT, and
// the Two-Thirds gain K normalised so ∫ ds/v == MT.
function planStroke(pts, kind, wMul) {
  const n = pts.length;
  const cum = new Array(n); cum[0] = 0;
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const A = cum[n - 1] || 0;
  const R = radiusArr(pts, 2);
  const MT = steeringMT(A, kind, wMul);
  // I = ∫ ds / R^(1/3)  (segment sum using midpoint radius)
  let I = 0;
  for (let i = 1; i < n; i++) {
    const ds = cum[i] - cum[i - 1];
    const rm = Math.cbrt((R[i] + R[i - 1]) / 2) || 1;
    I += ds / rm;
  }
  const K = MT > 0 ? I / MT : 1;                     // ∫ ds/(K·R^{1/3}) == MT
  return { cum, R, A, MT, K };
}

// Tip speed (px/s) at point index `idx`: Two-Thirds law, ceiling-capped.
function speedAt(plan, idx) {
  const R = plan.R[idx < 0 ? 0 : idx >= plan.R.length ? plan.R.length - 1 : idx];
  let v = plan.K * Math.cbrt(R);
  if (v > V_CEILING) v = V_CEILING;                  // hard human ceiling
  if (v < V_FLOOR) v = V_FLOOR;
  return v;
}

// Fitts's Law reach time (ticks) for a discrete pen-up move of distance D to a
// target of tolerance W.
const FITTS_A = 0.20, FITTS_B = 0.10;
function fittsTicks(D, W) {
  const MT = FITTS_A + FITTS_B * Math.log2(D / Math.max(1, W) + 1);
  return Math.max(3, Math.round(MT * TICK_HZ));
}

// Reaction pause (ticks) at a motor decision point — RIGHT-SKEWED and jittered
// every call (HMD §6: simple RT ~150–250 ms, choice/tool ~200–400 ms), not the
// old zero-variance 200 ms. Occasional long tail (a real hand hesitates).
function reactionTicks(rng) {
  rng = rng || Math.random;
  const tail = rng() < 0.15 ? rng() * 0.35 : 0;     // 15% chance of a longer beat
  const s = 0.13 + rng() * 0.14 + tail;             // ~150–620 ms, mode ~200 ms
  return Math.max(3, Math.round(s * TICK_HZ));
}

module.exports = {
  TICK_HZ, PX_PER_CM, WALL_WIDTH_CM, HAND_CEILING_CM_S, V_CEILING, V_ABS_MAX,
  toleranceW, steeringMT, radiusArr, planStroke, speedAt, fittsTicks, reactionTicks, kindCeiling,
};
