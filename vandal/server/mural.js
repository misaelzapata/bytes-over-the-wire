"use strict";

// =============================================================================
// mural.js — Authoritative server-side mural state: stroke history, live
//            open strokes, commit/undo logic. Pixel-agnostic (no rasterization).
// Estado autoritativo del mural en el servidor: historial de trazos, trazos
// abiertos en vivo, logica de commit/undo. Agnostico a pixeles (sin rasterizacion).
//
// Key concepts / Conceptos clave:
//   - Ordered list of committed strokes (the full mural for new joiners) / Lista ordenada de trazos confirmados (el mural completo para nuevos usuarios)
//   - Map of open (in-progress) strokes, one per owner / Mapa de trazos abiertos (en progreso), uno por propietario
//   - Auto-capped history (MAX_STROKES) to bound memory / Historial con limite automatico (MAX_STROKES) para acotar la memoria
//   - Undo removes the most recent stroke by owner ID / Deshacer elimina el trazo mas reciente por ID de propietario
// =============================================================================

// ---------------------------------------------------------------------------
// mural.js — the authoritative shared canvas state.
//
// The server is a pixel-agnostic historian: it never rasterizes anything. It
// keeps (a) an ordered list of completed STROKE records so any new joiner can
// be handed the whole mural and undo can target a stroke by id, and (b) a map
// of OPEN strokes still being streamed live (one per owner). Rendering lives
// entirely on the clients.
// ---------------------------------------------------------------------------

const C = require("./constants.js");

function clampInt(v, lo, hi) {
  v = Math.round(v);
  return v < lo ? lo : v > hi ? hi : v;
}

const SHAPE_TOOLS = new Set([1, 2, 3]); // line / rect / circle need 2 points

class Mural {
  constructor() {
    this.strokes = []; // ordered oldest -> newest (completed)
    this.open = new Map(); // ownerId -> open stroke being streamed
    this.nextStrokeId = 1;
  }

  _norm(raw) {
    return {
      tool: clampInt(raw.tool || 0, 0, C.TOOL_COUNT - 1),
      color: clampInt(raw.color || 0, 0, C.PALETTE_COUNT - 1),
      size: clampInt(raw.size || 0, 0, C.SIZE_COUNT - 1),
      flags: (raw.flags | 0) & 0xff,
    };
  }

  _pushCapped(stroke) {
    this.strokes.push(stroke);
    if (this.strokes.length > C.MAX_STROKES) {
      this.strokes.splice(0, this.strokes.length - C.MAX_STROKES);
    }
  }

  // ---- one-shot completed stroke (shapes + eraser) ------------------------
  // Returns the stored stroke, or null if it carried no usable geometry.
  commitStroke(ownerId, raw) {
    const m = this._norm(raw);
    let pts = Array.isArray(raw.points) ? raw.points : [];
    if (pts.length > C.MAX_POINTS) pts = pts.slice(0, C.MAX_POINTS);
    const points = [];
    for (const p of pts) {
      points.push({ x: clampInt(p.x, 0, C.CANVAS_W), y: clampInt(p.y, 0, C.CANVAS_H) });
    }
    if (points.length === 0) return null;
    if (SHAPE_TOOLS.has(m.tool) && points.length < 2) return null; // degenerate

    const stroke = { id: this.nextStrokeId++, ownerId: ownerId >>> 0, ...m, points };
    this._pushCapped(stroke);
    return stroke;
  }

  // ---- streaming (brush + spray) ------------------------------------------
  begin(ownerId, raw, x, y) {
    const m = this._norm(raw);
    const stroke = {
      id: this.nextStrokeId++,
      ownerId: ownerId >>> 0,
      ...m,
      points: [{ x: clampInt(x, 0, C.CANVAS_W), y: clampInt(y, 0, C.CANVAS_H) }],
    };
    this.open.set(ownerId, stroke);
    return stroke;
  }

  // Append points into an owner's open stroke, up to the per-stroke cap.
  // Returns the points actually appended (clamped) and whether the stroke is
  // now full (the caller then auto-splits to keep the line unbroken).
  append(ownerId, pts) {
    const open = this.open.get(ownerId);
    if (!open) return { appended: [], full: false };
    const appended = [];
    for (const p of pts) {
      if (open.points.length >= C.MAX_POINTS) break;
      const q = { x: clampInt(p.x, 0, C.CANVAS_W), y: clampInt(p.y, 0, C.CANVAS_H) };
      open.points.push(q);
      appended.push(q);
    }
    return { appended, full: open.points.length >= C.MAX_POINTS };
  }

  isOpen(ownerId) {
    return this.open.has(ownerId);
  }

  // Finalize an owner's open stroke into history. Returns it, or null.
  end(ownerId) {
    const open = this.open.get(ownerId);
    if (!open) return null;
    this.open.delete(ownerId);
    if (open.points.length === 0) return null;
    this._pushCapped(open);
    return open;
  }

  // Remove the most recent completed stroke authored by ownerId. Returns id/0.
  undoLast(ownerId) {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (this.strokes[i].ownerId === ownerId) {
        const id = this.strokes[i].id;
        this.strokes.splice(i, 1);
        return id;
      }
    }
    return 0;
  }

  removeById(id) {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (this.strokes[i].id === id) {
        this.strokes.splice(i, 1);
        return true;
      }
    }
    return false;
  }
}

module.exports = { Mural };
