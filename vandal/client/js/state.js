"use strict";

// =============================================================================
// state.js — Global World state and Camera transform. The camera is user-driven
//            only (pan/zoom); it never animates on its own. Loaded first.
// Estado global World y transformacion de Camara. La camara es controlada solo
// por el usuario (paneo/zoom); nunca se anima sola. Se carga primero.
//
// Key concepts / Conceptos clave:
//   - World: holds selfId, server-announced wall size, RTT, connection state / World: contiene selfId, tamano del muro anunciado por el servidor, RTT, estado de conexion
//   - Camera: base COVER-FIT scale + user zoom/pan on top / Camera: escala base COVER-FIT + zoom/paneo del usuario encima
//   - screenToWorld / worldToScreen mapping stays exact at any zoom / Mapeo screenToWorld / worldToScreen exacto a cualquier nivel de zoom
//   - Pan is clamped so the user can reach every wall edge but never scroll past / El paneo se limita para alcanzar cada borde del muro sin salirse
// =============================================================================

// VANDAL — state.js. Global World state + the Camera. The camera is driven
// SOLELY by user pan/zoom (wheel, +/- buttons, space- or middle-drag, reset);
// it never zooms, pans, or animates on its own (no idle/gallery auto-move). The
// base fit COVER-FILLS the viewport so the wall reads frontal and proportional.
// It recomputes on resize and on user input. Loaded before net/input/render.

const World = {
  selfId: 0,
  canvasW: C.CANVAS_W,
  canvasH: C.CANVAS_H,
  painters: 1,
  rtt: 0,
  connected: false,

  reset() {
    this.painters = 1;
    this.rtt = 0;
  },
};

// ---------------------------------------------------------------------------
// Camera: a fixed fit of the whole wall, PLUS an explicit user zoom + pan the
// player controls (wheel / +− buttons / space- or middle-drag). It still NEVER
// moves on its own — the base fit is stable and only user input changes `zoom`
// and `pan`. The world<->screen mapping stays exact at any zoom so painted
// strokes always land under the cursor.
// ---------------------------------------------------------------------------
const Camera = {
  vw: 1,
  vh: 1,
  scale: 1,
  ox: 0,
  oy: 0,

  // user-controlled view on top of the fixed fit
  zoom: 1,
  panX: 0,
  panY: 0,
  minZoom: 0.6,
  maxZoom: 7,

  setViewport(vw, vh) {
    this.vw = vw;
    this.vh = vh;
  },

  wallW() { return World.canvasW || C.CANVAS_W; },
  wallH() { return World.canvasH || C.CANVAS_H; },

  // Base (unzoomed) fit scale — COVER-FILLS the viewport with the announced wall
  // (server sets the size in the welcome packet). Using max() (not min()) means
  // the wall always fills the screen frontally at zoom>=1 with no letterbox; the
  // longer axis is cropped and reachable by pan.
  baseScale() {
    return Math.max(this.vw / this.wallW(), this.vh / this.wallH());
  },

  update() {
    const s0 = this.baseScale();
    this.scale = s0 * this.zoom;
    this._clampPan();
    this.ox = (this.vw - this.wallW() * this.scale) / 2 + this.panX;
    this.oy = (this.vh - this.wallH() * this.scale) * 0.5 + this.panY;
  },

  // Clamp pan so the user can reach EVERY edge/corner of the wall (a small pad
  // lets the bounded rectangle's border show) but never scroll off into empty
  // space past the wall. Bounds come from the server-announced wall size.
  _clampPan() {
    const s = this.scale, W = this.wallW(), H = this.wallH(), pad = 60;
    const baseOx = (this.vw - W * s) / 2;
    const baseOy = (this.vh - H * s) * 0.5;
    if (W * s > this.vw) {
      const hi = -baseOx + pad;                       // reach the LEFT edge
      const lo = (this.vw - W * s) - baseOx - pad;    // reach the RIGHT edge
      this.panX = clampN(this.panX, lo, hi);
    } else this.panX = 0;                             // fits -> keep centred
    if (H * s > this.vh) {
      const hi = -baseOy + pad;                       // reach the TOP edge
      const lo = (this.vh - H * s) - baseOy - pad;    // reach the BOTTOM edge
      this.panY = clampN(this.panY, lo, hi);
    } else this.panY = 0;
  },

  // Zoom toward a screen anchor point, keeping the world point under it fixed.
  zoomAt(sx, sy, factor) {
    const prev = this.zoom;
    const next = clampN(prev * factor, this.minZoom, this.maxZoom);
    if (next === prev) return;
    const wx = (sx - this.ox) / this.scale;
    const wy = (sy - this.oy) / this.scale;
    const s0 = this.baseScale();
    const newScale = s0 * next;
    this.panX = sx - wx * newScale - (this.vw - this.wallW() * newScale) / 2;
    this.panY = sy - wy * newScale - (this.vh - this.wallH() * newScale) * 0.5;
    this.zoom = next;
  },

  panBy(dx, dy) {
    this.panX += dx;
    this.panY += dy;
  },

  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  },

  screenToWorld(sx, sy) {
    return { x: (sx - this.ox) / this.scale, y: (sy - this.oy) / this.scale };
  },
  worldToScreen(wx, wy) {
    return { x: wx * this.scale + this.ox, y: wy * this.scale + this.oy };
  },
};

function clampN(v, lo, hi) {
  if (lo > hi) { const m = (lo + hi) / 2; return m; }
  return v < lo ? lo : v > hi ? hi : v;
}
