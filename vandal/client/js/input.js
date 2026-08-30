"use strict";

// =============================================================================
// input.js — Pointer input handling: press-drag painting with interpolated
//            capture, toolbar selection (tool/color/size), zoom & pan controls.
// Manejo de entrada del puntero: pintado por arrastrar-y-presionar con captura
// interpolada, seleccion de barra de herramientas (herramienta/color/tamano),
// controles de zoom y paneo.
//
// Key concepts / Conceptos clave:
//   - Brush/spray stream live (begin/append/end); shapes/eraser commit one-shot / Pincel/spray transmiten en vivo (begin/append/end); figuras/borrador envian de golpe
//   - Sub-frame interpolation fills gaps on fast pointer moves (MAXSTEP) / Interpolacion sub-cuadro llena huecos en movimientos rapidos del puntero (MAXSTEP)
//   - Space/middle-drag for pan, wheel/+- for zoom, arrow keys for pan / Espacio/arrastre-medio para paneo, rueda/+- para zoom, flechas para paneo
//   - Toolbar: tool buttons, colour swatches (spray cans), size & softness / Barra: botones de herramienta, muestras de color (latas de spray), tamano y suavidad
// =============================================================================

// VANDAL — input.js. Point + press-drag to paint, plus the toolbar. Brush and
// spray STREAM live (begin/append/end) with interpolated, gap-free capture even
// on fast pointer moves; shapes and the eraser commit as one-shot strokes.

const MAXSTEP = 6; // max world-px gap between stored points (interpolated fill)

const Input = {
  canvas: null,
  painting: false,
  preview: null, // in-progress stroke {tool,color,size,soft,points}
  cursorWorld: null, // latest hover/paint position (for the cursor uplink)
  _lastWorld: null,
  _pending: [], // sampled points awaiting an APPEND flush
  _streaming: false, // this stroke is a live brush/spray stream

  // current tool selection
  tool: TOOL.BRUSH,
  color: 4, // salmon by default
  size: 1, // medium
  soft: true,

  // view control (user zoom / pan) — never moves on its own
  _space: false,
  _panning: false,
  _panLast: null,

  init(canvas) {
    this.canvas = canvas;
    this.cursorWorld = { x: C.CANVAS_W / 2, y: C.CANVAS_H / 2 };
    this._initPointer(canvas);
    this._initToolbar();
    this._initKeys();
    this._initView(canvas);
    // batched append flush while streaming
    setInterval(() => this._flush(), C.STREAM_FLUSH_MS);
  },

  // ---- user-controlled zoom + pan (wheel, +/- buttons, space/middle drag) ----
  _initView(canvas) {
    canvas.addEventListener("wheel", (e) => {
      if (Main.inMenu) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0016);
      Camera.zoomAt(sx, sy, factor);
    }, { passive: false });

    const btn = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", (e) => { e.preventDefault(); fn(); }); };
    const centerZoom = (f) => Camera.zoomAt(window.innerWidth / 2, window.innerHeight / 2, f);
    btn("zoomIn", () => centerZoom(1.25));
    btn("zoomOut", () => centerZoom(1 / 1.25));
    btn("zoomReset", () => Camera.resetView());
  },

  _panStart(e) {
    this._panning = true;
    this._panLast = { x: e.clientX, y: e.clientY };
    if (this.canvas.setPointerCapture && e.pointerId != null) this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "grabbing";
  },
  _panMove(e) {
    if (!this._panLast) return;
    Camera.panBy(e.clientX - this._panLast.x, e.clientY - this._panLast.y);
    this._panLast = { x: e.clientX, y: e.clientY };
  },
  _panEnd() {
    this._panning = false;
    this._panLast = null;
    this.canvas.style.cursor = this._space ? "grab" : "crosshair";
  },

  _isShape() {
    return this.tool === TOOL.LINE || this.tool === TOOL.RECT || this.tool === TOOL.CIRCLE;
  },
  _isStreamTool() {
    return this.tool === TOOL.BRUSH || this.tool === TOOL.SPRAY;
  },

  // ---- pointer painting ---------------------------------------------------
  _initPointer(canvas) {
    const down = (e) => {
      if (Main.inMenu) return;
      e.preventDefault();
      // pan mode: middle-mouse or hold-space + drag (never paints)
      if (e.button === 1 || this._space) { this._panStart(e); return; }
      const w = this._eventWorld(e);
      this.cursorWorld = w;
      this.painting = true;
      this._lastWorld = w;
      this._pending = [];
      this._streaming = this._isStreamTool();
      const flags = this.soft ? 1 : 0;
      this.preview = { tool: this.tool, color: this.color, size: this.size, soft: this.soft, points: [w] };
      if (this._streaming) {
        Net.sendStrokeBegin(this.tool, this.color, this.size, flags, Math.round(w.x), Math.round(w.y));
      }
      canvas.setPointerCapture && e.pointerId != null && canvas.setPointerCapture(e.pointerId);
    };

    const move = (e) => {
      if (this._panning) { this._panMove(e); return; }
      const w0 = this._eventWorld(e);
      this.cursorWorld = w0;
      if (!this.painting || !this.preview) return;
      e.preventDefault();

      if (this._isShape()) {
        const pts = this.preview.points;
        if (pts.length < 2) pts.push(w0);
        else pts[1] = w0;
        return;
      }

      // brush / spray / eraser: reliably capture every sub-frame sample and
      // interpolate so the path is smooth + unbroken on fast movement.
      const samples = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (samples && samples.length) {
        for (const s of samples) this._extendTo(this._eventWorld(s));
      } else {
        this._extendTo(w0);
      }
    };

    const up = (e) => {
      if (this._panning) { this._panEnd(); return; }
      if (!this.painting) return;
      this.painting = false;
      const s = this.preview;
      if (!s) return;

      if (this._isShape()) {
        if (s.points.length >= 2) {
          const a = s.points[0];
          const b = s.points[s.points.length - 1];
          Net.sendStroke(this.tool, this.color, this.size, this.soft ? 1 : 0, [
            { x: Math.round(a.x), y: Math.round(a.y) },
            { x: Math.round(b.x), y: Math.round(b.y) },
          ]);
        } else {
          this.preview = null; // a click, not a drag — nothing to commit
        }
      } else if (this._streaming) {
        this._flush();
        Net.sendStrokeEnd();
      } else {
        // eraser (one-shot)
        let pts = s.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
        if (pts.length === 1) pts.push({ x: pts[0].x + 1, y: pts[0].y });
        Net.sendStroke(this.tool, this.color, this.size, 0, pts);
      }
      this._streaming = false;
    };

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    canvas.addEventListener("pointerleave", (e) => { if (this.painting) up(e); });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  },

  // Interpolate from the last stored point to `w`, filling gaps <= MAXSTEP.
  _extendTo(w) {
    if (!this.preview) return;
    const last = this._lastWorld;
    const dx = w.x - last.x;
    const dy = w.y - last.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.75) return;
    const steps = Math.max(1, Math.ceil(dist / MAXSTEP));
    for (let i = 1; i <= steps; i++) {
      const p = { x: last.x + (dx * i) / steps, y: last.y + (dy * i) / steps };
      this.preview.points.push(p);
      if (this._streaming) this._pending.push(p);
    }
    this._lastWorld = w;
  },

  _flush() {
    if (!this.painting || !this._streaming || this._pending.length === 0) return;
    const pts = this._pending.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    this._pending = [];
    Net.sendStrokeAppend(pts);
  },

  // Server confirmed one of my strokes (commit). Clear the preview once I'm no
  // longer actively painting (so long auto-split strokes don't flicker).
  onCommit() {
    if (!this.painting) this.preview = null;
  },

  _eventWorld(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const w = Camera.screenToWorld(sx, sy);
    // clamp painting to the server-announced wall bounds (never outside)
    w.x = clampNum(w.x, 0, World.canvasW || C.CANVAS_W);
    w.y = clampNum(w.y, 0, World.canvasH || C.CANVAS_H);
    return w;
  },

  // ---- toolbar ------------------------------------------------------------
  _initToolbar() {
    document.querySelectorAll("[data-tool]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.tool = parseInt(btn.getAttribute("data-tool"), 10);
        this._syncActive("[data-tool]", "data-tool", this.tool);
      });
    });
    document.querySelectorAll("[data-soft]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.soft = btn.getAttribute("data-soft") === "1";
        this._syncActive("[data-soft]", "data-soft", this.soft ? "1" : "0");
      });
    });
    document.querySelectorAll("[data-size]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.size = parseInt(btn.getAttribute("data-size"), 10);
        this._syncActive("[data-size]", "data-size", this.size);
      });
    });
    const sw = document.getElementById("swatches");
    if (sw) {
      PALETTE.forEach((hex, i) => {
        const meta = (typeof PALETTE_META !== "undefined" && PALETTE_META[i]) || { name: "Colour " + i, brand: "" };
        const b = document.createElement("button");
        b.className = "can" + (i === this.color ? " active" : "");
        b.setAttribute("data-color", i);
        b.title = meta.name + (meta.brand ? " · " + meta.brand : "");
        b.innerHTML = canSVG(hex, i === 13) + '<span class="can-name">' + escapeHtml(meta.name) + "</span>";
        b.addEventListener("click", () => {
          this.color = i;
          sw.querySelectorAll(".can").forEach((el) => el.classList.remove("active"));
          b.classList.add("active");
        });
        sw.appendChild(b);
      });
    }
    const undoBtn = document.getElementById("undoBtn");
    if (undoBtn) undoBtn.addEventListener("click", () => Net.sendUndo());

    this._syncActive("[data-tool]", "data-tool", this.tool);
    this._syncActive("[data-soft]", "data-soft", this.soft ? "1" : "0");
    this._syncActive("[data-size]", "data-size", this.size);
  },

  _syncActive(sel, attr, val) {
    document.querySelectorAll(sel).forEach((el) => {
      el.classList.toggle("active", el.getAttribute(attr) === String(val));
    });
  },

  _initKeys() {
    window.addEventListener("keydown", (e) => {
      if (Main.inMenu) return;
      if (e.code === "Space") {
        e.preventDefault();
        this._space = true;
        if (!this._panning) this.canvas.style.cursor = "grab";
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        Net.sendUndo();
        return;
      }
      // zoom hotkeys
      if (e.key === "+" || e.key === "=") { Camera.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.25); return; }
      if (e.key === "-" || e.key === "_") { Camera.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.25); return; }
      if (e.key === "0") { Camera.resetView(); return; }
      // pan with arrow keys — reach every edge/corner of the wall (clamped)
      const PAN = 110;
      if (e.key === "ArrowLeft") { e.preventDefault(); Camera.panBy(PAN, 0); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); Camera.panBy(-PAN, 0); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); Camera.panBy(0, PAN); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); Camera.panBy(0, -PAN); return; }
      const map = { b: TOOL.BRUSH, l: TOOL.LINE, r: TOOL.RECT, c: TOOL.CIRCLE, e: TOOL.ERASER, s: TOOL.SPRAY };
      const k = e.key.toLowerCase();
      if (k in map) {
        this.tool = map[k];
        this._syncActive("[data-tool]", "data-tool", this.tool);
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") {
        this._space = false;
        if (!this._panning) this.canvas.style.cursor = "crosshair";
      }
    });
  },
};

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// A clean flat-vector spray CAN whose cap + body band carry the paint colour.
// Generic silhouette (no trademarked logo art); the real colour NAME sits below.
function canSVG(hex, dark) {
  const bodyFill = dark ? "#3a352e" : "#f3ead7";
  const stroke = "#4a3f31";
  return (
    '<svg viewBox="0 0 30 44" width="26" height="38" aria-hidden="true">' +
    // cap
    '<rect x="10" y="1.5" width="10" height="6" rx="1.6" fill="' + hex + '" stroke="' + stroke + '" stroke-width="1"/>' +
    // nozzle
    '<rect x="13.5" y="0" width="3" height="2" rx="0.6" fill="' + stroke + '"/>' +
    // can body
    '<rect x="7" y="8.5" width="16" height="33" rx="3" fill="' + bodyFill + '" stroke="' + stroke + '" stroke-width="1.2"/>' +
    // colour label band = the paint colour
    '<rect x="7" y="19" width="16" height="12" fill="' + hex + '"/>' +
    '<line x1="7" y1="19" x2="23" y2="19" stroke="' + stroke + '" stroke-width="0.9"/>' +
    '<line x1="7" y1="31" x2="23" y2="31" stroke="' + stroke + '" stroke-width="0.9"/>' +
    "</svg>"
  );
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
