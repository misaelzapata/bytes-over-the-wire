"use strict";
// AGAR-CLONE — client scene.js. Purely-visual "agar petri dish under a microscope"
// environment (SPEC atmosphere layer). Clean vector only — no photos/sprites.
// Draws: warm agar gel floor (uneven sheen, tiny bubbles/specks, faint
// hemocytometer grid), the beveled round-glass DISH WALL at the world border with
// meniscus glow, a screen-space circular microscope focus vignette + top-left lab
// light, and a tiny scale-bar + magnification label. Gameplay entities are drawn
// by render.js on top of the gel; this module never touches gameplay/state.
//
// Coordinate helpers come from the Render object passed in as `R`
// (R.wx/R.wy world->screen, R.scale px-per-world-unit, R.W/R.H css size,
// R.camX/R.camY). World bounds from World.worldW/World.worldH.

const Scene = {
  // Dish geometry: the square world border is rendered as a soft-cornered glass
  // dish wall. A large corner radius makes the wall read as gently curved glass
  // (locally near-straight, like the arc of a big plate seen up close), while the
  // screen-space circular focus vignette supplies the "looking through the
  // eyepiece" roundness. Wall sits exactly where cells stop → gameplay-honest.
  CORNER: 1200,            // world units
  WORLD_PER_UM: 2.2,       // world units per micrometre (for the scale bar)

  _ready: false,
  _bubbles: null,          // [{x,y,r,a,kind}]
  _sheen: null,            // [{x,y,r,a}]
  _mottle: null,           // [{x,y,r,a,light}]  finer poured-gel unevenness
  _streaks: null,          // [{x,y,r,rot,squash,a}] faint gel flow streaks
  _wallSpots: null,        // [{edge,frac,r,a,light}] tiny glass/meniscus imperfections

  _init() {
    const rnd = _mulberry32(0x51ce7a11);
    const W = World.worldW, H = World.worldH;
    // uneven gel sheen: a few big, extremely faint warm-light blobs.
    const sheen = [];
    for (let i = 0; i < 8; i++) {
      sheen.push({
        x: rnd() * W, y: rnd() * H,
        r: 1600 + rnd() * 3200,
        a: 0.05 + rnd() * 0.06,
      });
    }
    // finer mottling — broad, barely-there value blotches (both lighter & darker)
    // so the poured agar reads uneven rather than printed.
    const mottle = [];
    for (let i = 0; i < 46; i++) {
      mottle.push({
        x: rnd() * W, y: rnd() * H,
        r: 220 + rnd() * 300,
        a: 0.028 + rnd() * 0.03,
        light: rnd() < 0.5,
      });
    }
    // a few faint elongated flow streaks (poured-gel setting lines).
    const streaks = [];
    for (let i = 0; i < 6; i++) {
      streaks.push({
        x: rnd() * W, y: rnd() * H,
        r: 500 + rnd() * 700,
        rot: rnd() * Math.PI,
        squash: 0.1 + rnd() * 0.12,
        a: 0.02 + rnd() * 0.022,
      });
    }
    // tiny bubbles + specks scattered through the medium.
    const bubbles = [];
    for (let i = 0; i < 300; i++) {
      const kind = rnd() < 0.62 ? "bubble" : "speck";
      bubbles.push({
        x: rnd() * W, y: rnd() * H,
        r: kind === "bubble" ? (7 + rnd() * 22) : (3 + rnd() * 7),
        a: kind === "bubble" ? (0.05 + rnd() * 0.09) : (0.05 + rnd() * 0.07),
        kind,
      });
    }
    // faint meniscus/glass imperfections along the straight wall runs, so the rim
    // isn't machine-perfect (microscopic thickness variation).
    const edges = ["top", "right", "bottom", "left"];
    const wallSpots = [];
    for (let i = 0; i < 30; i++) {
      wallSpots.push({
        edge: edges[i % 4],
        frac: rnd(),
        r: 26 + rnd() * 46,
        a: 0.05 + rnd() * 0.07,
        light: rnd() < 0.5,
      });
    }

    this._sheen = sheen;
    this._mottle = mottle;
    this._streaks = streaks;
    this._bubbles = bubbles;
    this._wallSpots = wallSpots;
    this._ready = true;
  },

  // Rounded-rect path of the world border in screen coords.
  _dishPath(R) {
    const x = R.wx(0), y = R.wy(0);
    const w = World.worldW * R.scale, h = World.worldH * R.scale;
    const r = Math.min(this.CORNER * R.scale, w / 2, h / 2);
    _rrect(R.ctx, x, y, w, h, r);
    return { x, y, w, h, r };
  },

  // -----------------------------------------------------------------------
  // GEL FLOOR: surround (beyond dish) + agar gel gradient, sheen, bubbles,
  // faint hemocytometer grid. Clipped to the dish interior.
  // -----------------------------------------------------------------------
  drawFloor(R) {
    if (!this._ready) this._init();
    const ctx = R.ctx;

    // Out-of-focus surround beyond the glass — darker & desaturated vs the
    // interior gel, so it reads as the table/shoulder outside the plate.
    ctx.fillStyle = "#b7a17c";
    ctx.fillRect(0, 0, R.W, R.H);

    ctx.save();
    this._dishPath(R);
    ctx.clip();

    // Agar gel base — warm translucent cream, lab light from the TOP-LEFT
    // (screen-space so lighting is stable while the field scrolls).
    const g = ctx.createLinearGradient(0, 0, R.W, R.H);
    g.addColorStop(0.00, "#f7efe1");
    g.addColorStop(0.45, "#f2e7d4");
    g.addColorStop(1.00, "#e9dcc3");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, R.W, R.H);

    // Uneven sheen — big faint warm-light pools that scroll with the medium.
    for (const s of this._sheen) {
      const sx = R.wx(s.x), sy = R.wy(s.y), sr = s.r * R.scale;
      if (sx + sr < 0 || sx - sr > R.W || sy + sr < 0 || sy - sr > R.H) continue;
      const rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
      rg.addColorStop(0, "rgba(255,252,244," + s.a.toFixed(3) + ")");
      rg.addColorStop(1, "rgba(255,252,244,0)");
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();
    }

    // Finer poured-gel mottling — subtle lighter & darker value blotches.
    for (const m of this._mottle) {
      const sx = R.wx(m.x), sy = R.wy(m.y), sr = m.r * R.scale;
      if (sx + sr < 0 || sx - sr > R.W || sy + sr < 0 || sy - sr > R.H) continue;
      const c = m.light ? "255,251,242" : "150,120,80";
      const rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
      rg.addColorStop(0, "rgba(" + c + "," + m.a.toFixed(3) + ")");
      rg.addColorStop(1, "rgba(" + c + ",0)");
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();
    }

    // Faint elongated flow streaks (gel setting lines).
    for (const s of this._streaks) {
      const sx = R.wx(s.x), sy = R.wy(s.y), sr = s.r * R.scale;
      if (sx + sr < 0 || sx - sr > R.W || sy + sr < 0 || sy - sr > R.H) continue;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(s.rot);
      ctx.scale(1, s.squash);
      const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, sr);
      rg.addColorStop(0, "rgba(255,251,242," + s.a.toFixed(3) + ")");
      rg.addColorStop(1, "rgba(255,251,242,0)");
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(0, 0, sr, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    this._drawGrid(R);
    this._drawBubbles(R);

    ctx.restore();
  },

  // Very-faint warm hemocytometer-style grid (minor + every-5th major).
  _drawGrid(R) {
    const ctx = R.ctx;
    const step = C.GRID_STEP;
    const left = R.camX - (R.W / 2) / R.scale;
    const right = R.camX + (R.W / 2) / R.scale;
    const top = R.camY - (R.H / 2) / R.scale;
    const bottom = R.camY + (R.H / 2) / R.scale;
    if ((right - left) / step > 2000) return; // don't draw a haze when far out

    const gy0 = R.wy(Math.max(0, top)), gy1 = R.wy(Math.min(World.worldH, bottom));
    const gx0 = R.wx(Math.max(0, left)), gx1 = R.wx(Math.min(World.worldW, right));
    const x0 = Math.floor(Math.max(0, left) / step) * step;
    const x1 = Math.min(World.worldW, right);
    const y0 = Math.floor(Math.max(0, top) / step) * step;
    const y1 = Math.min(World.worldH, bottom);
    const MAJOR = step * 5;

    for (const pass of [0, 1]) {
      ctx.strokeStyle = pass === 0 ? "rgba(150,116,74,0.030)" : "rgba(150,112,68,0.055)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x <= x1; x += step) {
        const isMajor = Math.round(x) % MAJOR === 0;
        if ((pass === 1) !== isMajor) continue;
        const sx = R.wx(x);
        ctx.moveTo(sx, gy0); ctx.lineTo(sx, gy1);
      }
      for (let y = y0; y <= y1; y += step) {
        const isMajor = Math.round(y) % MAJOR === 0;
        if ((pass === 1) !== isMajor) continue;
        const sy = R.wy(y);
        ctx.moveTo(gx0, sy); ctx.lineTo(gx1, sy);
      }
      ctx.stroke();
    }
  },

  _drawBubbles(R) {
    const ctx = R.ctx;
    for (const b of this._bubbles) {
      const sx = R.wx(b.x), sy = R.wy(b.y), sr = b.r * R.scale;
      if (sr < 0.6) continue;
      if (sx + sr < 0 || sx - sr > R.W || sy + sr < 0 || sy - sr > R.H) continue;
      if (b.kind === "speck") {
        // debris / nutrient speck: tiny soft warm dot
        ctx.fillStyle = "rgba(150,120,80," + (b.a + 0.03).toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(0.8, sr), 0, Math.PI * 2);
        ctx.fill();
      } else {
        // air bubble: faint rim + darker shade + small top-left highlight
        ctx.lineWidth = Math.max(1, sr * 0.14);
        ctx.strokeStyle = "rgba(120,92,58," + (b.a * 0.9).toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,252,245," + (b.a * 1.4).toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(sx - sr * 0.32, sy - sr * 0.32, Math.max(0.8, sr * 0.28), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  },

  // -----------------------------------------------------------------------
  // DISH WALL: beveled round-glass rim at the world border, drawn on top of
  // the gel/entities near the edge. Meniscus glow just inside the glass.
  // -----------------------------------------------------------------------
  drawWall(R) {
    const ctx = R.ctx;
    const b = this._dishPath(R);           // {x,y,w,h,r} border rect (screen px)
    // Concentric ring at inset `d` (px, +inward). Positive d shrinks the rect.
    const ring = (d) => _rrect(ctx, b.x + d, b.y + d, b.w - 2 * d, b.h - 2 * d,
      Math.max(0, b.r - d));

    // (1) REFRACTION: a soft blurred lens band hugging the interior edge — fakes
    // the gel/particles bending + blurring as they pass under the glass rim.
    ctx.save();
    ring(0); ctx.clip();                   // never spill outside the dish
    ctx.lineWidth = 16;
    ctx.strokeStyle = "rgba(236,224,203,0.14)";
    ctx.shadowColor = "rgba(236,224,203,0.5)";
    ctx.shadowBlur = 7;
    ring(13); ctx.stroke();
    ctx.shadowBlur = 0;

    // (2) inner occlusion line — the gel dips into shadow just under the glass.
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(184,148,104,0.28)";
    ring(8.5); ctx.stroke();

    // (3) hot inner highlight — the crisp wet catch-light on the glass lip
    //     (kept optical, not graphic: modest opacity).
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,247,234,0.66)";
    ring(5.5); ctx.stroke();

    // (4) meniscus band (glass thickness) — warm gradient across ~6px, faked by
    //     an inner (lighter) + outer (deeper) concentric stroke.
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(231,213,186,0.9)";   // #E7D5BA (interior, lit)
    ring(2.5); ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(205,174,132,0.9)";   // #CDAE84 (toward the wall)
    ring(0.2); ctx.stroke();

    // (4b) micro-imperfections — faint soft dabs on the straight runs break the
    //      machine-perfect line so the rim feels physically real.
    this._drawWallSpots(R);
    ctx.restore();

    // (5) outer glass thickness — a soft shadow band just OUTSIDE the boundary,
    //     lit top-left -> shadow bottom-right, then a faint far-edge ring.
    const lit = ctx.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h);
    lit.addColorStop(0.00, "rgba(255,250,240,0.55)");
    lit.addColorStop(0.5, "rgba(170,128,86,0.30)");
    lit.addColorStop(1.00, "rgba(126,90,58,0.55)");
    ctx.lineWidth = 4;
    ctx.strokeStyle = lit;
    ring(-3); ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(120,86,54,0.24)";
    ring(-8); ctx.stroke();
  },

  // Faint soft dabs sitting on the meniscus along the straight wall runs.
  // (Called while the ctx is clipped to the dish interior.)
  _drawWallSpots(R) {
    const ctx = R.ctx;
    const W = World.worldW, H = World.worldH;
    for (const s of this._wallSpots) {
      let wxw, wyw, ix = 0, iy = 0; // inward nudge direction
      if (s.edge === "top") { wxw = s.frac * W; wyw = 0; iy = 1; }
      else if (s.edge === "bottom") { wxw = s.frac * W; wyw = H; iy = -1; }
      else if (s.edge === "left") { wxw = 0; wyw = s.frac * H; ix = 1; }
      else { wxw = W; wyw = s.frac * H; ix = -1; }
      const sr = s.r * R.scale;
      if (sr < 1) continue;
      const sx = R.wx(wxw) + ix * sr * 0.5, sy = R.wy(wyw) + iy * sr * 0.5;
      if (sx + sr < 0 || sx - sr > R.W || sy + sr < 0 || sy - sr > R.H) continue;
      const c = s.light ? "255,249,236" : "150,116,74";
      const rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
      rg.addColorStop(0, "rgba(" + c + "," + s.a.toFixed(3) + ")");
      rg.addColorStop(1, "rgba(" + c + ",0)");
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  // -----------------------------------------------------------------------
  // MICROSCOPE FRAMING (screen-space): circular focus vignette + lab light.
  // -----------------------------------------------------------------------
  drawScope(R) {
    const ctx = R.ctx;
    const cx = R.W / 2, cy = R.H / 2;
    const rMax = Math.hypot(cx, cy);
    const rMin = Math.min(R.W, R.H) * 0.5;

    // Circular eyepiece field: crisp clear centre, soft warm-dark falloff so the
    // corners read as the edge of the microscope's field of view. Kept gentle so
    // central gameplay stays perfectly readable.
    const v = ctx.createRadialGradient(cx, cy, rMin * 0.6, cx, cy, rMax * 1.02);
    v.addColorStop(0.00, "rgba(40,27,15,0)");
    v.addColorStop(0.58, "rgba(40,27,15,0.05)");
    v.addColorStop(0.85, "rgba(37,24,13,0.24)");
    v.addColorStop(1.00, "rgba(28,18,9,0.48)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, R.W, R.H);

    // Top-left lab light bloom — a soft warm highlight reinforcing the light dir.
    const bx = R.W * 0.24, by = R.H * 0.16;
    const bloom = ctx.createRadialGradient(bx, by, 0, bx, by, Math.max(R.W, R.H) * 0.55);
    bloom.addColorStop(0, "rgba(255,250,238,0.16)");
    bloom.addColorStop(1, "rgba(255,250,238,0)");
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, R.W, R.H);
  },

  // -----------------------------------------------------------------------
  // SCALE BAR + magnification (screen-space, top-left). Adapts to zoom like a
  // real micrograph scale bar: bar length tracks a round micrometre value.
  // -----------------------------------------------------------------------
  drawScaleBar(R) {
    const ctx = R.ctx;
    const pxPerUm = this.WORLD_PER_UM * R.scale;
    const cands = [10, 20, 50, 100, 200, 500, 1000];
    let um = cands[0], px = um * pxPerUm;
    for (const c of cands) {
      const p = c * pxPerUm;
      if (p >= 66 && p <= 150) { um = c; px = p; break; }
      if (p < 66) { um = c; px = p; }        // keep smallest-too-short as fallback
    }
    const mag = Math.max(4, Math.round(R.scale * 48));

    const ox = 24, oy = 24;          // top-left origin
    const barY = oy + 14;            // stacked layout: mag / bar / µm (no overlap)
    ctx.save();
    ctx.textBaseline = "alphabetic";
    // magnification tag (above the bar, left-aligned)
    ctx.textAlign = "left";
    ctx.font = "700 12px 'Segoe UI', Arial, sans-serif";
    ctx.fillStyle = "rgba(74,50,30,0.58)";
    ctx.fillText(mag + "×", ox, oy);

    // bar with end ticks (soft warm, faint white underlay for contrast)
    ctx.lineCap = "butt";
    ctx.strokeStyle = "rgba(255,251,244,0.5)";
    ctx.lineWidth = 4;
    _tick(ctx, ox, barY, px);
    ctx.strokeStyle = "rgba(74,50,30,0.5)";
    ctx.lineWidth = 2;
    _tick(ctx, ox, barY, px);

    // distance label (below the bar, centered on it)
    ctx.textAlign = "center";
    ctx.font = "600 11px 'Segoe UI', Arial, sans-serif";
    ctx.fillStyle = "rgba(74,50,30,0.58)";
    ctx.fillText(um + " µm", ox + px / 2, barY + 15);
    ctx.restore();
  },
};

// ---- helpers ----
function _tick(ctx, x, y, len) {
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + len, y);
  ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4);
  ctx.moveTo(x + len, y - 4); ctx.lineTo(x + len, y + 4);
  ctx.stroke();
}

function _rrect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function _mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
