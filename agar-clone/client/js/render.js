"use strict";

// =============================================================================
// render.js — Client renderer: camera, zoom, and all entity drawing on canvas.
//             Renderizador del cliente: camara, zoom y dibujo de todas las entidades en canvas.
//
// Key concepts / Conceptos clave:
//   - Camera smoothly follows own-cell centroid with classic agar.io zoom scaling / La camara sigue suavemente el centroide de celulas propias con zoom clasico de agar.io
//   - Draws food (organic pellets), cells (flat pastel + rim), viruses (spiky green), ejects / Dibuja comida (pellets organicos), celulas (pastel plano + borde), virus (verde con puas), eyecciones
//   - Renders name/mass labels on cells, eat-pop effects, and HUD (score, ping, fps) / Renderiza etiquetas de nombre/masa en celulas, efectos de comer, y HUD (puntuacion, ping, fps)
//   - Warm pastel palette mapped deterministically from server hue byte / Paleta pastel calida mapeada deterministicamente desde byte de hue del servidor
// =============================================================================

// AGAR-CLONE — client render.js. Camera + classic zoom, faint grid + world border,
// cells (flat circle + darker ring + centered name/mass), food, viruses (green
// spiky), ejected mass, leaderboard + HUD + death overlay (SPEC §1, §14).

const Render = {
  canvas: null,
  ctx: null,
  dpr: 1,
  W: 0, H: 0,            // css pixels

  camX: C.WORLD_SIZE / 2,
  camY: C.WORLD_SIZE / 2,
  scale: 1,
  hasCam: false,

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this._resize();
    window.addEventListener("resize", () => this._resize());
  },

  _resize() {
    this.dpr = window.devicePixelRatio || 1;
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.canvas.style.width = this.W + "px";
    this.canvas.style.height = this.H + "px";
  },

  initCam(x, y) { this.camX = x; this.camY = y; this.hasCam = true; },

  // world -> screen (css px)
  wx(x) { return (x - this.camX) * this.scale + this.W / 2; },
  wy(y) { return (y - this.camY) * this.scale + this.H / 2; },

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.W / 2) / this.scale + this.camX,
      y: (sy - this.H / 2) / this.scale + this.camY,
    };
  },

  // -------------------------------------------------------------------------
  frame() {
    const ctx = this.ctx;

    // --- camera + zoom (SPEC §1.2-§1.3) ---
    const cen = ownCentroid();
    let R;
    if (cen) {
      const tx = cen.x, ty = cen.y;
      if (!this.hasCam) { this.camX = tx; this.camY = ty; this.hasCam = true; }
      this.camX += (tx - this.camX) * C.CAM_SMOOTH;
      this.camY += (ty - this.camY) * C.CAM_SMOOTH;
      R = cen.R;
    } else {
      R = 200; // spectate/dead: modest zoom
    }
    const viewScale = viewScaleOfR(R);
    this.scale = viewScale * (this.H / C.BASE_VIEW_H);

    // --- clear; the agar-gel floor + dish are owned by the Scene module ---
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);

    Scene.drawFloor(this);   // surround + gel + sheen + bubbles + faint grid

    // --- draw order: food, eject, cells (small->big), viruses on top ---
    this._drawFood();
    this._drawEjects();
    this._drawCells();
    this._drawViruses();
    this._drawEatFx();

    Scene.drawWall(this);    // beveled glass dish wall + meniscus (over edge)
    Scene.drawScope(this);   // circular microscope focus vignette + lab light
    Scene.drawScaleBar(this);// scale bar + magnification label

    this._updateHud(cen);
  },

  _drawFood() {
    const ctx = this.ctx;
    const r = radiusOfMass(C.FOOD_MASS) * this.scale;
    for (const [id, f] of World.food) {
      const sx = this.wx(f.x), sy = this.wy(f.y);
      if (sx < -20 || sx > this.W + 20 || sy < -20 || sy > this.H + 20) continue;
      // tiny deterministic size variance so the field feels richer, not stamped
      const vary = 0.82 + (id % 7) / 7 * 0.42;
      const rr = Math.max(2, r * vary);
      // ~35% of nutrients are little rods/ovals rather than perfect beads, so the
      // field reads as scattered organic matter, not decorative polka dots.
      const rod = (id % 20) < 7;
      const big = (id % 7) === 6;            // only the largest ~14% get a glint
      ctx.fillStyle = "rgba(96,66,38,0.10)";
      ctx.beginPath();
      ctx.arc(sx + rr * 0.14, sy + rr * 0.2, rr * 1.02, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = pal(f.hue).food;
      if (rod) {
        const ang = (id % 13) / 13 * Math.PI;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(ang);
        ctx.scale(1, 0.5 + (id % 3) * 0.12);
        ctx.beginPath();
        ctx.arc(0, 0, rr * 1.28, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(sx, sy, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      if (big) {
        ctx.fillStyle = "rgba(255,252,246,0.24)";
        ctx.beginPath();
        ctx.arc(sx - rr * 0.3, sy - rr * 0.32, rr * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  },

  _drawEjects() {
    const ctx = this.ctx;
    const r = radiusOfMass(C.EJECT_MASS) * this.scale;
    for (const e of World.ejects.values()) {
      const ex = e.rx ?? e.x, ey = e.ry ?? e.y;
      const sx = this.wx(ex), sy = this.wy(ey);
      if (sx < -30 || sx > this.W + 30 || sy < -30 || sy > this.H + 30) continue;
      ctx.fillStyle = pal(e.hue).fill;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(2, r), 0, Math.PI * 2);
      ctx.fill();
    }
  },

  _drawCells() {
    const ctx = this.ctx;
    // sort small -> big so bigger cells render on top
    const list = [...World.cells.values()].sort((a, b) => a.size - b.size);
    for (const c of list) {
      const sx = this.wx(c.rx), sy = this.wy(c.ry);
      const rr = c.size * this.scale;
      if (sx + rr < -10 || sx - rr > this.W + 10 || sy + rr < -10 || sy - rr > this.H + 10) continue;

      // flat pastel fill dominant (readability first), sitting IN the gel: a short
      // soft contact shadow, hydrated/translucent body, no lacquered button gloss.
      const col = pal(c.hue);
      const R = Math.max(1, rr);
      ctx.save();
      ctx.shadowColor = "rgba(70,44,24,0.16)";
      ctx.shadowBlur = Math.min(14, R * 0.12);
      ctx.shadowOffsetY = Math.min(4, R * 0.045);
      ctx.fillStyle = col.fill;
      ctx.beginPath();
      ctx.arc(sx, sy, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // faint edge occlusion only (~8%) — gives round translucent form without a
      // bright centre, so the cell reads hydrated, not candy-coated.
      if (rr > 6) {
        const rg = ctx.createRadialGradient(sx, sy, R * 0.62, sx, sy, R);
        rg.addColorStop(0, "rgba(74,48,26,0)");
        rg.addColorStop(1, "rgba(66,42,22,0.08)");
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(sx, sy, R, 0, Math.PI * 2);
        ctx.fill();
      }
      // gentle rim lip (narrow, close to fill value) — the readability separator.
      ctx.lineWidth = Math.max(1.5, rr * 0.05);
      ctx.strokeStyle = col.ring;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(1, R - ctx.lineWidth * 0.5), 0, Math.PI * 2);
      ctx.stroke();
      // single soft crescent catch-light at ~10-11 o'clock (upper-left) — the wet
      // meniscus glint, the cell's only highlight.
      if (rr > 10) {
        ctx.lineWidth = Math.max(1, rr * 0.045);
        ctx.strokeStyle = "rgba(255,255,252,0.4)";
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(1, R - ctx.lineWidth * 1.3), Math.PI * 1.14, Math.PI * 1.44);
        ctx.stroke();
      }
      // own cell: a faint inner ring for a touch more hierarchy (low contrast).
      if (c.isMine) {
        ctx.lineWidth = Math.max(1, rr * 0.03);
        ctx.strokeStyle = "rgba(255,255,255,0.3)";
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(1, R - ctx.lineWidth * 1.8), 0, Math.PI * 2);
        ctx.stroke();
      }

      // name + mass label (only when readable)
      if (rr > 18) {
        const mass = Math.round(massOfRadius(c.size));
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineJoin = "round";
        if (c.name) {
          const fs = Math.max(11, Math.min(rr * 0.42, 46));
          ctx.font = "800 " + fs + "px 'Segoe UI', Arial, sans-serif";
          if ("letterSpacing" in ctx) ctx.letterSpacing = Math.round(fs * 0.02) + "px";
          ctx.lineWidth = Math.max(1.5, fs * 0.13);
          ctx.strokeStyle = "rgba(84,52,28,0.42)"; // soft caramel, not black
          ctx.fillStyle = "#fffdf7";
          ctx.strokeText(c.name, sx, sy - (rr > 34 ? fs * 0.35 : 0));
          ctx.fillText(c.name, sx, sy - (rr > 34 ? fs * 0.35 : 0));
        }
        if (rr > 34) {
          const fs2 = Math.max(10, Math.min(rr * 0.3, 34));
          ctx.font = "700 " + fs2 + "px 'Segoe UI', Arial, sans-serif";
          ctx.lineWidth = Math.max(1.5, fs2 * 0.13);
          ctx.strokeStyle = "rgba(84,52,28,0.38)";
          ctx.fillStyle = "rgba(255,253,247,0.9)";
          ctx.strokeText(String(mass), sx, sy + fs2 * 0.7);
          ctx.fillText(String(mass), sx, sy + fs2 * 0.7);
        }
        if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
      }
    }
  },

  _drawViruses() {
    const ctx = this.ctx;
    const spikes = 24;
    for (const v of World.viruses.values()) {
      const vx = v.rx ?? v.x, vy = v.ry ?? v.y;
      const sx = this.wx(vx), sy = this.wy(vy);
      const rr = v.size * this.scale;
      if (sx + rr < -10 || sx - rr > this.W + 10 || sy + rr < -10 || sy - rr > this.H + 10) continue;
      const outer = rr, inner = rr * 0.88;
      const spikePath = () => {
        ctx.beginPath();
        for (let i = 0; i <= spikes * 2; i++) {
          const ang = (Math.PI * i) / spikes;
          const rad = i % 2 === 0 ? outer : inner;
          const px = sx + Math.cos(ang) * rad;
          const py = sy + Math.sin(ang) * rad;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
      };
      // soft grounding shadow
      ctx.save();
      ctx.shadowColor = "rgba(60,72,34,0.16)";
      ctx.shadowBlur = Math.min(18, rr * 0.12);
      ctx.shadowOffsetY = Math.min(5, rr * 0.04);
      spikePath();
      ctx.fillStyle = "#a9cf72"; // muted yellow-green, sits within the pastel system
      ctx.fill();
      ctx.restore();
      // gentle rim
      spikePath();
      ctx.lineWidth = Math.max(1.5, rr * 0.04);
      ctx.strokeStyle = "#8fb85a";
      ctx.stroke();
      // faint inner ring accent
      ctx.beginPath();
      ctx.arc(sx, sy, inner * 0.62, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.5, rr * 0.04);
      ctx.strokeStyle = "rgba(143,184,90,0.4)";
      ctx.stroke();
    }
  },

  _drawEatFx() {
    const ctx = this.ctx;
    for (const fx of World.eatFx) {
      const t = fx.age / 0.35;
      const sx = this.wx(fx.x), sy = this.wy(fx.y);
      const rr = (fx.r + fx.r * t * 1.4) * this.scale;
      ctx.globalAlpha = (1 - t) * 0.5;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(1, rr), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  },

  _updateHud(cen) {
    // score
    const scoreEl = document.getElementById("scoreVal");
    if (scoreEl) scoreEl.textContent = cen ? String(Math.round(cen.mass)) : "0";
    // ping / fps debug
    const dbg = document.getElementById("debug");
    if (dbg) dbg.textContent = "ping " + Math.round(World.rtt) + "ms  ·  " + Main.fps + " fps";
    // leaderboard
    Main.renderLeaderboard();
  },
};

// ---------------------------------------------------------------------------
// Warm pastel palette (cohesive, flat-vector, NO purple/violet). The server
// sends a random hue byte per entity; we map it deterministically onto a fixed
// curated set so every player keeps a stable, on-brand color.
// ---------------------------------------------------------------------------
const PALETTE = [
  [242, 133, 110], // coral
  [246, 161, 124], // salmon
  [247, 178, 103], // apricot
  [244, 201,  93], // marigold
  [239, 210, 111], // butter
  [198, 217, 107], // warm lime
  [159, 207, 142], // sage
  [121, 199, 166], // seafoam
  [ 95, 191, 179], // teal
  [111, 182, 217], // soft sky
  [242, 146, 160], // rose
  [243, 169, 176], // blush
];

const _CREAM = [246, 239, 227]; // matches the field background
// blend an [r,g,b] toward another by t (0..1)
function _mix(rgb, to, t) {
  return [
    Math.round(rgb[0] + (to[0] - rgb[0]) * t),
    Math.round(rgb[1] + (to[1] - rgb[1]) * t),
    Math.round(rgb[2] + (to[2] - rgb[2]) * t),
  ];
}
function _rgb(a) { return "rgb(" + a[0] + "," + a[1] + "," + a[2] + ")"; }
// darken an [r,g,b] toward a warm shadow for the rim ring
function _dark(rgb, f) { return _rgb([Math.round(rgb[0] * f), Math.round(rgb[1] * f), Math.round(rgb[2] * f)]); }

const _palCache = new Map();
// hue byte 0..255 -> { fill, ring, food } cached.
// Gameplay cells are gently softened toward cream so the strong coral/terracotta
// stays reserved for UI accents; food is muted further so it reads as secondary.
function pal(hue) {
  const key = hue & 0xff;
  let c = _palCache.get(key);
  if (!c) {
    const base = PALETTE[key % PALETTE.length];
    const cell = _mix(base, _CREAM, 0.10);   // soften cells a touch
    // Food = nutrient specks: muted, and nudged toward a warm bio tone so even the
    // cooler hues read as organic matter in the medium rather than candy dots.
    const foodC = _mix(_mix(base, _CREAM, 0.28), [212, 172, 110], 0.15);
    c = {
      fill: _rgb(cell),
      ring: _dark(cell, 0.86),               // gentle lip, not a hard outline
      food: _rgb(foodC),
    };
    _palCache.set(key, c);
  }
  return c;
}
