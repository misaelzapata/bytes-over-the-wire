"use strict";

// =============================================================================
// physics.js — Shared physics formulas used by both server and client.
//              Formulas de fisica compartidas usadas tanto por el servidor como por el cliente.
//
// Key concepts / Conceptos clave:
//   - radius = sqrt(100 * mass): geometric law converting mass to visual size / radius = sqrt(100 * mass): ley geometrica que convierte masa a tamano visual
//   - speed(mass): bigger cells move slower (power-law scaling) / speed(mass): celulas mas grandes se mueven mas lento (escala de ley de potencia)
//   - recombineTicks(mass): merge cooldown timer after splitting / recombineTicks(mass): temporizador de enfriamiento de fusion tras dividirse
//   - viewScale/viewHalf: camera zoom and AoI extent derived from cell size / viewScale/viewHalf: zoom de camara y extension AoI derivados del tamano de celula
// =============================================================================

// ---------------------------------------------------------------------------
// physics.js — shared formulas (SPEC §2, §3, §7, §1.3).
//
// The client duplicates these VERBATIM so own-cell prediction matches the
// authoritative server exactly. Everything runs on full-precision floats; the
// wire quantizes only for transport (protocol.js).
// ---------------------------------------------------------------------------

const C = require("./constants.js");

// radius = sqrt(100 * mass) = 10*sqrt(mass)     (Ogar Cell.getSize)
function radius(mass) {
  return Math.sqrt(100 * mass);
}

// mass = radius^2 / 100
function massOf(r) {
  return (r * r) / 100;
}

// speed (world units / second): bigger => slower.
function speed(mass) {
  return C.SPEED_BASE * Math.pow(mass, C.SPEED_EXP);
}

// recombine time in whole ticks: max(NO_MERGE_TICKS, (30 + 0.02*mass) * TICK_HZ)
function recombineTicks(mass) {
  const s = C.MERGE_BASE_S + C.MERGE_PER_MASS_S * mass;
  return Math.max(C.NO_MERGE_TICKS, Math.round(s * C.TICK_HZ));
}

// classic zoom proxy: R = sum of own-cell radii.
function viewScale(R) {
  return Math.pow(Math.min(64 / R, 1), 0.4);
}

// server AoI half-extent (world units) from the same R the client zooms with.
function viewHalf(R) {
  const vs = viewScale(R);
  return C.BASE_VIEW_H / 2 / vs + C.AOI_PAD;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

module.exports = {
  radius,
  massOf,
  speed,
  recombineTicks,
  viewScale,
  viewHalf,
  clamp,
};
