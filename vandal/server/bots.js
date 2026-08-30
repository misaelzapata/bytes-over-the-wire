"use strict";

// =============================================================================
// bots.js — AI painter bots that co-create graffiti on the mural: tags,
//           throw-ups, blockbusters, wildstyle pieces, stencils & characters.
// Bots de pintura IA que co-crean graffiti en el mural: tags, throw-ups,
// blockbusters, piezas wildstyle, plantillas y personajes.
//
// Key concepts / Conceptos clave:
//   - Bots have personas (role, colour scheme, hand-style, home turf) / Los bots tienen personalidad (rol, paleta, estilo, zona)
//   - Layered graffiti pipeline: fill -> 3D -> outline -> highlights -> drips / Pipeline de graffiti por capas: relleno -> 3D -> contorno -> brillos -> gotas
//   - WindMouse-driven geometry for human-like cursor & stroke motion / Geometria basada en WindMouse para movimiento humano de cursor y trazo
//   - Motor-control timing via Steering Law & Two-Thirds Power Law / Temporizado motor via Ley de Direccion y Ley de Potencia Dos Tercios
// =============================================================================

// ---------------------------------------------------------------------------
// bots.js — painter bots that keep the mural alive as a real GRAFFITI WALL.
//
// Bots are cooperative street artists with a PERSONA (role, committed colour
// scheme, hand-style, owned signature handle, home turf). They paint REAL,
// LAYERED graffiti — a z-ordered layer stack (paint order):
//
//   cloud/background -> base fill (light) -> fade -> 3D extrusion ->
//   arrows/connectors -> OUTLINE re-cut on top -> keyline/inline (cream) ->
//   highlights/shines (warm white, topmost) -> drips
//
// modelled at four style TIERS reusing the letter primitives:
//   tag (1 gesture) -> throw-up (fill + outline + drip) ->
//   blockbuster (fill + straight-3D + outline) -> wildstyle (all layers).
// Characters use cel-shading; Banksy stencils are flat filled silhouettes.
//
// Every stroke's geometry + the live cursor are driven by WindMouse (a real,
// published human mouse-movement model — gravity + wind on a mass; see
// windmouse.js). GESTURE strokes (tags/arrows/signatures/drips) ARE WindMouse
// point-to-point runs, so their bow + ≥1px tremor + terminal flick are baked in.
// STRUCTURAL strokes (letter fills/outlines) keep their exact shape and take an
// Ornstein–Uhlenbeck tremor + a single half-sine arm-bow on the path normal.
// The cursor TRAVELS between pieces on a full 2-D WindMouse reach and ADVANCES
// along each stroke's spine at a WindMouse variable speed (fast on straights,
// eases into curves + at the ends), so it reads as a hand, not a plotter.
//
// NOTE ON DEPOSIT (updated): the marker renderer now runs perfect-freehand with
// simulatePressure, so committed point SPACING becomes stroke WIDTH — slow/dense
// points draw WIDER + DARKER, fast/sparse draw thinner. So we deliberately SHAPE
// the committed spacing to the speed (§ _advance emit). Darkness also builds from
// palette index + multi-pass overlap. Jobs run as ordered PHASES with dwell
// (scout -> shake/test on cap change -> sketch ->
// fill -> 3D -> outline -> highlights -> drips -> sign -> step-back) so you SEE
// the process, and the live cursor rides the tip holding the right tool.
//
// NONE of this touches the wire: it is all baked into geometry, size/flags/
// colour choice and stroke segmentation, streamed through the existing event
// API the server relays + stores:
//   { type:"begin",  ownerId, name, raw:{tool,color,size,flags}, x, y }
//   { type:"append", ownerId, points:[{x,y}] }
//   { type:"end",    ownerId }
//   { type:"oneshot",ownerId, raw:{tool,color,size,flags, points:[a,b]} }
// ---------------------------------------------------------------------------

const C = require("./constants.js");
const WM = require("./windmouse.js");
const MOTOR = require("./motor.js");
const CONTENT = require("./content.js");

const TOOL_BRUSH = 0;
const TOOL_LINE = 1;
const TOOL_RECT = 2;
const TOOL_CIRCLE = 3;
const TOOL_ERASER = 4;
const TOOL_SPRAY = 5;
const FLAG_SOFT = 1;
const FLAG_FLAT = 2; // constant-width, no-taper brush -> solid stencil fills
const DARK = 13; // warm charcoal outline colour (#5C4A3B family, no pure black)
const CREAM = 0; // warm cream — keylines + highlights
const CW = C.CANVAS_W;
const CH = C.CANVAS_H;

// Warm-pastel guard. The palette (0..13) has NO violet/magenta by construction;
// fills bias to warm 1..8, teal(11)/sky(12) are accent-only, cream(0)/dark(13)
// carry keylines + outlines.
const WARM = [1, 2, 3, 4, 5, 6, 7, 8];
const ACCENT = [11, 12]; // teal / sky — accent only
const REDS = [3, 4, 5];
const VIVID = [3, 4, 5, 7, 8, 9, 10, 11, 12]; // legacy export compat

// words drawn only from letters the stroke font supports (see GLYPHS).
// Merge the curated, glyph-safe WRITER_WORDS from the shared content library so
// bots rotate through a much wider vocabulary (deduped, still font-renderable).
const GLYPHS_OK = /^[ABCDEFGHIKLMNOPRSTUVWY]+$/;
function glyphOk(w) { return typeof w === "string" && GLYPHS_OK.test(w); }
function uniq(list) { const seen = new Set(), out = []; for (const w of list) if (!seen.has(w)) { seen.add(w); out.push(w); } return out; }
const CONTENT_WORDS = (CONTENT.WRITER_WORDS || []).filter(glyphOk);
const WORDS = uniq(["TKO", "OWL", "RSK", "OKR", "CRW", "VNS", "RIOT", "ROYAL", "URBAN", "CREW", "REBEL", "NOVA", "RAVEN", "SNAKE", "KORE", "VIBE", "STYLE", "SORE", "DRAMA", "FLOW", "GRIM", "MAKO"].concat(CONTENT_WORDS));
const SHORTS = uniq(["TKO", "OWL", "RSK", "OKR", "CRW", "VNS", "NOVA", "KORE", "SORE", "FLO", "MOB"].concat(CONTENT_WORDS.filter((w) => w.length <= 4)));
// signature handles — only supported glyphs
const HANDLES = ["RUKO", "NALO", "KIRO", "SOBE", "TYKO", "OWLY", "RENA", "LOKI", "SANE", "VERA", "YOSK", "HABO", "BIKO", "MANO", "DUNE", "FIKO", "PABL", "CRUS", "WYNO", "GALO"];
// production-collab words (supported glyphs only)
const PROD_WORDS = ["UNITY", "RISE", "HOPE", "BLOOM", "DREAM", "VIBE", "CREW"];

function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
function randInt(lo, hi) { return Math.floor(rand(lo, hi + 1)); }
function pick(a) { return a[randInt(0, a.length - 1)]; }
function chance(p) { return Math.random() < p; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
let SALT = 1; // per-stroke PRNG salt so neighbouring strokes decorrelate (no moiré)

// ===========================================================================
// Committed colour SCHEMES (a bot commits to one family for all its pieces).
// fills ordered light -> dark; shade = darker desaturated sibling for 3D;
// accent = a teal/sky/green pop used sparingly.
// ===========================================================================
// Hue-DISTINCT families (red / orange / yellow / green / teal / peach), so two
// bots never read as "the same colour". fills ordered light -> dark; shade is a
// darker sibling used for the 3D block (visibly coloured, not charcoal).
// The FIRST fill is the letter FACE (the dominant colour) — it must be a
// SATURATED, distinct hue per family so painters separate strongly on the wall.
// fills[1..2] are darker siblings for the fade; highlights add cream on top.
// (real graffiti greens/teals/blues — absolutely NO purple/violet.)
const SCHEMES = [
  { name: "vitamin", fam: "orange", fills: [4, 5, 5], accent: 11, shade: 5 },   // vivid orange face
  { name: "crimson", fam: "red", fills: [5, 5, 8], accent: 10, shade: 13 },     // deep red face
  { name: "coral", fam: "coral", fills: [3, 4, 5], accent: 12, shade: 5 },      // coral face
  { name: "honey", fam: "yellow", fills: [7, 8, 8], accent: 4, shade: 8 },      // vivid yellow face
  { name: "amber", fam: "amber", fills: [8, 5, 5], accent: 11, shade: 13 },     // gold face
  { name: "lime", fam: "green", fills: [9, 10, 8], accent: 4, shade: 8 },       // lime-green face
  { name: "mint", fam: "mint", fills: [10, 11, 11], accent: 7, shade: 13 },     // mint face
  { name: "teal", fam: "teal", fills: [11, 12, 12], accent: 7, shade: 13 },     // teal face
  { name: "ocean", fam: "blue", fills: [12, 11, 11], accent: 6, shade: 13 },    // blue face
  { name: "peach", fam: "peach", fills: [2, 3, 4], accent: 10, shade: 5 },      // apricot face
];
function schemeFrom(s) { return { name: s.name, fam: s.fam, fills: s.fills.slice(), accent: s.accent, shade: s.shade, hi: CREAM, outline: DARK }; }
function makeScheme() { return schemeFrom(pick(SCHEMES)); }
// Order schemes so the FIRST bots each get a different hue family (red/orange/
// yellow/green/peach) — the strongest guard against "everything the same colour".
function buildSchemeBag() {
  const byFam = {};
  for (const s of SCHEMES) (byFam[s.fam] = byFam[s.fam] || []).push(s);
  const fams = shuffle(Object.keys(byFam));
  const bag = [];
  for (const f of fams) bag.push(pick(byFam[f]));
  for (const s of shuffle(SCHEMES.slice())) if (bag.indexOf(s) < 0) bag.push(s);
  return bag;
}
function makeHand() {
  return {
    tremor: rand(1.8, 3.6),        // perpendicular jitter amp (>=1px survives u16)
    wobble: rand(1.2, 3.2),        // slower nozzle wobble amp
    bow: rand(2.5, 6),             // arm-sweep arc amplitude (elbow arc)
    weight: pick([0, 1, 1, 2]),    // brush weight bias
    slant: rand(-0.14, 0.14),      // letter slant
    letterSpacing: rand(0.62, 0.92),
    speed: randInt(2, 4),          // BASE pts/tick (per-phase speed derives from this)
    dripiness: rand(0.35, 1.0),
    flourishProb: rand(0.15, 0.95),
    seed: rand(1, 999),
  };
}
const ROLES = ["piecer", "character", "bomber", "doodler", "tagger"];

// ---------------------------------------------------------------------------
// PERSONALITY — each role has a distinct WAY OF WORKING (not just a palette),
// expressed in behaviour: precision (Steering tolerance -> speed/cleanliness),
// tremor/overshoot (messiness), how long it shakes the can, how often it does a
// test-spray, how often it steps back to judge, drip tendency, cap size bias,
// and how many re-trace passes it lays. Every field is jittered per-bot so no
// two painters behave the same — a messy fast bomber vs. a patient clean piecer.
// ---------------------------------------------------------------------------
const BEHAVIOR = {
  bomber:    { precision: 1.24, tremorMul: 1.35, overshootMul: 1.45, testProb: 0.75, shakeMs: [450, 850],  stepBackProb: 0.15, dripMul: 1.5, capBias: 2, passes: 1, ghost: 0.15 },
  tagger:    { precision: 1.12, tremorMul: 1.20, overshootMul: 1.35, testProb: 0.55, shakeMs: [450, 800],  stepBackProb: 0.20, dripMul: 1.2, capBias: 0, passes: 1, ghost: 0.2 },
  doodler:   { precision: 1.02, tremorMul: 1.12, overshootMul: 1.15, testProb: 0.45, shakeMs: [550, 1050], stepBackProb: 0.35, dripMul: 1.1, capBias: 1, passes: 1, ghost: 0.3 },
  character: { precision: 0.90, tremorMul: 0.90, overshootMul: 1.00, testProb: 0.55, shakeMs: [750, 1300], stepBackProb: 0.55, dripMul: 0.8, capBias: 1, passes: 2, ghost: 0.4 },
  piecer:    { precision: 0.82, tremorMul: 0.80, overshootMul: 0.90, testProb: 0.70, shakeMs: [900, 1500], stepBackProb: 0.70, dripMul: 0.9, capBias: 2, passes: 2, ghost: 0.6 },
};
function makeBehavior(role) {
  const b = BEHAVIOR[role] || BEHAVIOR.doodler;
  const j = () => rand(0.9, 1.1);                    // per-bot jitter
  return {
    precision: clamp(b.precision * j(), 0.7, 1.4),
    tremorMul: b.tremorMul * j(),
    overshootMul: b.overshootMul * j(),
    testProb: clamp(b.testProb * j(), 0.05, 0.95),
    shakeMs: [b.shakeMs[0] * j(), b.shakeMs[1] * j()],
    stepBackProb: clamp(b.stepBackProb * j(), 0.05, 0.9),
    dripMul: b.dripMul * j(),
    capBias: b.capBias,
    passes: b.passes,                                 // extra re-trace passes on hard edges
    ghost: clamp(b.ghost * j(), 0, 0.8),              // chance of a ghost/sketch guide pass
  };
}
function makePersona(role, scheme) {
  const hand = makeHand();
  hand.behavior = makeBehavior(role);
  return {
    role,
    scheme: scheme || makeScheme(),
    hand,
    behavior: hand.behavior,
    handle: pick(HANDLES),
    home: { cx: rand(0.2, 0.8) * CW, cy: rand(0.25, 0.75) * CH },
    scaleBias: rand(0.82, 1.22),
  };
}
// avoid painting the same word twice in a row across the wall
let RECENT_WORDS = [];
function pickWord(list) {
  for (let i = 0; i < 8; i++) { const w = pick(list); if (RECENT_WORDS.indexOf(w) < 0) { RECENT_WORDS.push(w); if (RECENT_WORDS.length > 7) RECENT_WORDS.shift(); return w; } }
  return pick(list);
}

// ===========================================================================
// Geometry helpers
// ===========================================================================
function resample(pts, spacing) {
  if (pts.length === 0) return [];
  if (pts.length === 1) return [{ x: pts[0].x, y: pts[0].y }];
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let px = pts[0].x, py = pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    let cx = pts[i].x, cy = pts[i].y;
    let dx = cx - px, dy = cy - py, seg = Math.hypot(dx, dy);
    if (seg === 0) continue;
    const ux = dx / seg, uy = dy / seg;
    while (seg >= spacing) {
      px += ux * spacing; py += uy * spacing;
      out.push({ x: px, y: py });
      dx = cx - px; dy = cy - py; seg = Math.hypot(dx, dy);
    }
    px = cx; py = cy;
  }
  const last = out[out.length - 1];
  if (Math.hypot(pts[pts.length - 1].x - last.x, pts[pts.length - 1].y - last.y) > 1) out.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y });
  return out;
}
function mapPts(pts, ox, oy, em) { return pts.map((p) => ({ x: ox + p.x * em, y: oy + p.y * em })); }
function mapRS(pts, ox, oy, em, step) { return resample(mapPts(pts, ox, oy, em), step || Math.max(10, em * 0.05)); }
function arc(cx, cy, r, a0, a1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); }
  return out;
}
function circle(cx, cy, r, n) { return arc(cx, cy, r, 0, Math.PI * 2, n || 26); }
function ellipsePoly(cx, cy, rx, ry, n) {
  const out = []; n = n || 30;
  for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; out.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry }); }
  return out;
}
function starPoly(cx, cy, ro, ri, points, rot) {
  const out = []; const N = points * 2; rot = rot == null ? -Math.PI / 2 : rot;
  for (let i = 0; i <= N; i++) { const a = rot + (i * Math.PI) / points; const r = i % 2 === 0 ? ro : ri; out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); }
  return out;
}
function crownPoly(x, y, w, h) {
  return [
    { x: x, y: y + h }, { x: x + w * 0.03, y: y + h * 0.2 }, { x: x + w * 0.2, y: y + h * 0.58 },
    { x: x + w * 0.35, y: y + h * 0.05 }, { x: x + w * 0.5, y: y + h * 0.5 }, { x: x + w * 0.65, y: y + h * 0.05 },
    { x: x + w * 0.8, y: y + h * 0.58 }, { x: x + w * 0.97, y: y + h * 0.2 }, { x: x + w, y: y + h }, { x: x, y: y + h },
  ];
}
function heartPath(cx, cy, s) {
  const out = [];
  for (let i = 0; i <= 44; i++) {
    const t = (i / 44) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    out.push({ x: cx + (x / 16) * s, y: cy - (y / 16) * s });
  }
  return out;
}
function centroid(poly) {
  let x = 0, y = 0; for (const p of poly) { x += p.x; y += p.y; } return { x: x / poly.length, y: y / poly.length };
}
function shrinkPoly(poly, f, dx, dy) {
  const c = centroid(poly);
  return poly.map((p) => ({ x: c.x + (p.x - c.x) * f + (dx || 0), y: c.y + (p.y - c.y) * f + (dy || 0) }));
}
// Solid fill of a closed polygon via horizontal scan segments.
function scanFillPoly(poly, rows) {
  let ymin = Infinity, ymax = -Infinity;
  for (const p of poly) { if (p.y < ymin) ymin = p.y; if (p.y > ymax) ymax = p.y; }
  const segs = [];
  for (let r = 0; r < rows; r++) {
    const y = ymin + (ymax - ymin) * (r + 0.5) / rows;
    let xl = Infinity, xr = -Infinity;
    for (let i = 0; i < poly.length - 1; i++) {
      const p1 = poly[i], p2 = poly[i + 1];
      if ((p1.y - y) * (p2.y - y) <= 0 && p1.y !== p2.y) {
        const t = (y - p1.y) / (p2.y - p1.y);
        const x = p1.x + (p2.x - p1.x) * t;
        if (x < xl) xl = x; if (x > xr) xr = x;
      }
    }
    if (xr > xl) segs.push([{ x: xl, y }, { x: xr, y }]);
  }
  // Serpentine: reverse alternate rows so each row STARTS near where the last one
  // ENDED — like a real hand rollering back and forth, not resetting to the left
  // margin every pass (which would make the cursor lift/teleport between rows).
  for (let i = 1; i < segs.length; i += 2) segs[i].reverse();
  return segs;
}
function heartScanFill(cx, cy, s, rows) { return scanFillPoly(heartPath(cx, cy, s), rows); }

// ===========================================================================
// HUMAN motricity post-processor (pure geometry — no wire change)
// ===========================================================================
function cumLengths(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + dist(pts[i - 1], pts[i]);
  return cum;
}
function pointAtArc(pts, cum, a) {
  const L = cum[cum.length - 1];
  if (a <= 0) return { x: pts[0].x, y: pts[0].y };
  if (a >= L) { const p = pts[pts.length - 1]; return { x: p.x, y: p.y }; }
  let i = 1; while (i < cum.length && cum[i] < a) i++;
  const t = (a - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
  return { x: lerp(pts[i - 1].x, pts[i].x, t), y: lerp(pts[i - 1].y, pts[i].y, t) };
}
function curvatureArr(pts) {
  const n = pts.length; const c = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const a1 = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
    const a2 = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
    let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d;
    c[i] = clamp(d / Math.PI, 0, 1);
  }
  return c;
}
// Per-point curvature 0..1 measured over a small WINDOW (ignores tremor jitter)
// then lightly smoothed — used to ease the along-stroke cursor speed into curves.
function smoothCurv(pts) {
  const n = pts.length; const c = new Array(n).fill(0);
  if (n < 6) return c;
  const k = 2;
  for (let i = k; i < n - k; i++) {
    const a1 = Math.atan2(pts[i].y - pts[i - k].y, pts[i].x - pts[i - k].x);
    const a2 = Math.atan2(pts[i + k].y - pts[i].y, pts[i + k].x - pts[i].x);
    let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d;
    c[i] = clamp(d / Math.PI, 0, 1);
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, cnt = 0;
    for (let j = -1; j <= 1; j++) { const idx = i + j; if (idx >= 0 && idx < n) { s += c[idx]; cnt++; } }
    out[i] = s / cnt;
  }
  return out;
}
// Even subsample of a polyline down to at most `n` points (keeps first + last),
// used to make an inter-stroke reposition HOP brief (a few ticks).
function subsample(pts, n) {
  if (pts.length <= n) return pts;
  const out = [pts[0]];
  for (let i = 1; i < n - 1; i++) out.push(pts[Math.round((i / (n - 1)) * (pts.length - 1))]);
  out.push(pts[pts.length - 1]);
  return out;
}
// Approx standard-normal from a seedable uniform (sum of 3 uniforms, std≈1).
function gauss(rng) { return (rng() + rng() + rng() - 1.5) * 2; }
// Ornstein–Uhlenbeck perpendicular tremor (+ optional slow nozzle wobble),
// offset along the path normal. This is the adopted physiological-tremor model:
//   s[i] = s[i-1]·(1−θ) + σ·N(0,1)
// with σ chosen so the stationary RMS == `tremor` px (kept ≥1px so it survives
// the u16 rounding the wire applies). Replaces the old ad-hoc dual-sine.
function applyTremorOU(pts, opt, rng) {
  const n = pts.length; if (n < 2) return pts;
  rng = rng || Math.random;
  const amp = opt.tremor || 2;
  const theta = clamp(opt.theta || 0.22, 0.05, 0.6);
  const wAmp = opt.wobble || 0, period = opt.wobblePeriod || 12;
  // stationary variance of the OU recurrence is σ²/(1−(1−θ)²); solve for σ.
  const sigma = amp * Math.sqrt(1 - (1 - theta) * (1 - theta));
  const wPhase = rng() * Math.PI * 2;
  const out = new Array(n);
  let s = (rng() * 2 - 1) * amp;
  for (let i = 0; i < n; i++) {
    s = s * (1 - theta) + sigma * gauss(rng);
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const nx = -ty, ny = tx;
    let off = s;
    if (wAmp) off += wAmp * Math.sin(i * (2 * Math.PI / period) + wPhase);
    out[i] = { x: pts[i].x + nx * off, y: pts[i].y + ny * off };
  }
  return out;
}
// End overshoot / flick for gesture strokes (tags/arrows/sign) — curl 30-60 deg.
function addOvershoot(pts, len, rng) {
  const n = pts.length; if (n < 2 || len <= 0) return pts;
  rng = rng || Math.random;
  const p = pts[n - 1], q = pts[n - 2];
  let ang = Math.atan2(p.y - q.y, p.x - q.x);
  const curl = (0.5 + rng() * 0.5) * (rng() < 0.5 ? 1 : -1);
  const out = pts.slice(); let cx = p.x, cy = p.y; const steps = 3;
  for (let i = 1; i <= steps; i++) { ang += curl / steps; const stp = len / steps; cx += Math.cos(ang) * stp; cy += Math.sin(ang) * stp; out.push({ x: cx, y: cy }); }
  return out;
}
// Arm-sweep arc: a whole-stroke lateral bow (elbow arc) so long strokes are not
// ruler-straight — a single half-sine along the path, offset on the normal.
function addBow(pts, amp, rng) {
  const n = pts.length; if (n < 4 || !amp) return pts;
  rng = rng || Math.random;
  const sign = rng() < 0.5 ? 1 : -1;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const off = sign * amp * Math.sin(t * Math.PI);
    out[i] = { x: pts[i].x - ty * off, y: pts[i].y + tx * off };
  }
  return out;
}
// Turn an intended polyline into a HUMAN one.
//  Mode A (opt.gesture): the input points are 2-4 CONTROL points of a freehand
//    gesture (tag/arrow/signature). Run WindMouse point-to-point between them
//    and commit the waypoints AS the stroke — bow + ≥1px tremor come baked in;
//    add a short terminal flick for the overshoot.
//  Mode B (default): the input is a structural spine that must hold its exact
//    shape. Resample, add one half-sine arm-bow, then the OU tremor on the normal.
function human(pts, opt) {
  opt = opt || {};
  const rng = opt.rng || Math.random;
  if (opt.gesture) {
    if (pts.length < 2) return pts.map((q) => ({ x: q.x, y: q.y }));
    const P = { G: opt.wmG || 8, W: opt.wmW || 4, M: opt.wmM || 11, D: opt.wmD || 12 };
    let p = WM.windPath(pts, P, rng);
    if (p.length < 2) return pts.map((q) => ({ x: q.x, y: q.y }));
    if (opt.overshoot) p = addOvershoot(p, opt.overshoot, rng);
    return p;
  }
  const spacing = opt.spacing || 10;
  let p = resample(pts, spacing);
  if (p.length < 2) return pts.map((q) => ({ x: q.x, y: q.y }));
  if (opt.bow) p = addBow(p, opt.bow, rng);
  p = applyTremorOU(p, opt, rng);
  if (opt.overshoot) p = addOvershoot(p, opt.overshoot, rng);
  return p;
}
// DOUBLE / MULTIPLE PASSES — real writers re-trace a hard edge (outline, keyline,
// 3D lip) and overlap-cover a fill several times; each pass has a fresh tremor
// seed and a tiny normal offset, so the OVERLAP builds weight/opacity (which the
// renderer DOES show). The first pass is careful; re-traces are quicker (a looser
// tolerance via st.wMul) because the hand already knows the line.
function retracePass(sourcePts, meta, hand, offsetPx, quick) {
  const bh = hand.behavior || { tremorMul: 1 };
  const rng = WM.makeRng(((hand.seed * 100003) ^ (SALT++ * 2654435761)) >>> 0);
  let pts = offsetPx ? offsetSub(sourcePts, offsetPx) : sourcePts.map((p) => ({ x: p.x, y: p.y }));
  pts = applyTremorOU(resample(pts, 8), { tremor: Math.max(1.2, hand.tremor * bh.tremorMul * 0.75), theta: 0.22, wobble: 0 }, rng);
  const s = stream(meta, pts);
  if (quick) s.wMul = 1.7; // a re-trace is faster than the first careful lay-down
  return s;
}
// n total passes of one edge/line, centred offsets so overlap thickens the mark.
function retrace(sourcePts, meta, hand, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(retracePass(sourcePts, meta, hand, (i - (n - 1) / 2) * 1.3, i > 0));
  return out;
}
// Map a stroke KIND + a bot's hand-style to humanizer options. Gesture-family
// kinds (tag/sign) run as Mode-A WindMouse gestures; the rest are structural
// Mode-B strokes carrying OU tremor + a half-sine bow (overshoot 0 on fills).
function handOpt(hand, kind) {
  const bh = hand.behavior || { tremorMul: 1, overshootMul: 1 };
  const t = hand.tremor * bh.tremorMul, w = hand.wobble * bh.tremorMul, bw = (hand.bow || 3) * (0.85 + 0.3 * bh.tremorMul);
  const os = bh.overshootMul;
  const rng = WM.makeRng(((hand.seed * 100003) ^ (SALT++ * 2654435761)) >>> 0);
  switch (kind) {
    // Mode A — freehand gesture reaches (WindMouse point-to-point)
    case "gesture": return { rng, gesture: true, wmG: rand(8, 11), wmW: rand(3.5, 5), wmM: rand(9, 13), wmD: rand(11, 15), overshoot: (12 + hand.flourishProb * 20) * os };
    case "sign": return { rng, gesture: true, wmG: rand(8, 10), wmW: rand(3.5, 4.5), wmM: rand(9, 12), wmD: rand(11, 14), overshoot: (10 + hand.flourishProb * 18) * os };
    // Mode B — structural strokes (keep shape; tremor + bow on the normal)
    case "sketch": return { rng, spacing: 11, tremor: Math.max(1.6, t * 1.3), theta: 0.28, wobble: w, wobblePeriod: 13, bow: bw * 1.1 };
    case "outline": return { rng, spacing: 8, tremor: Math.max(1.5, t * 0.9), theta: 0.20, wobble: w * 0.5, wobblePeriod: 14, bow: bw * 0.7 };
    case "fill": return { rng, spacing: 12, tremor: Math.max(1.5, t * 0.8), theta: 0.22, wobble: w * 0.4, wobblePeriod: 16, bow: bw * 0.5 };
    case "scan": return { rng, spacing: 14, tremor: 1.6, theta: 0.25, wobble: 0.9, wobblePeriod: 18, bow: bw * 0.3 };
    case "spray": return { rng, spacing: 10, tremor: Math.max(1.7, t * 1.2) + 0.6, theta: 0.30, wobble: w * 1.3 + 1.0, wobblePeriod: 10, bow: bw * 0.7 };
    default: return { rng, spacing: 10, tremor: Math.max(1.5, t), theta: 0.24, wobble: w, wobblePeriod: 12, bow: bw };
  }
}
// Cap PREFERENCE per personality: a bomber reaches for a fat cap (bigger), a
// tagger a skinny one — nudge a chosen SIZE by the bot's capBias.
function capSize(base, persona) {
  const cb = persona && persona.behavior ? persona.behavior.capBias : 1;
  const d = cb >= 2 ? 1 : cb <= 0 ? -1 : 0;
  return clamp(base + d, 0, 2);
}
// Per-PHASE cruise speed (points/tick). This is the TARGET pace the WindMouse
// along-stroke velocity envelope eases toward — NOT a darkness lever (the
// renderer resamples committed points, so density is inert). Confident/quick on
// outlines + gesture flicks, calmer on fills, so the hand reads as varying pace.
function phaseSpeed(kind, base) {
  switch (kind) {
    case "fill": case "scan": case "cloud": return clamp(base - 1, 2, 3);
    case "fade": case "spray": return clamp(base, 2, 3);
    case "sketch": return clamp(base, 2, 4);
    case "threeD": return clamp(base, 2, 4);
    case "outline": return clamp(base + 2, 3, 5);
    case "inline": return clamp(base + 1, 2, 4);
    case "arrow": case "sign": return clamp(base + 3, 4, 6);
    case "highlight": case "drip": return clamp(base - 1, 2, 3);
    default: return clamp(base, 2, 4);
  }
}

// ===========================================================================
// Stroke builders
// ===========================================================================
function stream(meta, pts) { return { meta, pts, stream: true }; }
function shape(tool, color, size, a, b) { return { meta: { tool, color, size, flags: 0 }, pts: [a, b], stream: false }; }
function hstroke(meta, worldPts, hand, kind) { return stream(meta, human(worldPts, handOpt(hand, kind))); }
function metaOf(st) { return st.meta; }

// A drip: a "dwell" pool at the top (near-duplicates) then a wavering downward
// run + a bead, sprayed so the client's aerosol accumulates and runs.
function dripStroke(x, y, len, color, rng) {
  rng = rng || Math.random;
  const pts = [];
  // stipple root: a few near-overlapping points where the paint pools before it runs
  const nRoot = 4 + Math.floor(rng() * 4);
  for (let i = 0; i < nRoot; i++) pts.push({ x: x + (rng() * 2 - 1) * 1.4, y: y + (rng() * 2 - 1) * 1.4 });
  // wavering downward run as a gravity-dominant WindMouse fall (the wind = waver)
  const drift = (rng() - 0.5) * 10;
  const run = WM.windMouse(x, y, x + drift, y + len, { G: rand(9, 13), W: rand(1.5, 3), M: rand(6, 10), D: rand(8, 14) }, rng);
  for (let k = 1; k < run.length; k++) pts.push(run[k]);
  // swollen bead at the tip
  pts.push({ x: x + drift, y: y + len + 2 });
  pts.push({ x: x + drift, y: y + len + 3 });
  return stream({ tool: TOOL_SPRAY, color, size: 0, flags: 0 }, pts);
}
// 4-point warm-white shine (tapered crossing strokes -> pointy sparkle), topmost.
function starShine(cx, cy, r) {
  const meta = { tool: TOOL_BRUSH, color: CREAM, size: 0, flags: 0 }; // no FLAG_FLAT -> client tapers to points
  return [
    stream(meta, [{ x: cx, y: cy - r }, { x: cx, y: cy }, { x: cx, y: cy + r }]),
    stream(meta, [{ x: cx - r, y: cy }, { x: cx, y: cy }, { x: cx + r, y: cy }]),
    stream({ tool: TOOL_BRUSH, color: CREAM, size: 1, flags: 0 }, [{ x: cx - 1, y: cy }, { x: cx + 1, y: cy }]),
  ];
}
function wildArrow(ax, ay, em, color, hand) {
  const tipx = ax + em * 0.5, tipy = ay - em * 0.28;
  return [
    hstroke({ tool: TOOL_BRUSH, color, size: 1, flags: 0 }, [{ x: ax - em * 0.1, y: ay }, { x: ax + em * 0.2, y: ay - em * 0.12 }, { x: tipx, y: tipy }], hand, "gesture"),
    shape(TOOL_LINE, color, 0, { x: tipx, y: tipy }, { x: tipx - em * 0.16, y: tipy - em * 0.06 }),
    shape(TOOL_LINE, color, 0, { x: tipx, y: tipy }, { x: tipx - em * 0.10, y: tipy + em * 0.12 }),
  ];
}
function fillSegStrokes(segs, color, size, hand) {
  return segs.map((seg) => hstroke({ tool: TOOL_BRUSH, color, size: size != null ? size : 2, flags: FLAG_FLAT }, seg, hand, "scan"));
}
// Offset a skeleton stroke along its normal by `dist` px — used to trace the two
// EDGES of a fat letter so the outline is a real CONTOUR on top of the fill
// (not a centre-line spine).
function offsetSub(pts, dist) {
  const n = pts.length; if (n < 2) return pts.map((p) => ({ x: p.x, y: p.y }));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    out[i] = { x: pts[i].x - ty * dist, y: pts[i].y + tx * dist };
  }
  return out;
}
// world half-widths matching the client SIZES = [6,15,32]
const HALFW = [3, 7.5, 16];

// ===========================================================================
// Anti-mush: RESERVATION list + coarse ink-density grid biasing pickSpot.
// ===========================================================================
let RESERVATIONS = []; // { x0,y0,x1,y1, ttl }
const GX = 20, GY = 12;
const DENSITY = new Float32Array(GX * GY);
function gcx(x) { return clamp(Math.floor((x / CW) * GX), 0, GX - 1); }
function gcy(y) { return clamp(Math.floor((y / CH) * GY), 0, GY - 1); }
function addDensity(x0, y0, x1, y1, amt) {
  for (let gy = gcy(y0); gy <= gcy(y1); gy++) for (let gx = gcx(x0); gx <= gcx(x1); gx++) DENSITY[gy * GX + gx] += amt;
}
function densityBox(x0, y0, x1, y1) {
  let s = 0, c = 0;
  for (let gy = gcy(y0); gy <= gcy(y1); gy++) for (let gx = gcx(x0); gx <= gcx(x1); gx++) { s += DENSITY[gy * GX + gx]; c++; }
  return c ? s / c : 0;
}
function reservedOverlap(x0, y0, x1, y1, margin) {
  margin = margin || 0;
  for (const r of RESERVATIONS) {
    if (x0 < r.x1 + margin && x1 > r.x0 - margin && y0 < r.y1 + margin && y1 > r.y0 - margin) return true;
  }
  return false;
}
function reserve(box, ttl) { RESERVATIONS.push({ x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1, ttl }); }
function tickWorld() {
  for (const r of RESERVATIONS) r.ttl--;
  RESERVATIONS = RESERVATIONS.filter((r) => r.ttl > 0);
  for (let i = 0; i < DENSITY.length; i++) DENSITY[i] *= 0.9985; // slow decay so old faded areas free up
}
function pickSpot(w, h, opt) {
  opt = opt || {};
  const m = 70;
  const margin = opt.margin != null ? opt.margin : 44;
  let best = null, bestScore = Infinity;
  for (let i = 0; i < 42; i++) {
    let ox, oy;
    if (opt.home && chance(0.6)) {
      ox = clamp(opt.home.cx - w / 2 + rand(-CW * 0.2, CW * 0.2), m, CW - m - w);
      oy = clamp(opt.home.cy - h / 2 + rand(-CH * 0.2, CH * 0.2), m, CH - m - h);
    } else {
      ox = rand(m, Math.max(m, CW - m - w));
      oy = rand(m, Math.max(m, CH - m - h));
    }
    if (!opt.allowOverlap && reservedOverlap(ox, oy, ox + w, oy + h, margin)) continue;
    const score = densityBox(ox, oy, ox + w, oy + h);
    if (score < bestScore) { bestScore = score; best = { ox, oy }; }
    if (bestScore < 0.05) break;
  }
  if (best) return best;
  for (let i = 0; i < 24; i++) {
    const ox = rand(m, Math.max(m, CW - m - w)), oy = rand(m, Math.max(m, CH - m - h));
    if (!reservedOverlap(ox, oy, ox + w, oy + h, 12)) return { ox, oy };
  }
  return { ox: clamp(rand(m, CW - m - w), m, Math.max(m, CW - m - w)), oy: clamp(rand(m, CH - m - h), m, Math.max(m, CH - m - h)) };
}

// ===========================================================================
// Stroke font (capitals) — cell x in [0,0.6], y in [0,1]; advance 0.75/char
// ===========================================================================
const O_LOOP = circle(0.3, 0.5, 0.3, 24).map((p) => ({ x: p.x, y: (p.y - 0.5) * (1 / 0.6) * 0.5 + 0.5 }));
const GLYPHS = {
  A: [[{ x: 0, y: 1 }, { x: 0.3, y: 0 }, { x: 0.6, y: 1 }], [{ x: 0.12, y: 0.6 }, { x: 0.48, y: 0.6 }]],
  B: [[{ x: 0, y: 0 }, { x: 0, y: 1 }], [{ x: 0, y: 0 }, { x: 0.42, y: 0.12 }, { x: 0.42, y: 0.38 }, { x: 0, y: 0.5 }], [{ x: 0, y: 0.5 }, { x: 0.48, y: 0.62 }, { x: 0.48, y: 0.88 }, { x: 0, y: 1 }]],
  C: [[{ x: 0.56, y: 0.18 }, { x: 0.3, y: 0.02 }, { x: 0.08, y: 0.22 }, { x: 0.03, y: 0.5 }, { x: 0.08, y: 0.78 }, { x: 0.3, y: 0.98 }, { x: 0.56, y: 0.82 }]],
  D: [[{ x: 0, y: 0 }, { x: 0, y: 1 }], [{ x: 0, y: 0 }, { x: 0.42, y: 0.14 }, { x: 0.52, y: 0.5 }, { x: 0.42, y: 0.86 }, { x: 0, y: 1 }]],
  E: [[{ x: 0.55, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0.55, y: 1 }], [{ x: 0, y: 0.5 }, { x: 0.42, y: 0.5 }]],
  F: [[{ x: 0.55, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }], [{ x: 0, y: 0.5 }, { x: 0.4, y: 0.5 }]],
  G: [[{ x: 0.56, y: 0.18 }, { x: 0.3, y: 0.02 }, { x: 0.08, y: 0.22 }, { x: 0.03, y: 0.5 }, { x: 0.08, y: 0.78 }, { x: 0.3, y: 0.98 }, { x: 0.54, y: 0.86 }, { x: 0.54, y: 0.56 }, { x: 0.34, y: 0.56 }]],
  H: [[{ x: 0, y: 0 }, { x: 0, y: 1 }], [{ x: 0.55, y: 0 }, { x: 0.55, y: 1 }], [{ x: 0, y: 0.5 }, { x: 0.55, y: 0.5 }]],
  I: [[{ x: 0.28, y: 0 }, { x: 0.28, y: 1 }], [{ x: 0.08, y: 0 }, { x: 0.48, y: 0 }], [{ x: 0.08, y: 1 }, { x: 0.48, y: 1 }]],
  K: [[{ x: 0, y: 0 }, { x: 0, y: 1 }], [{ x: 0.5, y: 0 }, { x: 0, y: 0.55 }, { x: 0.52, y: 1 }]],
  L: [[{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0.5, y: 1 }]],
  M: [[{ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 0.3, y: 0.55 }, { x: 0.6, y: 0 }, { x: 0.6, y: 1 }]],
  N: [[{ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 0.55, y: 1 }, { x: 0.55, y: 0 }]],
  O: [O_LOOP],
  P: [[{ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 0.45, y: 0.1 }, { x: 0.45, y: 0.4 }, { x: 0, y: 0.5 }]],
  R: [[{ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 0.45, y: 0.1 }, { x: 0.45, y: 0.4 }, { x: 0, y: 0.5 }], [{ x: 0.12, y: 0.5 }, { x: 0.54, y: 1 }]],
  S: [[{ x: 0.55, y: 0.15 }, { x: 0.3, y: 0.02 }, { x: 0.08, y: 0.16 }, { x: 0.1, y: 0.4 }, { x: 0.5, y: 0.58 }, { x: 0.5, y: 0.85 }, { x: 0.28, y: 0.98 }, { x: 0.05, y: 0.85 }]],
  T: [[{ x: 0, y: 0 }, { x: 0.6, y: 0 }], [{ x: 0.3, y: 0 }, { x: 0.3, y: 1 }]],
  U: [[{ x: 0, y: 0 }, { x: 0, y: 0.72 }, { x: 0.16, y: 0.96 }, { x: 0.44, y: 0.96 }, { x: 0.6, y: 0.72 }, { x: 0.6, y: 0 }]],
  V: [[{ x: 0, y: 0 }, { x: 0.3, y: 1 }, { x: 0.6, y: 0 }]],
  W: [[{ x: 0, y: 0 }, { x: 0.15, y: 1 }, { x: 0.3, y: 0.4 }, { x: 0.45, y: 1 }, { x: 0.6, y: 0 }]],
  Y: [[{ x: 0, y: 0 }, { x: 0.3, y: 0.5 }, { x: 0.6, y: 0 }], [{ x: 0.3, y: 0.5 }, { x: 0.3, y: 1 }]],
};
function buildWord(word, advance) {
  advance = advance || 0.75;
  const subs = [];
  let x = 0;
  for (const ch of word) {
    const g = GLYPHS[ch];
    if (g) for (const sub of g) subs.push(sub.map((p) => ({ x: p.x + x, y: p.y })));
    x += advance;
  }
  return { subs, w: Math.max(0.6, x - (advance - 0.6)) };
}
function wordBox(ox, oy, em, built, pad) {
  const p = (pad || 0.2) * em;
  return { x0: ox - p * 0.4, y0: oy - p * 0.4, x1: ox + built.w * em + em * 0.55 + p, y1: oy + em + p };
}

// ===========================================================================
// LAYERED WORD — the core "real graffiti" builder. Returns { layers, box }.
// tier: 'tag' | 'throwup' | 'blockbuster' | 'wildstyle'
// ===========================================================================
function layeredWord(word, ox, oy, em, persona, tier) {
  const hand = persona.hand, sch = persona.scheme;
  const built = buildWord(word, hand.letterSpacing);
  const wmid = built.w / 2;
  const layers = [];
  const fillLight = sch.fills[0];
  const fillMid = sch.fills[1] != null ? sch.fills[1] : sch.fills[0];
  const fillDark = sch.fills[sch.fills.length - 1];
  const shade = sch.shade;
  const off = em * 0.15; // 3D extrusion offset (deep enough to clearly peek out)
  const mapSub = (sub, dx, dy) => sub.map((p) => ({ x: ox + (dx || 0) + p.x * em, y: oy + (dy || 0) + p.y * em + (p.x - wmid) * em * hand.slant }));

  if (tier === "tag") {
    const col = chance(0.4) ? DARK : fillDark;
    const meta = { tool: chance(0.5) ? TOOL_SPRAY : TOOL_BRUSH, color: col, size: capSize(randInt(0, 1), persona), flags: 0 }; // cap preference; no FLAG_FLAT -> taper
    layers.push({ kind: "sketch", strokes: built.subs.map((sub) => hstroke(meta, mapSub(sub), hand, "gesture")) });
    if (chance(0.45 + hand.flourishProb * 0.4)) layers.push({ kind: "arrow", strokes: wildArrow(ox + built.w * em, oy + em * 0.5, em, col, hand) });
    return { layers, box: wordBox(ox, oy, em, built, 0.2) };
  }

  const doSketch = tier === "wildstyle" || chance((persona.behavior ? persona.behavior.ghost : 0.3)); // ghost guide, personality-driven
  const doFade = tier === "wildstyle" || tier === "blockbuster" || tier === "throwup";
  const do3D = tier === "wildstyle" || tier === "blockbuster";
  const doInline = tier === "wildstyle" || tier === "blockbuster"; // cream keyline — full layer stack
  const bhv = persona.behavior || { passes: 1, ghost: 0.3, capBias: 1 };
  const nOut = 1 + bhv.passes; // 2–3 outline re-cuts (patient piecers lay more; overlap = weight)

  // Humanize each letter's CENTRELINE once and share it, so the fat colour fill
  // and the two edge-outlines all follow the exact same wavy shape (outline is a
  // real CONTOUR around the fill, not a spine down the middle).
  const hps = built.subs.map((sub) => human(mapSub(sub), handOpt(hand, "fill")));
  const halfFace = HALFW[2];       // fill is size 2 (32px) -> edges at +/-16px

  // faint under-sketch (wildstyle)
  if (doSketch) {
    const smeta = { tool: TOOL_BRUSH, color: sch.accent, size: 0, flags: FLAG_SOFT };
    layers.push({ kind: "sketch", strokes: hps.map((hp) => stream(smeta, hp.map((p) => ({ x: p.x + rand(-2, 2), y: p.y + rand(-2, 2) })))) });
  }

  // 3D extrusion FIRST (sits BEHIND the face): a SOLID diagonal block in the
  // darker desaturated sibling, plus a hard DARK edge along the block's far side
  // so the depth reads crisply. Throw-ups get a simpler hard drop-shadow.
  if (do3D) {
    const threeMeta = { tool: TOOL_BRUSH, color: shade, size: 2, flags: FLAG_FLAT };
    const block = [];
    const steps = tier === "blockbuster" ? 3 : 2; // size-2 brush covers the extrusion in few passes
    for (const hp of hps) for (let k = 1; k <= steps; k++) { const f = k / steps; block.push(stream(threeMeta, hp.map((p) => ({ x: p.x + off * f, y: p.y + off * f })))); }
    // one crisp dark lip along the far (extruded) side reads the depth without
    // redrawing both edges of every letter (the face OUTLINE already cuts the near side).
    const edgeMeta = { tool: TOOL_BRUSH, color: DARK, size: 1, flags: FLAG_FLAT };
    for (const hp of hps) { const sh = hp.map((p) => ({ x: p.x + off, y: p.y + off })); block.push(stream(edgeMeta, offsetSub(sh, halfFace))); }
    layers.push({ kind: "threeD", strokes: block });
  } else if (tier === "throwup") {
    const shMeta = { tool: TOOL_BRUSH, color: DARK, size: 2, flags: FLAG_FLAT };
    const sh = [];
    const soff = em * 0.11, steps = 2;
    for (const hp of hps) for (let k = 1; k <= steps; k++) { const f = k / steps; sh.push(stream(shMeta, hp.map((p) => ({ x: p.x + soff * f, y: p.y + soff * f })))); }
    layers.push({ kind: "threeD", strokes: sh });
  }

  // COLOUR FILL — the fat, colour-dominant letter body (the piece's identity).
  // Two overlapping passes: the first lays the body, the second re-covers it with
  // a fresh tremor seed so the OVERLAP saturates toward the solid can colour (and
  // refreshes the base against the slow weathering fade).
  const fillMeta = { tool: TOOL_BRUSH, color: fillLight, size: 2, flags: FLAG_FLAT };
  const fillStrokes = [];
  for (const hp of hps) { fillStrokes.push(stream(fillMeta, hp)); fillStrokes.push(retracePass(hp, fillMeta, hand, 1.4, true)); }
  layers.push({ kind: "fill", strokes: fillStrokes });

  // fade — mid then darkest sibling sprayed on the lower part of the colour
  if (doFade) {
    const fade = [];
    for (let i = 0; i < built.subs.length; i++) {
      const hp = hps[i], y0 = Math.min.apply(null, hp.map((p) => p.y)), y1 = Math.max.apply(null, hp.map((p) => p.y)), h = y1 - y0 || 1;
      const fadeCap = capSize(1, persona); // fat cap = wider misting for bombers
      const mid = hp.filter((p) => (p.y - y0) / h > 0.45); if (mid.length >= 2) fade.push(stream({ tool: TOOL_SPRAY, color: fillMid, size: fadeCap, flags: 0 }, mid));
      const low = hp.filter((p) => (p.y - y0) / h > 0.72); if (low.length >= 2) fade.push(stream({ tool: TOOL_SPRAY, color: fillDark, size: fadeCap, flags: 0 }, low));
    }
    if (fade.length) layers.push({ kind: "fade", strokes: fade });
  }

  // arrows / connectors
  if (tier === "wildstyle" && chance(0.7)) layers.push({ kind: "arrow", strokes: wildArrow(ox + built.w * em, oy + em * 0.5, em, sch.accent, hand) });

  // OUTLINE recut ON TOP — trace BOTH edges of the fat colour (a real contour)
  // Re-cut each edge 2–3× (retrace): the overlap thickens the line into a solid,
  // confident outline the way a writer goes over it — not a single thin vector.
  const outMeta = { tool: TOOL_BRUSH, color: DARK, size: 1, flags: FLAG_FLAT };
  const outline = [];
  for (const hp of hps) {
    for (const s of retrace(offsetSub(hp, halfFace), outMeta, hand, nOut)) outline.push(s);
    for (const s of retrace(offsetSub(hp, -halfFace), outMeta, hand, nOut)) outline.push(s);
  }
  layers.push({ kind: "outline", strokes: outline });

  // keyline / inline (cream) just inside the outline
  if (doInline) {
    const inMeta = { tool: TOOL_BRUSH, color: CREAM, size: 0, flags: FLAG_FLAT };
    const inl = [];
    for (const hp of hps) { inl.push(stream(inMeta, offsetSub(hp, halfFace - 6))); inl.push(stream(inMeta, offsetSub(hp, -(halfFace - 6)))); }
    layers.push({ kind: "inline", strokes: inl });
  }

  // highlights / shines (warm white 4-point star), topmost
  {
    const shines = [];
    const n = 2 + (chance(0.5) ? 1 : 0);
    for (let i = 0; i < n; i++) shines.push(...starShine(ox + rand(0.08, 0.62) * built.w * em, oy + rand(0.06, 0.4) * em, em * rand(0.06, 0.1)));
    layers.push({ kind: "highlight", strokes: shines });
  }

  // drips — count scaled by the bot's drip tendency (personality)
  const dripN = Math.round(hand.dripiness * (persona.behavior ? persona.behavior.dripMul : 1) * (tier === "wildstyle" ? 5 : 4));
  if (dripN > 0) {
    const drips = [];
    for (let i = 0; i < dripN; i++) {
      const sub = pick(built.subs);
      let low = sub[0]; for (const p of sub) if (p.y > low.y) low = p;
      const wp = mapSub([low])[0];
      drips.push(dripStroke(wp.x + rand(-4, 4), wp.y + em * 0.02, em * rand(0.08, 0.2), fillDark));
    }
    layers.push({ kind: "drip", strokes: drips });
  }

  return { layers, box: wordBox(ox, oy, em, built, 0.28) };
}

// A soft cloud/background PANEL painted first (lowest z) behind a piece.
function cloudPanel(box, persona) {
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  const col = pick([1, 6, persona.scheme.accent]);
  const meta = { tool: TOOL_SPRAY, color: col, size: 2, flags: 0 };
  const strokes = [];
  for (let r = 0; r < 2; r++) {
    const yy = cy + (r - 0.5) * h * 0.3;
    const pts = [];
    for (let i = 0; i <= 5; i++) { const t = i / 5; pts.push({ x: box.x0 + t * w, y: yy + Math.sin(t * Math.PI) * -h * 0.12 + rand(-h * 0.04, h * 0.04) }); }
    strokes.push(stream(meta, resample(pts, 22)));
  }
  return strokes;
}

// ===========================================================================
// CHARACTERS — cel-shading (flat base + one darker shape per color + heavy
// dark outline + white gleam).
// ===========================================================================
function celParts(poly, fillColor, hand, opts) {
  opts = opts || {};
  const rows = opts.rows || 12;
  const fill = fillSegStrokes(scanFillPoly(poly, rows), fillColor, 2, hand);
  const shadePoly = shrinkPoly(poly, 0.72, opts.sdx != null ? opts.sdx : 6, opts.sdy != null ? opts.sdy : 6);
  const shade = fillSegStrokes(scanFillPoly(shadePoly, Math.max(6, Math.round(rows * 0.7))), opts.shadeColor != null ? opts.shadeColor : DARK, 2, hand);
  const outline = [hstroke({ tool: TOOL_BRUSH, color: DARK, size: 2, flags: FLAG_FLAT }, poly.concat([poly[0]]), hand, "outline")];
  return { fill, shade, outline };
}
function dot(x, y, r, color) { return fillSegStrokes(scanFillPoly(circle(x, y, r, 14), 4), color, 1, { seed: 1, tremor: 1, wobble: 1 }); }

// spray-can mascot
function sprayCanSpec(persona) {
  const em = rand(150, 230) * persona.scaleBias;
  const w = em * 0.9, h = em * 1.35;
  const sch = persona.scheme, hand = persona.hand;
  return {
    w: w + 60, h: h + 60, cloud: chance(0.5), key: "sprayCan",
    make: (ox, oy) => {
      const cx = ox + w / 2, top = oy + em * 0.28;
      const bodyW = em * 0.5, bodyH = em * 0.82;
      const body = ellipsePoly(cx, top + bodyH / 2, bodyW / 2, bodyH / 2, 26).map((p) => ({ x: p.x, y: clamp(p.y, top, top + bodyH) }));
      // rounded can body via a capsule-ish poly
      const cap = [
        { x: cx - bodyW * 0.28, y: top }, { x: cx + bodyW * 0.28, y: top },
        { x: cx + bodyW * 0.28, y: top - em * 0.14 }, { x: cx - bodyW * 0.28, y: top - em * 0.14 }, { x: cx - bodyW * 0.28, y: top },
      ];
      const nozzle = [{ x: cx - em * 0.05, y: top - em * 0.14 }, { x: cx + em * 0.05, y: top - em * 0.14 }, { x: cx + em * 0.05, y: top - em * 0.22 }, { x: cx - em * 0.05, y: top - em * 0.22 }, { x: cx - em * 0.05, y: top - em * 0.14 }];
      const bodyParts = celParts(body, sch.fills[0], hand, { rows: 16, shadeColor: sch.shade, sdx: bodyW * 0.16, sdy: 8 });
      const capParts = celParts(cap, sch.accent, hand, { rows: 5, shadeColor: DARK });
      const layers = [];
      layers.push({ kind: "fill", strokes: bodyParts.fill.concat(capParts.fill) });
      layers.push({ kind: "fade", strokes: bodyParts.shade.concat(capParts.shade) });
      // label band across the can
      const band = [{ x: cx - bodyW * 0.5, y: top + bodyH * 0.42 }, { x: cx + bodyW * 0.5, y: top + bodyH * 0.42 }, { x: cx + bodyW * 0.5, y: top + bodyH * 0.6 }, { x: cx - bodyW * 0.5, y: top + bodyH * 0.6 }, { x: cx - bodyW * 0.5, y: top + bodyH * 0.42 }];
      layers.push({ kind: "fill", strokes: fillSegStrokes(scanFillPoly(band, 4), CREAM, 2, hand) });
      // nozzle + cap outline + can outline
      layers.push({ kind: "outline", strokes: bodyParts.outline.concat(capParts.outline).concat(fillSegStrokes(scanFillPoly(nozzle, 3), DARK, 1, hand)) });
      // face: eyes + smile
      const face = [];
      face.push(...dot(cx - em * 0.12, top + bodyH * 0.22, em * 0.035, DARK));
      face.push(...dot(cx + em * 0.12, top + bodyH * 0.22, em * 0.035, DARK));
      face.push(hstroke({ tool: TOOL_BRUSH, color: DARK, size: 1, flags: 0 }, arc(cx, top + bodyH * 0.26, em * 0.14, 0.2 * Math.PI, 0.8 * Math.PI, 10), hand, "outline"));
      layers.push({ kind: "outline", strokes: face });
      // spraying dots (accent) up-right + gleam
      const spray = [hstroke({ tool: TOOL_SPRAY, color: sch.accent, size: 2, flags: 0 }, [{ x: cx + em * 0.05, y: top - em * 0.24 }, { x: cx + em * 0.3, y: top - em * 0.4 }, { x: cx + em * 0.5, y: top - em * 0.5 }], hand, "spray")];
      layers.push({ kind: "highlight", strokes: spray.concat(dot(cx - em * 0.12, top + bodyH * 0.5, em * 0.05, CREAM)) });
      const box = { x0: ox - 20, y0: top - em * 0.5, x1: ox + w + em * 0.5, y1: top + bodyH + 30 };
      return { layers, box };
    },
  };
}

// b-boy character (head + backwards cap + torso + one raised arm)
function bboySpec(persona) {
  const em = rand(160, 250) * persona.scaleBias;
  const sch = persona.scheme, hand = persona.hand;
  const w = em * 1.0, h = em * 1.3;
  return {
    w: w + 60, h: h + 60, cloud: chance(0.5), key: "bboy",
    make: (ox, oy) => {
      const cx = ox + w / 2, hy = oy + em * 0.42, hr = em * 0.2;
      const head = circle(cx, hy, hr, 26);
      const skin = sch.fills[1] != null ? sch.fills[1] : sch.fills[0];
      const headParts = celParts(head, skin, hand, { rows: 12, shadeColor: sch.shade, sdx: hr * 0.5, sdy: hr * 0.4 });
      // torso
      const ty = hy + hr;
      const torso = [{ x: cx - em * 0.22, y: ty }, { x: cx + em * 0.22, y: ty }, { x: cx + em * 0.3, y: ty + em * 0.5 }, { x: cx - em * 0.3, y: ty + em * 0.5 }, { x: cx - em * 0.22, y: ty }];
      const torsoParts = celParts(torso, sch.fills[0], hand, { rows: 10, shadeColor: sch.shade, sdx: em * 0.1, sdy: 8 });
      // backwards cap (arc band on the head top + brim to the back)
      const cap = [{ x: cx - hr, y: hy - hr * 0.2 }, { x: cx - hr * 0.2, y: hy - hr * 1.15 }, { x: cx + hr, y: hy - hr * 0.5 }, { x: cx + hr, y: hy - hr * 0.05 }, { x: cx - hr, y: hy - hr * 0.2 }];
      const capParts = celParts(cap, sch.accent, hand, { rows: 6, shadeColor: DARK });
      const layers = [];
      layers.push({ kind: "fill", strokes: headParts.fill.concat(torsoParts.fill).concat(capParts.fill) });
      layers.push({ kind: "fade", strokes: headParts.shade.concat(torsoParts.shade).concat(capParts.shade) });
      // arms: one raised
      const arm1 = hstroke({ tool: TOOL_BRUSH, color: skin, size: 2, flags: FLAG_FLAT }, [{ x: cx - em * 0.22, y: ty + em * 0.08 }, { x: cx - em * 0.42, y: ty - em * 0.18 }], hand, "fill");
      const arm2 = hstroke({ tool: TOOL_BRUSH, color: skin, size: 2, flags: FLAG_FLAT }, [{ x: cx + em * 0.22, y: ty + em * 0.08 }, { x: cx + em * 0.4, y: ty + em * 0.3 }], hand, "fill");
      layers.push({ kind: "fill", strokes: [arm1, arm2] });
      layers.push({ kind: "outline", strokes: headParts.outline.concat(torsoParts.outline).concat(capParts.outline) });
      // face
      const face = [];
      face.push(...dot(cx - em * 0.07, hy + em * 0.02, em * 0.028, DARK));
      face.push(...dot(cx + em * 0.07, hy + em * 0.02, em * 0.028, DARK));
      face.push(hstroke({ tool: TOOL_BRUSH, color: DARK, size: 1, flags: 0 }, arc(cx, hy + em * 0.09, em * 0.09, 0.15 * Math.PI, 0.85 * Math.PI, 10), hand, "outline"));
      layers.push({ kind: "outline", strokes: face });
      layers.push({ kind: "highlight", strokes: dot(cx - hr * 0.4, hy - hr * 0.4, em * 0.04, CREAM) });
      const box = { x0: ox - 30, y0: hy - hr * 1.4, x1: ox + w + 30, y1: ty + em * 0.6 };
      return { layers, box };
    },
  };
}

// ===========================================================================
// JAPANESE — torii gate in front of a warm rising sun (kanji-free so it stays
// renderable). Layered: sun disc (ground) -> rays -> red gate fill -> dark
// outline -> cream highlight. Warm palette only (sun yellow, gate vermilion).
// ===========================================================================
function toriiSpec(persona) {
  const em = rand(210, 300) * persona.scaleBias;
  const hand = persona.hand;
  const w = em * 1.25, h = em * 1.1;
  const red = pick([4, 5]);   // vitamin-C / malcolm — torii vermilion
  const sun = pick([6, 7]);   // beach / divine yellow — the sun
  return {
    w: w + 60, h: h + 60, cloud: false, key: "torii",
    make: (ox, oy) => {
      const cx = ox + w / 2;
      const scy = oy + em * 0.5, sr = em * 0.4;
      const layers = [];
      // rising sun disc (ground)
      layers.push({ kind: "fill", strokes: fillSegStrokes(scanFillPoly(circle(cx, scy, sr, 30), 22), sun, 2, hand) });
      // rays fanning up-out from the disc (straightedge) — drawn over the disc
      const rays = [];
      for (let i = 0; i < 9; i++) { const a = -Math.PI / 2 + (i - 4) * 0.3; rays.push(shape(TOOL_LINE, sun, 1, { x: cx, y: scy }, { x: cx + Math.cos(a) * sr * 1.85, y: scy + Math.sin(a) * sr * 1.85 })); }
      layers.push({ kind: "fade", strokes: rays });
      // torii gate geometry
      const pw = em * 0.11, top = oy + em * 0.18, bot = oy + em * 0.98;
      const lx = cx - em * 0.36, rx = cx + em * 0.36 - pw;
      const pillarL = [{ x: lx, y: top }, { x: lx + pw, y: top }, { x: lx + pw, y: bot }, { x: lx, y: bot }, { x: lx, y: top }];
      const pillarR = [{ x: rx, y: top }, { x: rx + pw, y: top }, { x: rx + pw, y: bot }, { x: rx, y: bot }, { x: rx, y: top }];
      // kasagi (top lintel) — upturned ends
      const ky = oy + em * 0.14, kh = em * 0.1;
      const kasagi = [{ x: cx - em * 0.52, y: ky + em * 0.03 }, { x: cx - em * 0.44, y: ky - em * 0.02 }, { x: cx + em * 0.44, y: ky - em * 0.02 }, { x: cx + em * 0.52, y: ky + em * 0.03 }, { x: cx + em * 0.5, y: ky + kh }, { x: cx - em * 0.5, y: ky + kh }, { x: cx - em * 0.52, y: ky + em * 0.03 }];
      // nuki (second bar)
      const ny = oy + em * 0.33, nh = em * 0.075;
      const nuki = [{ x: cx - em * 0.44, y: ny }, { x: cx + em * 0.44, y: ny }, { x: cx + em * 0.44, y: ny + nh }, { x: cx - em * 0.44, y: ny + nh }, { x: cx - em * 0.44, y: ny }];
      // gakuzuka (short centre post between kasagi and nuki)
      const gk = [{ x: cx - em * 0.04, y: ky + kh }, { x: cx + em * 0.04, y: ky + kh }, { x: cx + em * 0.04, y: ny }, { x: cx - em * 0.04, y: ny }, { x: cx - em * 0.04, y: ky + kh }];
      const redFill = []
        .concat(fillSegStrokes(scanFillPoly(kasagi, 6), red, 2, hand))
        .concat(fillSegStrokes(scanFillPoly(nuki, 5), red, 2, hand))
        .concat(fillSegStrokes(scanFillPoly(gk, 5), red, 2, hand))
        .concat(fillSegStrokes(scanFillPoly(pillarL, 20), red, 2, hand))
        .concat(fillSegStrokes(scanFillPoly(pillarR, 20), red, 2, hand));
      layers.push({ kind: "fill", strokes: redFill });
      // dark outline re-cut on top of the gate
      const outMeta = { tool: TOOL_BRUSH, color: DARK, size: 1, flags: FLAG_FLAT };
      const outline = [kasagi, nuki, gk, pillarL, pillarR].map((poly) => hstroke(outMeta, poly, hand, "outline"));
      layers.push({ kind: "outline", strokes: outline });
      // cream highlight glints on the gate
      layers.push({ kind: "highlight", strokes: starShine(lx + pw * 0.5, top + em * 0.12, em * 0.05).concat(starShine(cx, ky + kh * 0.5, em * 0.05)) });
      const box = { x0: ox - 20, y0: oy + em * 0.05, x1: ox + w + 20, y1: bot + 20 };
      return { layers, box };
    },
  };
}

// ===========================================================================
// STENCILS (Banksy) — flat filled silhouettes, 1-2 colours, no outline/3D.
// Returns { layers, box, helpMakers } (helpers add complementary work in
// THEIR OWN scheme).
// ===========================================================================
function girlStencil(ox, oy, em, caption) {
  const step = Math.max(12, em * 0.045);
  const rs = (pts) => resample(mapPts(pts, ox, oy, em), step);
  const D = (pts) => stream({ tool: TOOL_BRUSH, color: DARK, size: 2, flags: FLAG_FLAT }, rs(pts));
  const stencilHand = { tremor: 1.3, wobble: 0.8, seed: rand(1, 999), flourishProb: 0.2, letterSpacing: 0.75, slant: 0 };

  // dress (triangle scan fill), head, neck, legs, arm
  const primary = [];
  const rows = 22;
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const y = 0.455 + (0.70 - 0.455) * t;
    const lx = 0.30 + (0.225 - 0.30) * t;
    const rx = 0.30 + (0.375 - 0.30) * t;
    primary.push(D([{ x: lx, y }, { x: rx, y }]));
  }
  primary.push(D(circle(0.30, 0.385, 0.046, 20)));
  primary.push(D(circle(0.30, 0.385, 0.03, 16)));
  primary.push(D(circle(0.30, 0.385, 0.015, 10)));
  primary.push(D([{ x: 0.30, y: 0.43 }, { x: 0.30, y: 0.46 }]));
  primary.push(D([{ x: 0.278, y: 0.70 }, { x: 0.276, y: 0.85 }]));
  primary.push(D([{ x: 0.322, y: 0.70 }, { x: 0.324, y: 0.85 }]));
  primary.push(D([{ x: 0.33, y: 0.52 }, { x: 0.41, y: 0.43 }, { x: 0.48, y: 0.335 }]));

  // red heart balloon (solid fill + bold outline) + string
  const bx = 0.645, by = 0.225, bs = 0.19;
  const balloon = [];
  for (const seg of heartScanFill(bx, by, bs, 24)) balloon.push(stream({ tool: TOOL_BRUSH, color: 4, size: 2, flags: FLAG_FLAT }, rs(seg)));
  balloon.push(stream({ tool: TOOL_BRUSH, color: 5, size: 2, flags: FLAG_FLAT }, rs(heartPath(bx, by, bs))));
  const string = [stream({ tool: TOOL_BRUSH, color: DARK, size: 1, flags: FLAG_FLAT }, rs([{ x: 0.48, y: 0.335 }, { x: 0.575, y: 0.35 }, { x: 0.645, y: 0.415 }]))];

  const layers = [
    { kind: "fill", strokes: primary },
    { kind: "fill", strokes: balloon },
    { kind: "outline", strokes: string },
  ];
  const box = { x0: ox + em * 0.12, y0: oy + em * 0.02, x1: ox + em * 0.86, y1: oy + em * 0.98 };

  const helpMakers = [
    // caption in the helper's own scheme
    (bot) => {
      const p = bot.persona; const cap = buildWord(caption, p.hand.letterSpacing);
      const capEm = em * 0.12, capOx = ox + em * 0.16, capOy = oy + em * 0.92;
      const meta = { tool: TOOL_BRUSH, color: p.scheme.fills[p.scheme.fills.length - 1], size: 1, flags: FLAG_FLAT };
      const out = { tool: TOOL_BRUSH, color: DARK, size: 0, flags: FLAG_FLAT };
      const wmid = cap.w / 2;
      const msub = (sub, dx, dy) => sub.map((q) => ({ x: capOx + (dx || 0) + q.x * capEm, y: capOy + (dy || 0) + q.y * capEm }));
      return [
        { kind: "fill", strokes: cap.subs.map((sub) => hstroke(meta, msub(sub), p.hand, "fill")) },
        { kind: "outline", strokes: cap.subs.map((sub) => hstroke(out, msub(sub), p.hand, "outline")) },
      ];
    },
    // balloon highlight spray + sky accent (helper accent)
    (bot) => {
      const p = bot.persona;
      const hi = stream({ tool: TOOL_SPRAY, color: p.scheme.accent, size: 1, flags: 0 }, resample(mapPts([{ x: 0.60, y: 0.19 }, { x: 0.63, y: 0.20 }], ox, oy, em), step));
      const sky = hstroke({ tool: TOOL_SPRAY, color: 6, size: 1, flags: 0 }, mapPts([{ x: 0.70, y: 0.14 }, { x: 0.78, y: 0.18 }], ox, oy, em), p.hand, "spray");
      return [{ kind: "highlight", strokes: [hi, sky] }];
    },
    // faint ground line + small drifting balloons in helper reds
    (bot) => {
      const p = bot.persona;
      const ground = shape(TOOL_LINE, p.scheme.accent, 0, { x: ox + em * 0.14, y: oy + em * 0.885 }, { x: ox + em * 0.62, y: oy + em * 0.885 });
      const b1 = smallBalloon(ox, oy, em, 0.75, 0.16, 0.03, pick(REDS), step, p.hand);
      const b2 = smallBalloon(ox, oy, em, 0.82, 0.24, 0.025, pick(REDS), step, p.hand);
      return [{ kind: "outline", strokes: [ground].concat(b1).concat(b2) }];
    },
  ];
  return { layers, box, helpMakers };
}
function smallBalloon(ox, oy, em, bx, by, br, col, step, hand) {
  return [
    shape(TOOL_CIRCLE, col, 1, { x: ox + (bx - br) * em, y: oy + (by - br) * em }, { x: ox + (bx + br) * em, y: oy + (by + br) * em }),
    stream({ tool: TOOL_BRUSH, color: DARK, size: 0, flags: FLAG_SOFT }, resample(mapPts([{ x: bx, y: by + br }, { x: bx - 0.01, y: by + br + 0.06 }], ox, oy, em), step)),
  ];
}

function ratStencil(ox, oy, em, caption) {
  const cx = ox + em * 0.45, cy = oy + em * 0.55;
  const stencilHand = { tremor: 1.2, wobble: 0.8, seed: rand(1, 999), flourishProb: 0.2, letterSpacing: 0.75, slant: 0 };
  const body = ellipsePoly(cx, cy, em * 0.3, em * 0.2, 28);
  const head = ellipsePoly(cx - em * 0.28, cy - em * 0.02, em * 0.12, em * 0.1, 22);
  const earL = [{ x: cx - em * 0.34, y: cy - em * 0.12 }, { x: cx - em * 0.4, y: cy - em * 0.26 }, { x: cx - em * 0.26, y: cy - em * 0.2 }, { x: cx - em * 0.34, y: cy - em * 0.12 }];
  const earR = [{ x: cx - em * 0.24, y: cy - em * 0.13 }, { x: cx - em * 0.28, y: cy - em * 0.28 }, { x: cx - em * 0.16, y: cy - em * 0.2 }, { x: cx - em * 0.24, y: cy - em * 0.13 }];
  const legs = [];
  for (const lx of [-0.1, 0.05, 0.2]) legs.push(hstroke({ tool: TOOL_BRUSH, color: DARK, size: 2, flags: FLAG_FLAT }, [{ x: cx + lx * em, y: cy + em * 0.16 }, { x: cx + lx * em, y: cy + em * 0.3 }], stencilHand, "fill"));
  const tail = hstroke({ tool: TOOL_BRUSH, color: DARK, size: 1, flags: FLAG_FLAT }, [{ x: cx + em * 0.3, y: cy }, { x: cx + em * 0.5, y: cy - em * 0.08 }, { x: cx + em * 0.6, y: cy + em * 0.08 }], stencilHand, "outline");

  const silhouette = []
    .concat(fillSegStrokes(scanFillPoly(body, 16), DARK, 2, stencilHand))
    .concat(fillSegStrokes(scanFillPoly(head, 10), DARK, 2, stencilHand))
    .concat(fillSegStrokes(scanFillPoly(earL, 5), DARK, 1, stencilHand))
    .concat(fillSegStrokes(scanFillPoly(earR, 5), DARK, 1, stencilHand))
    .concat(legs)
    .concat([tail]);
  const eye = dot(cx - em * 0.31, cy - em * 0.04, em * 0.018, CREAM);

  const layers = [
    { kind: "fill", strokes: silhouette },
    { kind: "highlight", strokes: eye },
  ];
  const box = { x0: ox + em * 0.02, y0: oy + em * 0.2, x1: ox + em * 1.05, y1: oy + em * 0.92 };
  const helpMakers = [
    (bot) => {
      const p = bot.persona; const cap = buildWord(caption, p.hand.letterSpacing);
      const capEm = em * 0.13, capOx = cx - em * 0.1, capOy = cy + em * 0.34;
      const meta = { tool: TOOL_BRUSH, color: p.scheme.fills[p.scheme.fills.length - 1], size: 1, flags: FLAG_FLAT };
      const wmid = cap.w / 2;
      const msub = (sub) => sub.map((q) => ({ x: capOx + q.x * capEm, y: capOy + q.y * capEm + (q.x - wmid) * capEm * p.hand.slant }));
      return [{ kind: "fill", strokes: cap.subs.map((sub) => hstroke(meta, msub(sub), p.hand, "gesture")) }];
    },
    // a little spray-can prop + spray dots in the helper accent
    (bot) => {
      const p = bot.persona;
      const can = fillSegStrokes(scanFillPoly([{ x: cx + em * 0.34, y: cy + em * 0.14 }, { x: cx + em * 0.42, y: cy + em * 0.14 }, { x: cx + em * 0.42, y: cy + em * 0.3 }, { x: cx + em * 0.34, y: cy + em * 0.3 }, { x: cx + em * 0.34, y: cy + em * 0.14 }], 5), p.scheme.accent, 1, p.hand);
      const dots = hstroke({ tool: TOOL_SPRAY, color: p.scheme.accent, size: 1, flags: 0 }, [{ x: cx + em * 0.38, y: cy + em * 0.12 }, { x: cx + em * 0.2, y: cy - em * 0.06 }], p.hand, "spray");
      return [{ kind: "highlight", strokes: can.concat([dots]) }];
    },
  ];
  return { layers, box, helpMakers };
}

// ===========================================================================
// ICONS (doodler) — heart / star, crown+tag
// ===========================================================================
function heartStarSpec(persona) {
  const em = rand(120, 190) * persona.scaleBias;
  const sch = persona.scheme, hand = persona.hand;
  const w = em * 1.25, h = em * 1.25;
  const isHeart = chance(0.5);
  return {
    w: w + 40, h: h + 40, small: false, key: "heartStar",
    make: (ox, oy) => {
      const cx = ox + w / 2, cy = oy + h / 2;
      const layers = [];
      if (isHeart) {
        const col = pick(REDS);
        layers.push({ kind: "fill", strokes: fillSegStrokes(scanFillPoly(heartPath(cx, cy, em * 0.5), 20), col, 2, hand) });
        layers.push({ kind: "outline", strokes: [hstroke({ tool: TOOL_BRUSH, color: DARK, size: 1, flags: FLAG_FLAT }, heartPath(cx, cy, em * 0.5), hand, "outline")] });
      } else {
        const col = pick([6, 7, 8]);
        const sp = starPoly(cx, cy, em * 0.5, em * 0.22, 5);
        layers.push({ kind: "fill", strokes: fillSegStrokes(scanFillPoly(sp, 18), col, 2, hand) });
        layers.push({ kind: "outline", strokes: [hstroke({ tool: TOOL_BRUSH, color: DARK, size: 1, flags: FLAG_FLAT }, sp.concat([sp[0]]), hand, "outline")] });
      }
      layers.push({ kind: "highlight", strokes: starShine(cx - em * 0.14, cy - em * 0.16, em * 0.08) });
      const box = { x0: ox - 10, y0: oy - 10, x1: ox + w + 10, y1: oy + h + 10 };
      return { layers, box };
    },
  };
}
function crownTagSpec(persona) {
  const em = rand(100, 160) * persona.scaleBias;
  const sch = persona.scheme, hand = persona.hand;
  const word = pickWord(SHORTS);
  const built = buildWord(word, hand.letterSpacing);
  const w = Math.max(built.w * em, em * 1.3) + 40, h = em * 1.6;
  return {
    w, h, small: true, key: "crownTag",
    make: (ox, oy) => {
      const cw = built.w * em, cx = ox;
      const crown = crownPoly(cx, oy, Math.max(cw, em), em * 0.5);
      const layers = [];
      layers.push({ kind: "fill", strokes: fillSegStrokes(scanFillPoly(crown, 8), pick([6, 7, 8]), 2, hand) });
      layers.push({ kind: "outline", strokes: [hstroke({ tool: TOOL_BRUSH, color: DARK, size: 1, flags: FLAG_FLAT }, crown, hand, "outline")] });
      // crown jewel dots
      const jewels = [];
      for (const t of [0.35, 0.5, 0.65]) jewels.push(...dot(cx + t * Math.max(cw, em), oy + em * 0.04, em * 0.03, pick(REDS)));
      layers.push({ kind: "highlight", strokes: jewels });
      // handstyle tag under the crown
      const ty = oy + em * 0.62, wmid = built.w / 2;
      const meta = { tool: chance(0.5) ? TOOL_SPRAY : TOOL_BRUSH, color: chance(0.5) ? DARK : sch.fills[sch.fills.length - 1], size: randInt(0, 1), flags: 0 };
      const msub = (sub) => sub.map((q) => ({ x: cx + q.x * em, y: ty + q.y * em + (q.x - wmid) * em * hand.slant }));
      layers.push({ kind: "sketch", strokes: built.subs.map((sub) => hstroke(meta, msub(sub), hand, "gesture")) });
      if (chance(0.6)) layers.push({ kind: "arrow", strokes: wildArrow(cx + built.w * em, ty + em * 0.5, em, meta.color, hand) });
      const box = { x0: ox - 20, y0: oy - 20, x1: ox + Math.max(cw, em) + em * 0.5, y1: ty + em + 10 };
      return { layers, box };
    },
  };
}

// ===========================================================================
// Word specs (wildstyle / throw-up / blockbuster / script tag)
// ===========================================================================
function wordSpec(word, lo, hi, tier, persona, cloud) {
  let em = rand(lo, hi) * persona.scaleBias;
  const built = buildWord(word, persona.hand.letterSpacing);
  const maxW = CW - 240;
  if (built.w * em > maxW) em = maxW / built.w;
  const w = built.w * em + em * 0.75;
  const h = em * 1.7;
  return { w, h, cloud: !!cloud, small: tier === "tag", key: tier, make: (ox, oy) => layeredWord(word, ox + em * 0.1, oy + em * 0.35, em, persona, tier) };
}
// solo wildstyle words capped at 4 letters: with the full multi-pass layer stack
// (ghost -> fill×2 -> fade -> 3D -> outline×2-3 -> inline -> shines -> drips -> sign)
// a 4-letter piece is already elaborate and stays within a human drawing time.
// 5-7 letter words interlock into whole-wall PRODUCTIONS (split across bots).
const MEDS = uniq(["TKO", "OWL", "RSK", "CRW", "VNS", "NOVA", "KORE", "VIBE", "SORE", "FLOW", "MAKO", "OKR", "RIOT"].concat(CONTENT_WORDS.filter((w) => w.length === 4)));
function wildstyleSpec(p) { return wordSpec(pickWord(MEDS), 155, 240, "wildstyle", p, chance(0.55)); }
function throwupSpec(p) { return wordSpec(pickWord(SHORTS), 150, 240, "throwup", p, chance(0.3)); }
function blockbusterSpec(p) { return wordSpec(pickWord(SHORTS), 170, 260, "blockbuster", p, chance(0.4)); }
function scriptTagSpec(p) { return wordSpec(pickWord(WORDS), 120, 200, "tag", p, false); }

// signature: a small handstyle tag near the piece
function signStrokes(handle, box, persona) {
  const hand = persona.hand;
  const em = rand(46, 74) * persona.scaleBias;
  const built = buildWord(handle, Math.min(0.72, hand.letterSpacing));
  const maxW = (box.x1 - box.x0) * 0.9;
  let e = em; if (built.w * e > maxW) e = maxW / built.w;
  const ox = box.x0 + rand(0.02, 0.12) * (box.x1 - box.x0);
  const oy = clamp(box.y1 - e * 1.15, 40, CH - 40);
  const col = chance(0.5) ? DARK : persona.scheme.fills[persona.scheme.fills.length - 1];
  const meta = { tool: chance(0.5) ? TOOL_SPRAY : TOOL_BRUSH, color: col, size: capSize(0, persona), flags: 0 };
  const wmid = built.w / 2;
  const msub = (sub) => sub.map((q) => ({ x: ox + q.x * e, y: oy + q.y * e + (q.x - wmid) * e * hand.slant }));
  return built.subs.map((sub) => hstroke(meta, msub(sub), hand, "sign"));
}

// ===========================================================================
// Phases + jobs
// ===========================================================================
function phaseDwell(kind, persona) {
  const scale = persona && persona.role === "bomber" ? 0.4 : persona && persona.role === "tagger" ? 0.5 : 1;
  const R = (a, b) => Math.round(randInt(a, b) * scale);
  switch (kind) {
    case "cloud": return { pre: R(8, 16), post: R(4, 10) };
    case "sketch": return { pre: R(6, 14), post: R(4, 10) };
    case "fill": return { pre: R(8, 16), post: R(6, 14) };
    case "fade": return { pre: R(6, 12), post: R(5, 12) };
    case "threeD": return { pre: R(10, 20), post: R(6, 14) };
    case "arrow": return { pre: R(6, 12), post: R(4, 8) };
    case "outline": return { pre: R(10, 18), post: R(8, 16) };
    case "inline": return { pre: R(6, 12), post: R(4, 10) };
    case "highlight": return { pre: R(8, 16), post: R(6, 14) };
    case "drip": return { pre: R(6, 14), post: R(6, 16) };
    case "sign": return { pre: R(10, 20), post: R(10, 24) };
    default: return { pre: R(4, 10), post: R(4, 10) };
  }
}
function layersToPhases(layers, persona) {
  const skip = new Set();
  if (persona.role === "bomber") { skip.add("sketch"); skip.add("inline"); skip.add("highlight"); }
  if (persona.role === "tagger") { skip.add("sketch"); skip.add("threeD"); skip.add("inline"); }
  const phases = [];
  for (const l of layers) {
    if (!l.strokes || !l.strokes.length) continue;
    if (skip.has(l.kind)) continue;
    const d = phaseDwell(l.kind, persona);
    phases.push({ kind: l.kind, strokes: l.strokes, pre: d.pre, post: d.post, speed: phaseSpeed(l.kind, persona.hand.speed) });
  }
  return phases;
}
// Estimate a job's duration in ticks from the MOTOR MODEL (Steering-Law time per
// stroke, ceiling-bounded) so the anti-overlap reservation lives as long as the
// (now human-paced) job actually takes.
function estimateTicks(phases, persona) {
  const bh = persona.behavior || { precision: 1 };
  const react = MOTOR.reactionTicks();
  let t = 30 + 40;                 // scout reach + step-back admire baseline
  let lastMeta = null;
  for (const ph of phases) {
    t += ph.pre + ph.post;
    const inFill = ph.kind === "fill" || ph.kind === "scan" || ph.kind === "fade" || ph.kind === "threeD" || ph.kind === "cloud";
    const m0 = ph.strokes.length ? ph.strokes[0].meta : null;
    if (m0) { const ch = !lastMeta || lastMeta.tool !== m0.tool || lastMeta.color !== m0.color || lastMeta.size !== m0.size; if (ch) t += 52; lastMeta = m0; } // cap/colour change ≈ 2.6 s
    for (const st of ph.strokes) {
      let A = 0; for (let i = 1; i < st.pts.length; i++) A += Math.hypot(st.pts[i].x - st.pts[i - 1].x, st.pts[i].y - st.pts[i - 1].y);
      const wMul = (st.wMul || 1) * bh.precision;                 // personality + quick-pass looseness
      const mt = Math.max(MOTOR.steeringMT(A, ph.kind, wMul), A / MOTOR.kindCeiling(ph.kind, bh.precision)); // per-kind ceiling
      t += Math.ceil(mt * MOTOR.TICK_HZ) + (inFill ? 0 : react);  // oneshots also cost their drag time
    }
  }
  return Math.round(t);
}
let JOB_SEQ = 1;
function makeJob(phases, persona, opt) {
  return {
    phases, phi: 0, si: 0, pi: 0, open: false,
    dwell: 0, phaseStarted: false,
    scout: opt.scout || null,
    scoutPath: null, scoutIdx: 0,
    hopPath: null, hopIdx: 0,
    along: null, alongCarry: 0, curv: null,
    prep: null, lastMeta: null, pendMeta: null, reacted: false, shot: null,
    admire: 0, done: false,
    box: opt.box,
    speed: persona.hand.speed,
    // seeded PRNG so this job's WindMouse cursor motion is deterministic per run
    rng: WM.makeRng(((persona.hand.seed * 2654435761) ^ (JOB_SEQ++ * 40503)) >>> 0),
    persona,
  };
}
function firstMeta(job) {
  for (let i = job.phi; i < job.phases.length; i++) { const ph = job.phases[i]; if (ph.strokes.length) return metaOf(ph.strokes[0]); }
  return null;
}
function firstPhaseKind(job) {
  for (let i = job.phi; i < job.phases.length; i++) { const ph = job.phases[i]; if (ph.strokes.length) return ph.kind; }
  return "outline";
}

// Build a full solo job from a subject spec.
const SUBJ = {
  wildstyle: wildstyleSpec, throwup: throwupSpec, blockbuster: blockbusterSpec, scriptTag: scriptTagSpec,
  bboy: bboySpec, sprayCan: sprayCanSpec, heartStar: heartStarSpec, crownTag: crownTagSpec, torii: toriiSpec,
  girl: (p) => { const em = Math.min(CW, CH) * 0.42 * p.scaleBias; return { w: em * 1.1, h: em * 1.1, key: "girl", make: (ox, oy) => { const g = girlStencil(ox, oy, em, pick(["HOPE", "RISE"])); return { layers: g.layers, box: g.box }; } }; },
  rat: (p) => { const em = Math.min(CW, CH) * 0.28 * p.scaleBias; return { w: em * 1.2, h: em * 1.0, key: "rat", make: (ox, oy) => { const g = ratStencil(ox, oy, em, pick(["RISE", "HOPE"])); return { layers: g.layers, box: g.box }; } }; },
};
function chooseSubject(role) {
  const r = Math.random();
  switch (role) {
    case "tagger": return r < 0.6 ? SUBJ.scriptTag : SUBJ.crownTag;
    case "bomber": return r < 0.4 ? SUBJ.throwup : (r < 0.75 ? SUBJ.blockbuster : SUBJ.wildstyle);
    case "piecer": return r < 0.6 ? SUBJ.wildstyle : (r < 0.85 ? SUBJ.blockbuster : SUBJ.torii);
    case "character": return r < 0.32 ? SUBJ.bboy : (r < 0.56 ? SUBJ.sprayCan : (r < 0.74 ? SUBJ.torii : (r < 0.87 ? SUBJ.rat : SUBJ.girl)));
    case "doodler": return r < 0.45 ? SUBJ.heartStar : (r < 0.75 ? SUBJ.crownTag : SUBJ.throwup);
    default: return SUBJ.throwup;
  }
}
// Keep a job under a human drawing-TIME budget so an elaborate piece finishes
// before it weathers its own early fills. Over budget, shed the least-essential
// layers first (ghost sketch -> keyline -> arrow -> cloud -> fade); if still over,
// thin the multi-pass fill/outline/3D to every other stroke. The identity layers
// (fill, 3D, outline, highlights, drips, signature) always survive.
const PIECE_BUDGET_TICKS = 2100; // keep even elaborate multi-pass pieces under ~3 min so early fills don't weather away
function coarsenPhases(phases, persona) {
  const dropOrder = ["sketch", "inline", "arrow", "cloud", "fade"];
  let est = estimateTicks(phases, persona);
  for (const kind of dropOrder) {
    if (est <= PIECE_BUDGET_TICKS) break;
    const i = phases.findIndex((p) => p.kind === kind);
    if (i >= 0) { phases.splice(i, 1); est = estimateTicks(phases, persona); }
  }
  if (est > PIECE_BUDGET_TICKS) {
    for (const p of phases) if ((p.kind === "fill" || p.kind === "outline" || p.kind === "threeD") && p.strokes.length > 6) p.strokes = p.strokes.filter((_, i) => i % 2 === 0);
  }
  return phases;
}
function subjectToJob(persona) {
  const spec = chooseSubject(persona.role)(persona);
  const spot = pickSpot(spec.w, spec.h, { home: persona.home, allowOverlap: spec.small && chance(0.5), margin: spec.small ? 20 : 44 });
  const built = spec.make(spot.ox, spot.oy);
  const box = built.box;
  const layers = [];
  if (spec.cloud) layers.push({ kind: "cloud", strokes: cloudPanel(box, persona) });
  for (const l of built.layers) layers.push(l);
  layers.push({ kind: "sign", strokes: signStrokes(persona.handle, box, persona) });
  const phases = coarsenPhases(layersToPhases(layers, persona), persona);
  const ttl = clamp(estimateTicks(phases, persona) + 200, 400, 6000);
  reserve(box, ttl);
  addDensity(box.x0, box.y0, box.x1, box.y1, 1.0);
  return makeJob(phases, persona, { scout: { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 }, box });
}

// ===========================================================================
// Collaborations
// ===========================================================================
function buildBanksyCollab(banksyPersona) {
  const which = pick(["girl", "rat", "girl"]);
  const caption = pick(["HOPE", "DREAM", "RISE", "BLOOM"]);
  const em = Math.min(CW, CH) * (which === "rat" ? 0.42 : 0.6);
  const ox = (CW - em) / 2, oy = (CH - em) / 2 - em * 0.04;
  const spec = which === "girl" ? girlStencil(ox, oy, em, caption) : ratStencil(ox, oy, em, caption);
  const box = spec.box;
  const tasks = [];
  tasks.push({
    kind: "primary", taken: false, by: 0,
    make: () => { const phases = layersToPhases(spec.layers, banksyPersona); return makeJob(phases, banksyPersona, { scout: { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 }, box }); },
  });
  for (const hm of spec.helpMakers) {
    tasks.push({
      kind: "help", taken: false, by: 0,
      make: (bot) => { const layers = hm(bot); const phases = layersToPhases(layers, bot.persona); return makeJob(phases, bot.persona, { scout: { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 }, box }); },
    });
  }
  return { kind: "banksy", title: caption, tasks, box };
}
function buildProductionCollab() {
  const word = pick(PROD_WORDS);
  const n = word.length;
  const em = clamp((CW - 500) / (n * 0.95), 150, 300);
  const totalW = n * em * 0.95;
  const ox0 = (CW - totalW) / 2;
  const oy = (CH - em) / 2 - em * 0.05;
  const tasks = [];
  for (let i = 0; i < n; i++) {
    const ch = word[i];
    const lx = ox0 + i * em * 0.95;
    tasks.push({
      kind: "letter", taken: false, by: 0, letterIndex: i,
      make: (bot) => {
        const p = bot.persona;
        const built = layeredWord(ch, lx, oy, em, p, chance(0.5) ? "wildstyle" : "blockbuster");
        const layers = [{ kind: "cloud", strokes: cloudPanel(built.box, p) }].concat(built.layers);
        const phases = layersToPhases(layers, p);
        return makeJob(phases, p, { scout: { x: (built.box.x0 + built.box.x1) / 2, y: (built.box.y0 + built.box.y1) / 2 }, box: built.box });
      },
    });
  }
  const box = { x0: ox0 - 70, y0: oy - 90, x1: ox0 + totalW + em * 0.6 + 70, y1: oy + em + 130 };
  return { kind: "production", title: word, tasks, box };
}

// ===========================================================================
// Bot manager
// ===========================================================================
const BOT_NAMES = ["Sable", "Ochre", "Marigold", "Sienna", "Clementine", "Poppy", "Hazel", "Saffron", "Coral", "Amber", "Rusty", "Juniper", "Cleo", "Bruno", "Reko"];

class BotManager {
  constructor(allocId) {
    this.allocId = allocId;
    this.bots = [];
    this.collab = null;
    this._collabCooldown = 140; // ~7s before the first collab
    this._roleBag = shuffle(ROLES.slice());
    this._roleCursor = 0;
    this._schemeBag = buildSchemeBag(); // distinct colour FAMILIES first, so no two bots read alike
    this._schemeCursor = 0;
  }

  spawnAll(n) { for (let i = 0; i < n; i++) this.spawn(i === 0); }

  spawn(isArtist) {
    const id = this.allocId();
    const role = isArtist ? "character" : this._roleBag[this._roleCursor++ % this._roleBag.length];
    // Pull a DISTINCT colour scheme so no two bots read as the same colour; the
    // bot commits to it for its whole piece (fill/3D/keyline all derive from it).
    const scheme = schemeFrom(this._schemeBag[this._schemeCursor++ % this._schemeBag.length]);
    const persona = makePersona(role, scheme);
    if (isArtist) persona.handle = "BANKSY";
    const bot = {
      id,
      name: isArtist ? "Banksy" : pick(BOT_NAMES),
      isArtist: !!isArtist,
      persona,
      cx: rand(0.15, 0.85) * CW,
      cy: rand(0.15, 0.85) * CH,
      color: persona.scheme.fills[0],
      tool: TOOL_BRUSH,
      press: 0,
      job: null,
      cooldown: randInt(10, 70),
    };
    this.bots.push(bot);
    return bot;
  }

  get count() { return this.bots.length; }

  cursors() {
    return this.bots.map((b) => ({ id: b.id, x: b.cx, y: b.cy, pressing: b.press > 0, color: b.color, tool: b.tool, name: b.name }));
  }

  _freeCount() { let n = 0; for (const b of this.bots) if (!b.job) n++; return n; }

  update() {
    const events = [];
    tickWorld();
    if (this._collabCooldown > 0) this._collabCooldown--;
    for (const bot of this.bots) {
      if (bot.press > 0) bot.press--;
      if (!bot.job) {
        this._acquire(bot);
        if (!bot.job) {
          bot.cx = clamp(bot.cx + rand(-4, 4), 20, CW - 20);
          bot.cy = clamp(bot.cy + rand(-4, 4), 20, CH - 20);
          bot.press = 0;
          continue;
        }
      }
      this._advance(bot, events);
    }
    if (this.collab && this.collab.tasks.every((t) => t.taken)) {
      this.collab = null;
      this._collabCooldown = randInt(500, 900); // ~25-45s between collabs
    }
    return events;
  }

  _acquire(bot) {
    if (!this.collab && this._collabCooldown <= 0 && bot.isArtist && this._freeCount() >= 2) {
      this.collab = chance(0.5) ? buildBanksyCollab(bot.persona) : buildProductionCollab();
      reserve(this.collab.box, 1600);
      addDensity(this.collab.box.x0, this.collab.box.y0, this.collab.box.x1, this.collab.box.y1, 2);
    }
    if (this.collab) {
      const t = this._claimTask(bot);
      if (t) { bot.job = t.job; return; }
    }
    if (bot.cooldown > 0) { bot.cooldown--; return; }
    bot.cooldown = randInt(20, 80);
    bot.job = subjectToJob(bot.persona);
  }

  _claimTask(bot) {
    const c = this.collab;
    if (!c) return null;
    let order;
    if (c.kind === "banksy") order = bot.isArtist ? ["primary", "help"] : ["help"];
    else order = ["letter"];
    for (const kind of order) {
      for (const t of c.tasks) {
        if (!t.taken && t.kind === kind) { t.taken = true; t.by = bot.id; t.job = t.make(bot); return t; }
      }
    }
    return null;
  }

  _advance(bot, events) {
    const job = bot.job;
    if (job.done) { bot.job = null; return; }

    // dwell — idle, not pressing (sizing up / switching cans / stepping back)
    if (job.dwell > 0) { job.dwell--; bot.press = 0; return; }

    // scout — travel the cursor to the spot without pressing, holding the tool.
    // The reach is a full 2-D WindMouse path (gravity + wind on a mass): it
    // accelerates from rest, bows through a gentle arc, and settles/overshoots
    // into the target — a human reach, not a straight ruler hop. Params scale
    // with distance so a long reach isn't thousands of micro-steps.
    if (job.scout) {
      const first = firstMeta(job);
      if (first) { bot.tool = first.tool; bot.color = first.color; }
      if (!job.scoutPath) {
        const d0 = Math.hypot(job.scout.x - bot.cx, job.scout.y - bot.cy);
        const P = {
          G: rand(9, 12),
          W: clamp(d0 * 0.018, 3, 9),
          M: clamp(d0 * 0.06, 14, 80),
          D: clamp(d0 * 0.08, 10, 40),
        };
        // WindMouse gives the reach SHAPE; FITTS'S LAW gives its DURATION (a long
        // reach to a precise first mark takes longer). Play the path over that many ticks.
        job.scoutPath = WM.windMouse(bot.cx, bot.cy, job.scout.x, job.scout.y, P, job.rng);
        const firstKind = firstPhaseKind(job);
        job.scoutTicks = MOTOR.fittsTicks(d0, MOTOR.toleranceW(firstKind));
        job.scoutF = 0;
      }
      if (job.scoutF < job.scoutPath.length - 1) {
        job.scoutF += (job.scoutPath.length - 1) / job.scoutTicks;
        const p = job.scoutPath[Math.min(job.scoutPath.length - 1, Math.floor(job.scoutF))];
        bot.cx = clamp(p.x, 8, CW - 8); bot.cy = clamp(p.y, 8, CH - 8); bot.press = 0;
        return;
      }
      // settle at the target, then a ~200 ms reaction beat before the first mark
      const tgt = job.scout;
      bot.cx = clamp(tgt.x, 8, CW - 8); bot.cy = clamp(tgt.y, 8, CH - 8);
      job.scout = null; job.scoutPath = null; job.dwell = MOTOR.reactionTicks() + randInt(4, 10); bot.press = 0;
      return;
    }

    // all phases done — step-back "admire" beat, then relocate
    if (job.phi >= job.phases.length) {
      if (job.admire <= 0) { const sb = job.persona.behavior ? job.persona.behavior.stepBackProb : 0.4; job.admire = chance(sb) ? randInt(46, 90) : randInt(8, 20); bot._driftx = rand(-7, -1); bot._drifty = rand(-3, 3); }
      job.admire--;
      bot.press = 0;
      bot.cx = clamp(bot.cx + bot._driftx, 20, CW - 20);
      bot.cy = clamp(bot.cy + bot._drifty, 20, CH - 20);
      if (job.admire <= 0) { job.done = true; bot.job = null; }
      return;
    }

    const ph = job.phases[job.phi];
    if (!job.phaseStarted) {
      job.phaseStarted = true; job.si = 0; job.pi = 0; job.open = false; job.reacted = false;
      const m0 = ph.strokes.length ? metaOf(ph.strokes[0]) : null;
      job.pendMeta = m0;
      if (m0) {
        const lm = job.lastMeta;
        const changed = !lm || lm.tool !== m0.tool || lm.color !== m0.color || lm.size !== m0.size;
        if (changed) { job.prep = startPrep(job, bot, m0); }   // grab+shake+test costs time
        else { bot.tool = m0.tool; bot.color = m0.color; if (ph.pre > 0) { job.dwell = ph.pre; bot.press = 0; return; } }
      }
    }
    // run the cap/colour-change sequence (reach -> shake -> test spray) before painting
    if (job.prep) { if (stepPrep(job, bot, events)) return; job.lastMeta = job.pendMeta; }

    if (job.si >= ph.strokes.length) {
      job.phi++; job.phaseStarted = false;
      if (ph.post > 0) { job.dwell = ph.post; bot.press = 0; }
      return;
    }

    const st = ph.strokes[job.si];
    const m = metaOf(st);
    bot.tool = m.tool; bot.color = m.color;

    // Reposition HOP: when the pen moves to the next distinct mark (next letter,
    // dip to a can), travel there on a WindMouse arc with the pen UP so it reads
    // as a hand lifting and repositioning — not an instant teleport. Played as a
    // duration-based WindMouse reach (only capped for very long gaps), with a low
    // gate so even medium repositions arc instead of snapping. Suppressed WITHIN
    // fill/scan passes (those serpentine with the pen down — no lift per row).
    const inFillPass = ph.kind === "fill" || ph.kind === "scan" || ph.kind === "fade" || ph.kind === "threeD" || ph.kind === "cloud";
    if (!job.open && job.pi === 0) {
      const start = st.pts[0];
      const gap = Math.hypot(start.x - bot.cx, start.y - bot.cy);
      // Every non-trivial reposition is a PEN-UP reach (so the PRESSED tip never
      // teleports past the drawing ceiling). Reach SHAPE = WindMouse; DURATION =
      // FITTS'S LAW. Inside continuous fill passes only the big initial approach
      // hops — serpentine U-turns between adjacent rows (small gaps) flow through.
      const hopGate = inFillPass ? 44 : 18; // fills: only the big initial approach hops; serpentine U-turns flow
      if (gap > hopGate && !job.hopPath) {
        const P = { G: rand(9, 12), W: clamp(gap * 0.02, 3, 8), M: clamp(gap * 0.08, 12, 60), D: clamp(gap * 0.1, 10, 30) };
        job.hopPath = WM.windMouse(bot.cx, bot.cy, start.x, start.y, P, job.rng);
        job.hopTicks = MOTOR.fittsTicks(gap, MOTOR.toleranceW(ph.kind));
        job.hopF = 0;
      }
      if (job.hopPath) {
        if (job.hopF < job.hopPath.length - 1) {
          job.hopF += (job.hopPath.length - 1) / job.hopTicks;
          const p = job.hopPath[Math.min(job.hopPath.length - 1, Math.floor(job.hopF))];
          bot.cx = clamp(p.x, 8, CW - 8); bot.cy = clamp(p.y, 8, CH - 8); bot.press = 0;
          return;
        }
        job.hopPath = null;
      }
    }

    if (!st.stream) {
      // ~200 ms reaction beat before a shape (straightedge / roller / stencil).
      if (!job.reacted) { job.reacted = true; job.dwell = MOTOR.reactionTicks(); bot.press = 0; return; }
      const a = st.pts[0], b = st.pts[st.pts.length - 1];
      // DRAW the defining A->B drag at motor speed (pen down, never a teleport):
      // Steering-Law time for that straight tunnel, ceiling-bounded. The tool then
      // commits the finished shape on the last tick.
      if (!job.shot) {
        const D = Math.hypot(b.x - a.x, b.y - a.y);
        const prec = job.persona.behavior ? job.persona.behavior.precision : 1;
        const mt = Math.max(MOTOR.steeringMT(D, ph.kind, prec), D / MOTOR.kindCeiling(ph.kind, prec));
        job.shot = { ticks: Math.max(2, Math.round(mt * MOTOR.TICK_HZ)), f: 0 };
        bot.cx = a.x; bot.cy = a.y; bot.press = 6;
      }
      job.shot.f++;
      const tt = Math.min(1, job.shot.f / job.shot.ticks);
      bot.cx = a.x + (b.x - a.x) * tt; bot.cy = a.y + (b.y - a.y) * tt; bot.press = 6;
      if (tt >= 1) {
        events.push({ type: "oneshot", ownerId: bot.id, raw: { ...st.meta, points: [a, b] } });
        job.shot = null; job.reacted = false; job.si++; job.open = false; job.pi = 0;
      }
      return;
    }

    if (!job.open) {
      // ~200 ms REACTION pause before starting a distinct mark (decision point).
      // Skipped inside continuous fill passes (the hand keeps flowing).
      if (!inFillPass && !job.reacted) { job.reacted = true; job.dwell = MOTOR.reactionTicks(); bot.press = 0; return; }
      job.reacted = false;
      const p0 = st.pts[0];
      bot.cx = p0.x; bot.cy = p0.y; bot.press = 6;
      job.open = true; job.pi = 1;
      // MOTOR PLAN: Steering-Law time MT for this stroke, distributed by the
      // Two-Thirds power law (v = K·R^(1/3), K normalised so ∫ ds/v == MT). The
      // tolerance is scaled by the bot's PRECISION personality and (for a quick
      // re-trace pass) the stroke's own looseness.
      const wMul = (job.persona.behavior ? job.persona.behavior.precision : 1) * (st.wMul || 1);
      job.plan = MOTOR.planStroke(st.pts, ph.kind, wMul);
      job.arcPos = 0; job.emitArc = 0; job.feedW = 0; job.microPause = 0;
      job.kCeil = MOTOR.kindCeiling(ph.kind, job.persona.behavior ? job.persona.behavior.precision : 1);
      events.push({ type: "begin", ownerId: bot.id, name: bot.name, raw: st.meta, x: p0.x, y: p0.y });
      if (st.pts.length <= 1) { events.push({ type: "end", ownerId: bot.id }); job.open = false; job.si++; job.pi = 0; }
      return;
    }

    // ADVANCE the tip. Base speed v(s)=K·R(s)^(1/3) (Two-Thirds law, MT-normalised)
    // is then given a LIVE velocity texture the client can actually reveal:
    //  · a slow OU feed-wander (~0.5–1.5 Hz, ±~20%) so the feed is never a flat crawl;
    //  · a GEOMETRY-GATED micro-pause (v→~0 for 2–4 ticks) at cusps / tight corners —
    //    the primary human hesitation, anchored to shape, not a memoryless coin flip;
    //  · a PER-KIND, PER-BOT ceiling (fine liner slow, fat fill fast), not one global.
    const plan = job.plan;
    while (job.pi + 1 < st.pts.length && plan.cum[job.pi + 1] <= job.arcPos) job.pi++;
    job.feedW = job.feedW / 1.732 + (2 * job.rng() - 1) * 0.22 / 2.236;   // √3/√5 OU wander
    let v = MOTOR.speedAt(plan, job.pi) * (1 + job.feedW);
    const R = plan.R[job.pi];
    if (job.microPause <= 0 && R < 16 && job.rng() < 0.4) job.microPause = 2 + (job.rng() * 3 | 0); // cusp/corner hesitation
    if (job.microPause > 0) { job.microPause--; v *= 0.15; }
    if (v > job.kCeil) v = job.kCeil;                 // per-kind/per-bot ceiling
    if (v < MOTOR.V_FLOOR) v = MOTOR.V_FLOOR;
    job.arcPos += v / MOTOR.TICK_HZ;
    // DEPOSIT: commit points at a spacing SHAPED BY SPEED — slow/dwell → dense
    // points → perfect-freehand reads higher pressure → WIDER + DARKER mark; fast
    // flick → sparse → thinner + lighter. Capped ≤6 px so fast/curvy shape still
    // Nyquist-samples (no 40 px facets). Mark front = arcPos → never a teleport.
    const capped = Math.min(job.arcPos, plan.A);
    const sp = clamp(v / MOTOR.TICK_HZ, 1.4, 6);      // committed spacing (deposit weight)
    const out = [];
    while (job.emitArc + sp <= capped && out.length < 40) { job.emitArc += sp; out.push(pointAtArc(st.pts, plan.cum, job.emitArc)); }
    const tip = pointAtArc(st.pts, plan.cum, capped);
    bot.cx = tip.x; bot.cy = tip.y; bot.press = 6;
    if (out.length) events.push({ type: "append", ownerId: bot.id, points: out });
    if (job.arcPos >= plan.A) {
      if (job.emitArc < plan.A - 0.5) events.push({ type: "append", ownerId: bot.id, points: [{ x: tip.x, y: tip.y }] });
      events.push({ type: "end", ownerId: bot.id }); job.open = false; job.si++; job.pi = 0;
    }
  }
}

// ===========================================================================
// CAP / COLOUR / TOOL CHANGE = a real sequence that costs TIME (never instant):
//   (a) TRAVEL down to the can rack / belt to grab the new can — reach time from
//       FITTS'S LAW,  (b) SHAKE the can — a ~0.6–1.5 s ball-bearing rattle (dwell
//       + small cursor oscillation),  (c) a TEST SPRAY / throwaway dash on the
//       wall to check the cap/flow,  then the real work begins. Only fires when
//       the tool/colour/cap actually changed vs. the last committed mark.
// ===========================================================================
function startPrep(job, bot, meta) {
  const box = job.box || { x0: bot.cx - 120, y0: bot.cy - 120, x1: bot.cx + 120, y1: bot.cy + 120 };
  const bh = job.persona.behavior;
  const rack = {
    x: clamp((box.x0 + box.x1) / 2 + rand(-0.2, 0.2) * (box.x1 - box.x0), 30, CW - 30),
    y: clamp(box.y1 + rand(130, 260), 30, CH - 30),
  };
  const test = chance(bh.testProb) ? {
    x: clamp(box.x0 - rand(18, 60), 24, CW - 40),
    y: clamp((box.y0 + box.y1) / 2 + rand(-0.25, 0.25) * (box.y1 - box.y0), 30, CH - 40),
  } : null;
  return { stage: "toRack", rack, test, meta, shakeTot: 0, shakeLeft: 0, path: null, pathTicks: 1, pathF: 0, testStarted: false };
}
function playReach(job, bot, p, W) {
  if (!p.path) {
    const d = Math.hypot(p._tx - bot.cx, p._ty - bot.cy);
    p.path = WM.windMouse(bot.cx, bot.cy, p._tx, p._ty, { G: rand(9, 12), W: 6, M: clamp(d * 0.07, 14, 70), D: 20 }, job.rng);
    p.pathTicks = MOTOR.fittsTicks(d, W); p.pathF = 0;
  }
  if (p.pathF < p.path.length - 1) {
    p.pathF += (p.path.length - 1) / p.pathTicks;
    const q = p.path[Math.min(p.path.length - 1, Math.floor(p.pathF))];
    bot.cx = clamp(q.x, 8, CW - 8); bot.cy = clamp(q.y, 8, CH - 8); bot.press = 0;
    return false;
  }
  p.path = null; return true;
}
// returns true while prep is still running (caller returns), false when finished
function stepPrep(job, bot, events) {
  const p = job.prep, bh = job.persona.behavior;
  if (p.stage === "toRack") {
    p._tx = p.rack.x; p._ty = p.rack.y;
    if (!playReach(job, bot, p, 26)) return true;
    bot.tool = p.meta.tool; bot.color = p.meta.color;      // grabbed the new can
    p.shakeTot = p.shakeLeft = MOTOR.reactionTicks() + Math.round(rand(bh.shakeMs[0], bh.shakeMs[1]) / 1000 * MOTOR.TICK_HZ);
    p.stage = "shake"; return true;
  }
  if (p.stage === "shake") {
    const ph2 = p.shakeTot - p.shakeLeft;                  // ball-bearing rattle (pen up)
    bot.cx = clamp(p.rack.x + Math.sin(ph2 * 1.9) * 3.6 + (job.rng() * 2 - 1) * 1.3, 8, CW - 8);
    bot.cy = clamp(p.rack.y + Math.cos(ph2 * 2.3) * 3.1 + (job.rng() * 2 - 1) * 1.3, 8, CH - 8);
    bot.press = 0;
    if (--p.shakeLeft > 0) return true;
    p.stage = p.test ? "toTest" : "done"; return true;
  }
  if (p.stage === "toTest") {
    p._tx = p.test.x; p._ty = p.test.y;
    if (!playReach(job, bot, p, 22)) return true;
    p.stage = "test"; return true;
  }
  if (p.stage === "test") {
    if (!p.testStarted) {                                  // a short throwaway TEST SPRAY
      p.testStarted = true;
      const zz = []; const n = 3 + (job.rng() * 2 | 0);
      for (let i = 0; i <= n; i++) zz.push({ x: p.test.x + i * rand(10, 18), y: p.test.y + ((i % 2) ? -1 : 1) * rand(6, 14) });
      p.testPts = zz; p.testPlan = MOTOR.planStroke(zz, "spray", bh.precision); p.testArc = 0; p.testIdx = 1;
      bot.cx = zz[0].x; bot.cy = zz[0].y; bot.press = 6;
      events.push({ type: "begin", ownerId: bot.id, name: bot.name, raw: { tool: TOOL_SPRAY, color: p.meta.color, size: Math.min(2, p.meta.size), flags: FLAG_SOFT }, x: zz[0].x, y: zz[0].y });
      return true;
    }
    while (p.testIdx + 1 < p.testPts.length && p.testPlan.cum[p.testIdx + 1] <= p.testArc) p.testIdx++;
    let v = MOTOR.speedAt(p.testPlan, p.testIdx) * 1.1; if (v > MOTOR.V_CEILING) v = MOTOR.V_CEILING;
    p.testArc += v / MOTOR.TICK_HZ;
    const tip = pointAtArc(p.testPts, p.testPlan.cum, Math.min(p.testArc, p.testPlan.A));
    bot.cx = tip.x; bot.cy = tip.y; bot.press = 6;
    events.push({ type: "append", ownerId: bot.id, points: [{ x: tip.x, y: tip.y }] });
    if (p.testArc >= p.testPlan.A) { events.push({ type: "end", ownerId: bot.id }); p.stage = "done"; }
    return true;
  }
  job.prep = null; bot.press = 0; return false;
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = randInt(0, i);[a[i], a[j]] = [a[j], a[i]]; } return a; }

module.exports = { BotManager };
