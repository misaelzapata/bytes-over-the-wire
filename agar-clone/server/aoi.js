"use strict";

// =============================================================================
// aoi.js — Spatial hash grid for Area-of-Interest queries and broad-phase collision.
//          Cuadricula hash espacial para consultas de Area de Interes y colision de fase amplia.
//
// Key concepts / Conceptos clave:
//   - Uniform grid with configurable cell size (default 1024 world units) / Cuadricula uniforme con tamano de celda configurable (por defecto 1024 unidades de mundo)
//   - insert(x,y,ref) places entities into hash buckets / insert(x,y,ref) coloca entidades en cubetas hash
//   - queryCircle(x,y,r) returns coarse candidates overlapping a bounding square / queryCircle(x,y,r) retorna candidatos gruesos que solapan un cuadrado delimitador
//   - Rebuilt every tick from live entity maps; reused by both eat-pass and viewport AoI / Se reconstruye cada tick desde mapas de entidades vivos; reutilizada por el pase de comida y AoI del viewport
// =============================================================================

// ---------------------------------------------------------------------------
// aoi.js — uniform spatial hash (AOI_CELL=1024) for Area-of-Interest queries
// and the cell/food/virus/eject broad-phase used by the eat passes.
//
// Rebuilt each tick from the live entity maps. Cheap for a few thousand bodies.
// (Reused verbatim in pattern from bullseye.io/server/aoi.js.)
// ---------------------------------------------------------------------------

const C = require("./constants.js");

function cellKey(cx, cy) {
  return cx * 100000 + cy;
}

class Grid {
  constructor(cell = C.AOI_CELL) {
    this.cell = cell;
    this.map = new Map(); // key -> array of { x, y, ref }
  }

  clear() {
    this.map.clear();
  }

  _cellOf(x, y) {
    return [Math.floor(x / this.cell), Math.floor(y / this.cell)];
  }

  insert(x, y, ref) {
    const [cx, cy] = this._cellOf(x, y);
    const key = cellKey(cx, cy);
    let bucket = this.map.get(key);
    if (!bucket) {
      bucket = [];
      this.map.set(key, bucket);
    }
    bucket.push({ x, y, ref });
  }

  // Return every entry whose cell overlaps the square bounding (x,y,radius).
  // Coarse: caller does the precise circle/overlap test.
  queryCircle(x, y, radius) {
    const out = [];
    const min = this._cellOf(x - radius, y - radius);
    const max = this._cellOf(x + radius, y + radius);
    for (let cx = min[0]; cx <= max[0]; cx++) {
      for (let cy = min[1]; cy <= max[1]; cy++) {
        const bucket = this.map.get(cellKey(cx, cy));
        if (bucket) for (const e of bucket) out.push(e);
      }
    }
    return out;
  }
}

module.exports = { Grid };
