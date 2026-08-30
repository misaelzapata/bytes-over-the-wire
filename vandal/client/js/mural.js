"use strict";

// =============================================================================
// mural.js (client) — Shared paint layer: a full-resolution offscreen canvas
//                     for rasterizing committed strokes, plus live stroke map
//                     and region-based undo redraw.
// Capa de pintura compartida (cliente): un canvas offscreen a resolucion
// completa para rasterizar trazos confirmados, mas mapa de trazos en vivo
// y redibujado de deshacer basado en region.
//
// Key concepts / Conceptos clave:
//   - Offscreen transparent buffer where all committed strokes are painted / Buffer transparente offscreen donde se pintan todos los trazos confirmados
//   - Stroke history + byId map mirrors the server for undo support / Historial de trazos + mapa byId replica el servidor para soporte de deshacer
//   - Live strokes from other painters rendered as in-progress overlays / Trazos en vivo de otros pintores renderizados como capas en progreso
//   - Cosmetic "patina" aging fades old paint so fresh tags stand out / Envejecimiento cosmetico "patina" desvanece pintura vieja para destacar tags frescos
// =============================================================================

// VANDAL — mural.js. The shared PAINT layer: a full-resolution TRANSPARENT
// offscreen buffer (CANVAS_W x CANVAS_H) that every committed stroke is
// rasterized onto (the wall shows through, so the eraser reveals brick). Plus
// the ordered stroke list (for undo) and a map of in-progress LIVE strokes
// still being streamed by other painters.

// Client history cap — mirrors the server's MAX_STROKES so replay/redraw can't
// grow unbounded over a long session. Oldest (fully aged-out) strokes retire.
const HISTORY_CAP = 4000;

const Mural = {
  offscreen: null,
  octx: null,
  strokes: [], // ordered oldest -> newest (mirrors the server history)
  byId: new Map(), // strokeId -> stroke
  myStrokeIds: [], // stack of my own stroke ids (newest last)
  live: new Map(), // strokeId -> in-progress stroke {ownerId,tool,color,size,soft,points}

  init() {
    this.offscreen = document.createElement("canvas");
    this.offscreen.width = World.canvasW || C.CANVAS_W;
    this.offscreen.height = World.canvasH || C.CANVAS_H;
    this.octx = this.offscreen.getContext("2d");
    this.clear();
    // Gentle "patina": paint very slowly weathers back toward the wall, so the
    // freshest tags own the focal plane and a busy wall keeps turning over
    // instead of saturating to mud. Cosmetic only (history stays authoritative).
    setInterval(() => this.agePass(), 4000);
  },

  // Resize the paint buffer to a new (server-announced) wall size, preserving
  // any strokes already loaded by re-rasterizing them.
  resize(w, h) {
    if (!this.offscreen) return;
    if (this.offscreen.width === w && this.offscreen.height === h) return;
    this.offscreen.width = w;
    this.offscreen.height = h;
    this.replayAll();
  },

  // Fade the whole paint layer a hair toward the bare wall (destination-out
  // removes a little alpha everywhere; empty wall is untouched).
  agePass() {
    if (!this.octx) return;
    this.octx.save();
    this.octx.setTransform(1, 0, 0, 1, 0, 0);
    this.octx.globalCompositeOperation = "destination-out";
    this.octx.fillStyle = "rgba(0,0,0,0.02)";
    this.octx.fillRect(0, 0, this.offscreen.width, this.offscreen.height);
    this.octx.restore();
  },

  clear() {
    this.strokes = [];
    this.byId.clear();
    this.myStrokeIds = [];
    this.live.clear();
    this.octx.setTransform(1, 0, 0, 1, 0, 0);
    this.octx.clearRect(0, 0, this.offscreen.width, this.offscreen.height);
  },

  // Commit a completed stroke coming from the server (own or someone else's).
  addStroke(s) {
    this.live.delete(s.id); // supersede any in-progress copy
    if (this.byId.has(s.id)) return;
    s._bbox = strokeBBox(s); // painted-extent bbox for O(region) undo redraw
    this.strokes.push(s);
    this.byId.set(s.id, s);
    if (s.ownerId === World.selfId) this.myStrokeIds.push(s.id);
    drawStroke(this.octx, s);
    this._evict();
  },

  // Bound client history growth to the server cap. Only the very oldest strokes
  // retire — by then agePass has faded them out of the offscreen, so dropping
  // them (and thus not being able to redraw them under a later undo) is
  // imperceptible while keeping replay/redraw cost bounded.
  _evict() {
    if (this.strokes.length <= HISTORY_CAP) return;
    const removed = this.strokes.splice(0, this.strokes.length - HISTORY_CAP);
    for (const s of removed) {
      this.byId.delete(s.id);
      const j = this.myStrokeIds.indexOf(s.id);
      if (j >= 0) this.myStrokeIds.splice(j, 1);
    }
  },

  // --- live streaming (other painters' in-progress strokes) ---------------
  beginLive(m) {
    if (m.ownerId === World.selfId) return; // self is shown via local preview
    this.live.set(m.id, {
      id: m.id,
      ownerId: m.ownerId,
      tool: m.tool,
      color: m.color,
      size: m.size,
      soft: m.soft,
      flat: m.flat,
      points: [{ x: m.x, y: m.y }],
    });
  },
  appendLive(id, pts) {
    const s = this.live.get(id);
    if (!s) return;
    for (const p of pts) s.points.push(p);
  },

  // Load an entire mural (join) — clear then rasterize all strokes in order.
  loadHistory(strokes) {
    this.clear();
    for (const s of strokes) {
      s._bbox = strokeBBox(s);
      this.strokes.push(s);
      this.byId.set(s.id, s);
      if (s.ownerId === World.selfId) this.myStrokeIds.push(s.id);
    }
    this.replayAll();
  },

  removeStroke(id) {
    const s = this.byId.get(id);
    if (!s) return;
    this.byId.delete(id);
    const i = this.strokes.findIndex((x) => x.id === id);
    if (i >= 0) this.strokes.splice(i, 1);
    const j = this.myStrokeIds.lastIndexOf(id);
    if (j >= 0) this.myStrokeIds.splice(j, 1);

    // Undo = REGION redraw, not a full-buffer replay. Clear only the removed
    // stroke's painted-extent bbox, then re-rasterize just the survivors whose
    // bbox overlaps it, clipped to that region so overlaps aren't double-painted.
    // O(strokes-in-region) — replayAll() cleared + redrew the ENTIRE 4000x2500
    // buffer (every spray particle of every stroke) on each undo, which froze the
    // tab; this keeps a single undo cheap regardless of how full the wall is.
    const bb = s._bbox || strokeBBox(s);
    if (!bb) { this.replayAll(); return; }
    const x0 = Math.max(0, Math.floor(bb.x));
    const y0 = Math.max(0, Math.floor(bb.y));
    const x1 = Math.min(this.offscreen.width, Math.ceil(bb.x + bb.w));
    const y1 = Math.min(this.offscreen.height, Math.ceil(bb.y + bb.h));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return;

    this.octx.save();
    this.octx.setTransform(1, 0, 0, 1, 0, 0);
    this.octx.clearRect(x0, y0, w, h);
    this.octx.beginPath();
    this.octx.rect(x0, y0, w, h);
    this.octx.clip();
    for (const o of this.strokes) {
      const ob = o._bbox || (o._bbox = strokeBBox(o));
      if (ob && bboxIntersect(ob, bb)) drawStroke(this.octx, o);
    }
    this.octx.restore();
  },

  replayAll() {
    this.octx.setTransform(1, 0, 0, 1, 0, 0);
    this.octx.clearRect(0, 0, this.offscreen.width, this.offscreen.height);
    for (const s of this.strokes) drawStroke(this.octx, s);
  },

  canUndo() {
    return this.myStrokeIds.length > 0;
  },
};

// ---------------------------------------------------------------------------
// Stroke rasterization — shared by the offscreen mural and the live preview.
// `stroke` = { tool, color, size, soft, points:[{x,y}] } in world coordinates.
// opts.preview = true when drawing an on-top preview over the composited scene
// (the eraser then tints instead of punching a hole).
// ---------------------------------------------------------------------------
function drawStroke(ctx, stroke, opts) {
  const preview = opts && opts.preview;
  const width = SIZES[stroke.size] || SIZES[0];
  const isEraser = stroke.tool === TOOL.ERASER;
  const color = isEraser ? ERASE_COLOR : PALETTE[stroke.color] || PALETTE[0];
  const pts = stroke.points;
  if (!pts || pts.length === 0) return;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  // Committed marks vary in pigment strength (by id) so stacked tags read as
  // layered rather than all-equally-fresh. Live previews stay full strength.
  if (!isEraser) ctx.globalAlpha = preview ? 1 : 0.78 + 0.22 * hash2(stroke.id || 1, 7, 3);

  if (isEraser) {
    // BUFF: full-width perfect-freehand outline (no taper, so it clears cleanly
    // to the endpoints). Falls back to the stamped brush if pf is unavailable.
    const eo = strokeOutline(pts, width, { taper: false });
    if (preview) {
      ctx.globalAlpha = 0.85;
      if (eo) fillOutline(ctx, eo); else stampBrush(ctx, pts, width, false, color);
    } else {
      ctx.globalCompositeOperation = "destination-out";
      if (eo) fillOutline(ctx, eo); else stampBrush(ctx, pts, width, false, color);
    }
    ctx.restore();
    return;
  }

  switch (stroke.tool) {
    case TOOL.LINE:
      // STRAIGHTEDGE: NOT a perfect vector line — a taped/straightedge stroke has
      // a little hand wobble along its length + a sprayed/marker-bled edge.
      drawStraightedge(ctx, pts[0], pts[pts.length - 1], width, color, preview);
      break;
    case TOOL.RECT:
      // ROLLER / FILL: a patchy hand-rolled block — uneven wobbly edges, roller-
      // nap streaks, a few missed spots — never a crisp vector rectangle.
      fillRectFromPts(ctx, pts[0], pts[pts.length - 1], color, preview);
      break;
    case TOOL.CIRCLE:
      // STENCIL ring — sprayed/feathered, not a crisp vector ellipse.
      strokeEllipseFromPts(ctx, pts[0], pts[pts.length - 1], width, color, preview);
      break;
    case TOOL.SPRAY:
      // SPRAY CAN: SIZE is the CAP (0 skinny precise line -> 2 fat soft cloud).
      stampSpray(ctx, pts, width, color, stroke.size | 0, preview);
      break;
    case TOOL.BRUSH:
    default:
      // MARKER / FILL: perfect-freehand body, then the AEROSOL FILL treatment so
      // broad fills read hand-sprayed (grain, patchy coverage, ragged soft edge)
      // instead of a flat solid vector shape.
      drawMarker(ctx, pts, width, !!stroke.soft && !stroke.flat, color, !!stroke.flat, preview);
      break;
  }
  ctx.restore();
}

// Straight polyline (also used by LINE).
function strokePolyline(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function strokeRectFromPts(ctx, a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  ctx.strokeRect(x, y, w, h);
}

// Generate a wobbly hand-rolled rectangle outline (array of [x,y] pairs).
// Subdivides each side into small segments and offsets each vertex by a
// deterministic pseudo-random amount so the shape never looks like a crisp
// vector rectangle.
function wobblyRectPath(x, y, w, h) {
  const poly = [];
  const step = Math.max(6, Math.min(w, h) / 8);
  const wobble = Math.max(1.5, Math.min(w, h) * 0.02);
  const sides = [
    { sx: x,     sy: y,     ex: x + w, ey: y     },  // top
    { sx: x + w, sy: y,     ex: x + w, ey: y + h },  // right
    { sx: x + w, sy: y + h, ex: x,     ey: y + h },  // bottom
    { sx: x,     sy: y + h, ex: x,     ey: y     },  // left
  ];
  for (let si = 0; si < sides.length; si++) {
    const { sx, sy, ex, ey } = sides[si];
    const dx = ex - sx, dy = ey - sy;
    const len = Math.hypot(dx, dy);
    const n = Math.max(1, Math.round(len / step));
    // normal direction (perpendicular to edge, pointing outward)
    const nx = -dy / (len || 1), ny = dx / (len || 1);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const px = sx + dx * t;
      const py = sy + dy * t;
      const h2 = hash2(Math.round(px), Math.round(py), si + 37);
      const off = (h2 - 0.5) * 2 * wobble;
      poly.push([px + nx * off, py + ny * off]);
    }
  }
  return poly;
}

// ROLLER / FILL — a patchy HAND-ROLLED block: an uneven wobbly silhouette (never
// a crisp rectangle), roller-nap streaks running along the roll direction, a few
// missed "holiday" spots, interior spray grain and a ragged, oversprayed edge.
function fillRectFromPts(ctx, a, b, color, preview) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  if (w < 2 || h < 2) return;
  const ga = ctx.globalAlpha;
  const horiz = w >= h;                       // roll direction = the long axis
  const poly = wobblyRectPath(x, y, w, h);    // uneven hand-rolled outline
  const pathFn = (c) => outlinePath(c, poly);

  // 1) base block (the uneven silhouette, not a rectangle)
  ctx.globalAlpha = ga;
  pathFn(ctx); ctx.fill();

  // 2) roller-nap streaks along the roll direction — lighter (thinned) gaps ...
  ctx.save();
  pathFn(ctx); ctx.clip();
  const span = horiz ? h : w;
  const nap = Math.max(3, Math.round(span / 8));
  ctx.globalCompositeOperation = preview ? "source-over" : "destination-out";
  for (let i = 0; i < nap; i++) {
    const f = (i + 0.5) / nap;
    const s = hash2(Math.round(x + (horiz ? 0 : f * w)), Math.round(y + (horiz ? f * h : 0)), 17);
    if (s < 0.52) continue;
    if (preview) { ctx.fillStyle = ERASE_COLOR; ctx.globalAlpha = ga * 0.10 * s; }
    else ctx.globalAlpha = 0.08 + 0.16 * s;
    const t = 0.7 + s * 1.5;
    if (horiz) ctx.fillRect(x, y + f * h - t / 2, w, t);
    else ctx.fillRect(x + f * w - t / 2, y, t, h);
  }
  ctx.restore();
  // ... and heavier (extra-pigment) nap passes
  ctx.save();
  pathFn(ctx); ctx.clip();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = color;
  for (let i = 0; i < nap; i++) {
    const f = (i + 0.5) / nap;
    const s = hash2(Math.round(x + 7 + (horiz ? 0 : f * w)), Math.round(y + 3 + (horiz ? f * h : 0)), 29);
    if (s < 0.62) continue;
    ctx.globalAlpha = ga * 0.14 * s;
    if (horiz) ctx.fillRect(x, y + f * h - 1, w, 2);
    else ctx.fillRect(x + f * w - 1, y, 2, h);
  }
  ctx.restore();

  // 3) interior grain + occasional missed spots (committed offscreen only)
  if (!preview) aerosolInterior(ctx, pathFn, { minx: x, miny: y, maxx: x + w, maxy: y + h }, 0.6);
  // 4) ragged eroded edge + soft overspray so the boundary is not a vector line
  if (!preview) aerosolEdge(ctx, poly, 11, 0.7);
  aerosolOverspray(ctx, poly, color, 13, ga * 0.5);
  ctx.globalAlpha = ga;
}

// STENCIL ring — stroke the ellipse, then overspray its rim so it reads as a
// sprayed cut, not a crisp vector ellipse.
function strokeEllipseFromPts(ctx, a, b, width, color, preview) {
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2;
  const ry = Math.abs(b.y - a.y) / 2;
  if (rx < 0.5 || ry < 0.5) return;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  const seg = Math.max(24, Math.round((rx + ry) * 0.5));
  const poly = [];
  for (let i = 0; i <= seg; i++) { const th = (i / seg) * Math.PI * 2; poly.push([cx + Math.cos(th) * rx, cy + Math.sin(th) * ry]); }
  aerosolOverspray(ctx, poly, color, width * 1.3, ctx.globalAlpha * 0.5);
}

// perfect-freehand outline for the MARKER/BUFF: a smooth variable-width ribbon
// with hand-drawn tapers + round caps. Width is a pure render-time function of
// the fixed SIZE byte (nothing here touches the wire). Returns an outline point
// array, or null if the vendored global isn't loaded (renderer then falls back
// to the legacy stamp). `opts`: { flat, soft, taper:false to disable taper }.
function strokeOutline(pts, width, opts) {
  if (typeof getStroke !== "function" || !pts || pts.length === 0) return null;
  opts = opts || {};
  const flat = !!opts.flat, soft = !!opts.soft;
  const taper = opts.taper !== false; // default: tapered ends
  const size = width;
  // Cap the point count fed to perfect-freehand: getStroke is O(n), and a long
  // drag (thousands of points) re-rendered per frame hung the tab. 256 points is
  // plenty for a smooth outline. Protects marker AND buff (both use this).
  let src = pts;
  if (src.length > 256) {
    const step = src.length / 256, ds = [];
    for (let k = 0; k < 256; k++) ds.push(src[Math.floor(k * step)]);
    ds.push(src[src.length - 1]);
    src = ds;
  }
  const input = src.map((p) => [p.x, p.y]);
  const outline = getStroke(input, {
    size: size,
    thinning: flat ? 0.2 : 0.55,   // chisel = flatter width; marker = pressure-like
    smoothing: soft ? 0.65 : 0.5,
    streamline: 0.35,
    simulatePressure: true,        // width from point spacing; taper via start/end
    start: { taper: taper && !flat ? size * 2 : 0, cap: true },
    end: { taper: taper && !flat ? size * 3 : 0, cap: true },
    last: true,
  });
  return outline && outline.length >= 3 ? outline : null;
}

// Fill a perfect-freehand outline as a single closed path.
function fillOutline(ctx, outline) {
  if (!outline || outline.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]);
  ctx.closePath();
  ctx.fill();
}

// MARKER handstyle: fill a perfect-freehand outline, then a slightly-inset,
// lower-alpha SECOND pass so the ink density a single flat fill would lose is
// retained (the core reads denser than the feathered edge). Hard markers add a
// faint wider under-halo so the stroke reads bleedy, not like a vector line.
// Soft brushes add a blurred shadow halo. Falls back to the stamp without pf.
function drawMarker(ctx, pts, width, soft, color, flat, preview) {
  const ga = ctx.globalAlpha;
  // LIVE PREVIEW re-renders the WHOLE in-progress stroke every frame. Running
  // perfect-freehand (getStroke) + the aerosol treatment over the full growing
  // point list at 60fps hangs the tab ("se tilda"). While dragging, use the
  // cheap tapered stamp; the committed offscreen redraw (preview=false) applies
  // the full pf + aerosol treatment ONCE on release.
  if (preview) { stampBrush(ctx, pts, width, soft, color, flat, !soft && !flat); return; }
  const outline = strokeOutline(pts, width, { flat, soft });
  if (!outline) {
    stampBrush(ctx, pts, width, soft, color, flat, !soft && !flat);
    return;
  }
  // How "fill-like" this mark is: ~0 for a thin handstyle tag (stays crisp/dense),
  // ~1 for a broad blockbuster fill (full aerosol grain + ragged sprayed edge).
  // This is what stops a filled silhouette from reading as a flat printed solid.
  const gAmt = Math.max(0, Math.min(1, (width - 8) / 26));

  // marker bleed: faint wider under-halo (hard edge only)
  if (!soft) {
    const bleed = strokeOutline(pts, width * 1.5, { flat });
    if (bleed) { ctx.globalAlpha = ga * 0.14; fillOutline(ctx, bleed); }
  }
  if (soft) {
    ctx.shadowColor = color;
    ctx.shadowBlur = (width / 2) * 0.9;
  }
  const bodyA = soft ? ga * 0.92 : ga;
  ctx.globalAlpha = bodyA;
  fillOutline(ctx, outline);
  ctx.shadowBlur = 0;

  const bb = outlineBBox(outline);
  // interior aerosol grain + patchy coverage + missed spots (offscreen only —
  // it punches real transparency; a live preview stays additive so it can't
  // erase the scene behind it)
  if (gAmt > 0.03 && !preview) {
    aerosolInterior(ctx, (c) => outlinePath(c, outline), bb, gAmt * (soft ? 0.5 : 0.85));
  }
  // erode the boundary into a ragged, feathered edge (offscreen only)
  if (gAmt > 0.03 && !preview) aerosolEdge(ctx, outline, width, gAmt);
  // oversprayed rim of flecks straddling the edge — buries the vector boundary
  // (additive, so it also runs on the live preview)
  aerosolOverspray(ctx, outline, color, width, ga * (0.45 + 0.4 * gAmt));

  // inset denser core keeps ink density on thin/medium marks (skipped on broad
  // fills so it doesn't just refill the grain we punched)
  if (gAmt < 0.6) {
    const inner = strokeOutline(pts, width * 0.68, { flat, soft });
    if (inner) { ctx.globalAlpha = bodyA * 0.5; fillOutline(ctx, inner); }
  }
  ctx.globalAlpha = ga;
}

// STRAIGHTEDGE — a taped/straightedge stroke that still reads as HUMAN: a gentle
// low-frequency bow plus small world-keyed jitter along the length, rendered as a
// flat marker ribbon so it gets the sprayed/bled edge (never a razor vector line).
function drawStraightedge(ctx, a, b, width, color, preview) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) { drawMarker(ctx, [a, b], width, false, color, true, preview); return; }
  const nx = -dy / len, ny = dx / len;                 // unit perpendicular
  const bow = (hash2(Math.round(a.x), Math.round(a.y), 7) - 0.5) * Math.min(len * 0.03, 9);
  const amp = Math.min(3.0, width * 0.12 + 1.3);
  const segs = Math.max(8, Math.round(len / 26));
  const wob = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const bx = a.x + dx * t, by = a.y + dy * t;
    const hx = Math.round(bx), hy = Math.round(by);
    const jitter = (hash2(hx, hy, 3) - 0.5) * 2 * amp + (hash2(hx, hy, 9) - 0.5) * amp * 0.6;
    const off = Math.sin(t * Math.PI) * bow + jitter;
    wob.push({ x: bx + nx * off, y: by + ny * off });
  }
  drawMarker(ctx, wob, width, false, color, true, preview);
}

// Tapered stamped brush: resample the polyline at a fine spacing and fill a
// circle at each step, tapering the radius toward both ends for a soft, hand-
// drawn cap. Soft brushes add a blurred halo for a blended, pastel feel.
// (Legacy fallback path used when perfect-freehand is unavailable.)
function stampBrush(ctx, pts, width, soft, color, flat, bleed) {
  const ga = ctx.globalAlpha;
  const r0 = width / 2;
  const spacing = Math.max(1, r0 * 0.3);
  const path = resample(pts, spacing);
  if (path.length === 0) return;
  const total = path[path.length - 1].d || 1;
  const taper = flat ? 0 : Math.min(total * 0.5, width * 1.4);

  // MARKER bleed: a faint slightly-wider ink halo under the hard stroke so the
  // handstyle reads as a real bleedy marker (not a crisp vector line).
  if (bleed && !soft) {
    ctx.save();
    ctx.globalAlpha = ga * 0.14;
    for (let i = 0; i < path.length; i++) { ctx.beginPath(); ctx.arc(path[i].x, path[i].y, r0 * 1.25, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  if (soft) {
    ctx.shadowColor = color;
    ctx.shadowBlur = r0 * 0.9;
    ctx.globalAlpha = ga * 0.92;
  }

  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    let t = 1;
    if (taper > 0) {
      const dEnd = Math.min(p.d, total - p.d);
      t = Math.min(1, dEnd / taper);
      t = 0.35 + 0.65 * easeOut(t);
    }
    const r = r0 * t;
    if (r < 0.3) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Aerosol spray: scatter many soft low-alpha particles within a feathered cone
// along the path, denser at the center. Density builds up where the stroke
// dwells/overlaps. Occasional gravity drips. Deterministic (hashed by integer
// coords) so every client renders the same graffiti.
function stampSpray(ctx, pts, width, color, cap) {
  const ga = ctx.globalAlpha;
  // The SPRAY CAN's SIZE is the CAP: skinny (0) = tight, precise line with a
  // hot solid core; fat (2) = wide, soft, feathered cloud that drips more.
  cap = cap | 0;
  const spread = cap === 0 ? 1.15 : cap === 1 ? 1.5 : 1.8;
  const coreA = cap === 0 ? 0.30 : cap === 1 ? 0.18 : 0.13;
  const dripP = cap === 0 ? 0.02 : cap === 1 ? 0.045 : 0.075;
  const sprayR = Math.max(6, width * spread);
  const spacing = Math.max(2, sprayR * (cap === 0 ? 0.22 : 0.28));
  const path = resample(pts, spacing);
  if (path.length === 0) return;
  const baseN = Math.round(12 + width * 0.9);

  for (let j = 0; j < path.length; j++) {
    const cx = path[j].x;
    const cy = path[j].y;
    const hx = Math.round(cx);
    const hy = Math.round(cy);

    // soft aerosol cloud body (density builds where the stroke dwells/overlaps)
    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, sprayR);
    grd.addColorStop(0, hexA(color, coreA));
    grd.addColorStop(0.5, hexA(color, coreA * 0.44));
    grd.addColorStop(1, hexA(color, 0));
    ctx.globalAlpha = ga;
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(cx, cy, sprayR, 0, Math.PI * 2);
    ctx.fill();

    // speckle particles — uneven sputter + feathered rim
    ctx.fillStyle = color;
    const n = Math.round(baseN * (0.7 + 0.6 * hash2(hx, hy, 7)));
    for (let i = 0; i < n; i++) {
      const a = hash2(hx, hy, i * 3 + 1) * Math.PI * 2;
      const rr = sprayR * Math.pow(hash2(hx, hy, i * 3 + 2), cap === 0 ? 0.7 : 0.5);
      const edge = 1 - rr / sprayR;
      if (edge <= 0) continue;
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      const h3 = hash2(hx, hy, i * 3 + 3);
      ctx.globalAlpha = ga * (0.1 + 0.32 * edge * edge * (0.6 + 0.7 * h3));
      ctx.beginPath();
      ctx.arc(px, py, 0.6 + h3 * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // occasional gravity drip / run (curved, bead at the tip) — more with a fat cap
    if (hash2(hx, hy, 99) < dripP) {
      const len = 8 + hash2(hx, hy, 101) * (sprayR * 2.2);
      const drift = (hash2(hx, hy, 104) - 0.5) * 5;
      ctx.strokeStyle = color;
      ctx.globalAlpha = ga * (0.16 + 0.14 * hash2(hx, hy, 105));
      ctx.lineWidth = 0.9 + hash2(hx, hy, 102) * 1.9;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.quadraticCurveTo(cx + drift * 0.5, cy + len * 0.6, cx + drift, cy + len);
      ctx.stroke();
      ctx.globalAlpha = ga * 0.26;
      ctx.beginPath();
      ctx.arc(cx + drift, cy + len, 1.3 + hash2(hx, hy, 106) * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = ga;
}

// hex "#rrggbb" -> "rgba(r,g,b,a)"
function hexA(hex, a) {
  const h = hex.replace("#", "");
  return `rgba(${parseInt(h.substring(0, 2), 16)},${parseInt(h.substring(2, 4), 16)},${parseInt(h.substring(4, 6), 16)},${a})`;
}

// Small deterministic hash -> [0,1)
function hash2(x, y, i) {
  let n = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(i | 0, 2246822519)) >>> 0;
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return (n >>> 0) / 4294967296;
}

// Resample a polyline into evenly spaced points carrying cumulative distance.
function resample(pts, spacing) {
  if (pts.length === 1) return [{ x: pts[0].x, y: pts[0].y, d: 0 }];
  const out = [{ x: pts[0].x, y: pts[0].y, d: 0 }];
  let acc = 0;
  let px = pts[0].x;
  let py = pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    let cx = pts[i].x;
    let cy = pts[i].y;
    let dx = cx - px;
    let dy = cy - py;
    let seg = Math.hypot(dx, dy);
    if (seg === 0) continue;
    const ux = dx / seg;
    const uy = dy / seg;
    while (seg >= spacing) {
      px += ux * spacing;
      py += uy * spacing;
      acc += spacing;
      out.push({ x: px, y: py, d: acc });
      dx = cx - px;
      dy = cy - py;
      seg = Math.hypot(dx, dy);
    }
    px = cx;
    py = cy;
  }
  acc += Math.hypot(pts[pts.length - 1].x - out[out.length - 1].x, pts[pts.length - 1].y - out[out.length - 1].y);
  out.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, d: acc });
  return out;
}

function easeOut(t) {
  return 1 - (1 - t) * (1 - t);
}

// PAINTED-EXTENT bbox of a committed stroke (world px), padded to cover
// everything the rasterizer actually lays down beyond the raw point extent:
// the spray cloud radius + downward gravity drips, the soft-brush shadow halo,
// and the marker bleed halo. Generous padding so a region clear/redraw on undo
// leaves no ghost halo or drip remnants. Cached on the stroke as _bbox.
function strokeBBox(stroke) {
  const pts = stroke.points;
  if (!pts || !pts.length) return null;
  const t = stroke.tool;
  // shape tools (LINE/RECT/CIRCLE) rasterize from the two endpoints only
  const usePts = (t === TOOL.LINE || t === TOOL.RECT || t === TOOL.CIRCLE)
    ? [pts[0], pts[pts.length - 1]] : pts;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of usePts) {
    if (p.x < minx) minx = p.x;
    if (p.y < miny) miny = p.y;
    if (p.x > maxx) maxx = p.x;
    if (p.y > maxy) maxy = p.y;
  }
  const width = SIZES[stroke.size] || SIZES[0];
  const r0 = width / 2;
  let padL, padT, padR, padB;
  if (t === TOOL.SPRAY) {
    const sprayR = Math.max(6, width * 1.8);   // widest cap cloud (spread 1.8)
    const drip = 8 + sprayR * 2.2;              // gravity runs — downward only
    padL = padR = padT = sprayR + 6;
    padB = sprayR + drip + 8;
  } else if (t === TOOL.ERASER) {
    padL = padR = padT = padB = r0 * 1.3 + 3;
  } else if (t === TOOL.BRUSH) {
    // marker bleed halo (~1.25*r0) + soft-brush shadowBlur (~0.9*r0)
    padL = padR = padT = padB = r0 * 1.25 + r0 * 0.9 + 4;
  } else {
    padL = padR = padT = padB = r0 + 4;        // LINE / RECT / CIRCLE
  }
  return { x: minx - padL, y: miny - padT, w: (maxx - minx) + padL + padR, h: (maxy - miny) + padT + padB };
}

// Axis-aligned bbox overlap test.
function bboxIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// ---------------------------------------------------------------------------
// AEROSOL texture helpers — make fills/edges read as real spray paint instead
// of a flat printed solid with a crisp vector edge. All deterministic (hash2
// keyed on world coords) so a region redraw (undo) reproduces the same grain
// with no flicker. Points accept [x,y] arrays or {x,y}.
// ---------------------------------------------------------------------------
function _px(p) { return p && p[0] !== undefined ? p[0] : p.x; }
function _py(p) { return p && p[1] !== undefined ? p[1] : p.y; }

// Trace a perfect-freehand outline as a closed path (for clipping/filling).
function outlinePath(ctx, outline) {
  if (!outline || outline.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(_px(outline[0]), _py(outline[0]));
  for (let i = 1; i < outline.length; i++) ctx.lineTo(_px(outline[i]), _py(outline[i]));
  ctx.closePath();
}

// Bounding box of an outline -> { minx, miny, maxx, maxy }.
function outlineBBox(outline) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < outline.length; i++) {
    const px = _px(outline[i]), py = _py(outline[i]);
    if (px < minx) minx = px; if (py < miny) miny = py;
    if (px > maxx) maxx = px; if (py > maxy) maxy = py;
  }
  if (!isFinite(minx)) return { minx: 0, miny: 0, maxx: 0, maxy: 0 };
  return { minx, miny, maxx, maxy };
}

// Interior grain + occasional MISSED SPOTS (destination-out pinholes/patches),
// clipped to pathFn, over bbox `bb`. Breaks a flat solid into patchy spray.
function aerosolInterior(ctx, pathFn, bb, amt) {
  if (!pathFn || !bb || amt <= 0) return;
  const w = bb.maxx - bb.minx, h = bb.maxy - bb.miny;
  if (w < 1 || h < 1) return;
  const sx = Math.round(bb.minx), sy = Math.round(bb.miny);
  ctx.save();
  pathFn(ctx); ctx.clip();
  ctx.globalCompositeOperation = "destination-out";
  const n = Math.min(1200, Math.round(w * h * 0.0009 * amt));
  for (let i = 0; i < n; i++) {
    const px = bb.minx + hash2(sx, sy, i * 4 + 1) * w;
    const py = bb.miny + hash2(sx + 1, sy + 3, i * 4 + 2) * h;
    const rx = Math.round(px), ry = Math.round(py);
    const big = hash2(rx, ry, 41) > 0.92;                 // few larger patchy misses
    const r = big ? 2 + hash2(rx, ry, 43) * 3.5 : 0.5 + hash2(rx, ry, 42) * 1.1;
    ctx.globalAlpha = (0.08 + 0.26 * hash2(rx, ry, 44)) * amt;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// Erode a boundary into a ragged, feathered edge (destination-out flecks that
// straddle the outline) so it is never a crisp vector line.
function aerosolEdge(ctx, poly, r, amt) {
  if (!poly || poly.length < 2 || amt <= 0) return;
  const band = Math.max(1.5, r * 0.4);
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  const L = poly.length;
  for (let i = 0; i < L; i++) {
    const px = _px(poly[i]), py = _py(poly[i]);
    const q = poly[(i + 1) % L];
    let tx = _px(q) - px, ty = _py(q) - py; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const hx = Math.round(px), hy = Math.round(py);
    const k = hash2(hx, hy, 51) < 0.5 ? 1 : 2;
    for (let j = 0; j < k; j++) {
      const off = (hash2(hx, hy, j * 2 + 52) - 0.5) * 2 * band;   // in/out of the edge
      const ex = px - ty * off, ey = py + tx * off;
      ctx.globalAlpha = (0.14 + 0.34 * hash2(hx, hy, j * 2 + 53)) * amt;
      ctx.beginPath();
      ctx.arc(ex, ey, 0.6 + hash2(hx, hy, j * 2 + 54) * (r * 0.1 + 1), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// Oversprayed rim: color flecks straddling the edge (additive) so the boundary
// dissolves into scattered paint dust instead of a hard line.
function aerosolOverspray(ctx, poly, color, r, alpha) {
  if (!poly || poly.length < 2 || alpha <= 0) return;
  const reach = Math.max(2, r * 0.75);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = color;
  const L = poly.length;
  for (let i = 0; i < L; i++) {
    const px = _px(poly[i]), py = _py(poly[i]);
    const q = poly[(i + 1) % L];
    let tx = _px(q) - px, ty = _py(q) - py; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const hx = Math.round(px), hy = Math.round(py);
    const k = hash2(hx, hy, 61) < 0.6 ? 1 : 2;
    for (let j = 0; j < k; j++) {
      const off = hash2(hx, hy, j * 3 + 62) * reach;
      const dir = hash2(hx, hy, j * 3 + 63) < 0.5 ? 1 : -1;
      const ex = px - ty * off * dir + (hash2(hx, hy, j * 3 + 65) - 0.5) * 2;
      const ey = py + tx * off * dir + (hash2(hx, hy, j * 3 + 66) - 0.5) * 2;
      const edge = 1 - off / reach;
      ctx.globalAlpha = alpha * (0.1 + 0.5 * edge * hash2(hx, hy, j * 3 + 64));
      ctx.beginPath();
      ctx.arc(ex, ey, 0.5 + hash2(hx, hy, j * 3 + 67) * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
