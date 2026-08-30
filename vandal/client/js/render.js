"use strict";

// =============================================================================
// render.js — Per-frame rendering pipeline: wall surface, shared paint layer,
//             live in-progress strokes, local preview, cursors & wall overlay.
// Pipeline de renderizado por cuadro: superficie del muro, capa de pintura
// compartida, trazos en progreso en vivo, previsualizacion local, cursores y overlay.
//
// Key concepts / Conceptos clave:
//   - DPR-aware canvas sizing for crisp rendering on high-density displays / Tamano de canvas consciente de DPR para nitidez en pantallas de alta densidad
//   - Camera transform maps world coordinates to screen space / La transformacion de camara mapea coordenadas mundo a espacio de pantalla
//   - Paint layer drawn slightly translucent so wall grain shows through / Capa de pintura ligeramente translucida para que se vea la textura del muro
//   - Composites wall -> paint -> live strokes -> grain -> overlay -> cursors / Compone muro -> pintura -> trazos vivos -> grano -> overlay -> cursores
// =============================================================================

// VANDAL — render.js. Each frame: draw the scene (environment behind the wall),
// the wall surface, the shared paint layer (absorbed into the wall), every live
// in-progress stroke, the local preview, remote painter cursors, and a gentle
// vignette during a gallery fly-through.

const Render = {
  canvas: null,
  ctx: null,
  dpr: 1,

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this._resize();
    window.addEventListener("resize", () => this._resize());
  },

  _resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
  },

  frame(now) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    Camera.setViewport(vw, vh);
    Camera.update(now);
    Cursors.update(now);

    // --- unconditional flat clear (screen space) ---
    // MANDATORY: the wall cover-fills only at zoom>=1; below the base fit (and at
    // the cropped margins) the wall does not reach every pixel, so without a full
    // clear each frame the previous frame smears. A flat neutral fill also kills
    // the old faux-3D scene, keeping the view frontal.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#14110e";
    ctx.fillRect(0, 0, vw, vh);

    // --- wall + paint (camera space) ---
    ctx.setTransform(Camera.scale * dpr, 0, 0, Camera.scale * dpr, Camera.ox * dpr, Camera.oy * dpr);
    ctx.imageSmoothingEnabled = true;
    Scene.drawWall(ctx);

    // paint layer — slightly translucent so the wall grain shows through and
    // the strokes read as absorbed into the surface (still clearly visible).
    ctx.globalAlpha = 0.95;
    ctx.drawImage(Mural.offscreen, 0, 0);
    ctx.globalAlpha = 1;

    // live in-progress strokes from other painters
    for (const s of Mural.live.values()) {
      if (s.points && s.points.length) drawStroke(ctx, s, { preview: true });
    }
    // my own in-progress preview
    if (Input.preview && Input.preview.points.length) {
      drawStroke(ctx, Input.preview, { preview: true });
    }

    // mortar-joint grain multiplied over the paint -> strokes sink into the wall
    Scene.drawGrain(ctx);

    // top-lit sheen + warm frame over the finished surface
    Scene.drawWallOverlay(ctx);

    // --- painter cursors (screen space) ---
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    Cursors.draw(ctx, now);
  },
};
