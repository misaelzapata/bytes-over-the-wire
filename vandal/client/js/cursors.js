"use strict";
// VANDAL — cursors.js. Shows WHO IS DRAWING and WHAT THEY'RE HOLDING. Remote
// painters' live brush positions arrive ~20 Hz over the binary socket; here
// they're smoothly interpolated and drawn as a color-tinted nib with a soft
// name chip, a live TOOL icon (brush/spray/line/rect/circle/eraser), a
// "painting…" pulse, and an artist star for the "Banksy" bot.

// Bot cursors broadcast at 20 Hz (CURSORS_EVERY:1). The old code ran a 75 ms
// EMA here (τ=75ms → −3dB at ~2.1 Hz), which DELETED the entire 2–10 Hz band the
// server computes — submovements, ease-in/out, dwell, lead/lag — and step-held a
// 20 Hz reveal, so all the motor-law motion never reached the eye. Instead we run
// a RENDER-DELAY JITTER BUFFER: keep the last ~12 timestamped samples per cursor
// and, at 60 fps, sample the buffer ~110 ms (≈2.2 samples) in the past with
// VELOCITY-AWARE CUBIC HERMITE (Catmull-Rom). That reconstructs the server's
// sub-8 Hz velocity signal — accel, deceleration, curve slow-downs, dwells,
// micro-pauses — as continuous motion, instead of low-passing it away.
const Cursors = {
  map: new Map(), // id -> {x,y,buf:[{t,x,y}],pressing,color,tool,name,lastSeen,toolFlash}
  _lastFrame: 0,
  DELAY_MS: 110,  // render this far behind newest sample (≈2.2 @ 20Hz) — jitter buffer

  onSnapshot(list) {
    const now = performance.now();
    for (const e of list) {
      if (e.id === World.selfId) continue;
      let c = this.map.get(e.id);
      const nt = e.tool | 0;
      if (!c) {
        c = { x: e.x, y: e.y, buf: [{ t: now, x: e.x, y: e.y }], pressing: false, color: e.color, tool: nt, name: e.name, lastSeen: now, toolFlash: 0 };
        this.map.set(e.id, c);
      } else {
        if (nt !== c.tool) c.toolFlash = now; // grabbed a different can/tool -> nib flash
        c.buf.push({ t: now, x: e.x, y: e.y });
        if (c.buf.length > 12) c.buf.shift();
      }
      c.color = e.color;
      c.tool = nt;
      c.name = e.name;
      c.pressing = e.pressing;
      c.lastSeen = now;
    }
  },

  update(now) {
    this._lastFrame = now;
    const rt = now - this.DELAY_MS;
    for (const [id, c] of this.map) {
      if (now - c.lastSeen > 1500) { this.map.delete(id); continue; }
      const p = sampleHermite(c.buf, rt);
      if (p) { c.x = p.x; c.y = p.y; }
    }
  },

  count() { return this.map.size; },

  draw(ctx, now) {
    for (const c of this.map.values()) {
      const s = Camera.worldToScreen(c.x, c.y);
      drawCursor(ctx, s.x, s.y, c, now);
    }
  },
};

// graffiti kit labels (mapped onto the 6 fixed tool ids)
const TOOL_NAMES = ["Marker", "Straightedge", "Roller", "Stencil", "Buff", "Spray"];
const TOOL_FLASH_MS = 780;

function drawCursor(ctx, x, y, c, now) {
  const col = PALETTE[c.color] || "#E0533F";
  const artist = c.name === "Banksy";
  const flash = c.toolFlash ? Math.max(0, 1 - (now - c.toolFlash) / TOOL_FLASH_MS) : 0;
  ctx.save();

  // tool-change POP: a quick ring off the nib + the tool name floating up, so
  // you SEE the painter grab a new can/brush.
  if (flash > 0) {
    const e = 1 - flash; // 0..1 over the flash lifetime
    ctx.beginPath();
    ctx.arc(x, y, 8 + e * 26, 0, Math.PI * 2);
    ctx.strokeStyle = curAlpha(col, flash * 0.7);
    ctx.lineWidth = 2.4;
    ctx.stroke();
    const label = TOOL_NAMES[c.tool] || "tool";
    ctx.font = "700 12px 'Segoe UI', Roboto, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const ly = y - 22 - e * 10;
    const lw = ctx.measureText(label).width + 14;
    ctx.globalAlpha = flash;
    roundRectC(ctx, x - lw / 2, ly - 9, lw, 18, 9);
    ctx.fillStyle = "rgba(43,38,32,0.92)";
    ctx.fill();
    ctx.fillStyle = "#FFF3E2";
    ctx.fillText(label, x, ly + 0.5);
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
  }

  // painting pulse while actively laying down a stroke
  if (c.pressing) {
    const t = (now % 850) / 850;
    ctx.beginPath();
    ctx.arc(x, y, 9 + t * 20, 0, Math.PI * 2);
    ctx.strokeStyle = curAlpha(col, (1 - t) * 0.5);
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = curAlpha(col, 0.7);
    ctx.beginPath();
    ctx.arc(x, y + 11 + Math.sin(now / 180) * 1.5, 2.1, 0, Math.PI * 2);
    ctx.fill();
  }

  // soft contact shadow
  ctx.beginPath();
  ctx.ellipse(x, y + 2, 8, 5, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(60,45,28,0.20)";
  ctx.fill();

  // nib
  ctx.beginPath();
  ctx.moveTo(x - 1.5, y - 12);
  ctx.lineTo(x + 6, y - 4);
  ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fillStyle = curAlpha(col, 0.9);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 7.5, 0, Math.PI * 2);
  ctx.fillStyle = col;
  ctx.fill();
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = artist ? "rgba(255,214,120,0.98)" : "rgba(255,252,246,0.95)";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x - 2, y - 2, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,253,248,0.85)";
  ctx.fill();

  // name + tool chip
  const name = c.name && c.name.length ? c.name : "painter";
  ctx.font = "600 11px 'Segoe UI', Roboto, Arial, sans-serif";
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(name).width;
  const dot = 6;
  const iconW = 15;
  const padX = 7;
  const tagH = 18;
  const tagX = x + 11;
  const tagY = y + 6;
  const starW = artist ? 13 : 0;
  const tagW = starW + dot + 4 + tw + 5 + iconW + padX * 2;
  ctx.shadowColor = "rgba(40,28,15,0.28)";
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 1;
  roundRectC(ctx, tagX, tagY, tagW, tagH, 9);
  ctx.fillStyle = artist ? "rgba(58,42,22,0.72)" : "rgba(53,40,26,0.62)";
  ctx.fill();
  ctx.shadowColor = "transparent";

  let cxp = tagX + padX;
  const midY = tagY + tagH / 2;
  if (artist) {
    drawStar(ctx, cxp + 5, midY, 5.5, "#FFD27A");
    cxp += starW;
  }
  ctx.beginPath();
  ctx.arc(cxp + dot / 2, midY, dot / 2, 0, Math.PI * 2);
  ctx.fillStyle = col;
  ctx.fill();
  cxp += dot + 4;
  ctx.fillStyle = "rgba(251,240,222,0.96)";
  ctx.fillText(name, cxp, midY + 0.5);
  cxp += tw + 5;
  drawToolIcon(ctx, c.tool, cxp, tagY, iconW, tagH, flash);

  ctx.restore();
}

// small monochrome GRAFFITI-KIT glyph (drawn in warm cream on the chip). The
// icon briefly pops (scales) when the painter switches tools.
function drawToolIcon(ctx, tool, x, y, w, h, flash) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.save();
  if (flash > 0) { ctx.translate(cx, cy); ctx.scale(1 + flash * 0.7, 1 + flash * 0.7); ctx.translate(-cx, -cy); }
  const ink = flash > 0 ? "rgba(255,235,190,1)" : "rgba(255,246,228,0.92)";
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (tool === 5) {
    // SPRAY CAN (hero): can body + cap + aerosol dots
    ctx.strokeRect(cx - 3, cy - 3.5, 5.5, 8);
    ctx.strokeRect(cx - 2, cy - 6, 3.5, 2.4); // cap
    ctx.beginPath(); ctx.moveTo(cx - 0.2, cy - 6); ctx.lineTo(cx - 0.2, cy - 7.2); ctx.stroke(); // nozzle
    for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(cx + 4.5 + (i % 2) * 2, cy - 6 + i * 2.2, 0.85, 0, Math.PI * 2); ctx.fill(); }
  } else if (tool === 1) {
    // STRAIGHTEDGE (ruler)
    ctx.strokeRect(cx - 6, cy - 2, 12, 4);
    for (let i = -4; i <= 4; i += 2) { ctx.beginPath(); ctx.moveTo(cx + i, cy - 2); ctx.lineTo(cx + i, cy); ctx.stroke(); }
  } else if (tool === 2) {
    // ROLLER (paint roller)
    ctx.fillRect(cx - 6, cy - 5, 12, 4.5); // sleeve
    ctx.strokeRect(cx - 6, cy - 5, 12, 4.5);
    ctx.beginPath(); ctx.moveTo(cx, cy - 0.5); ctx.lineTo(cx, cy + 3); ctx.lineTo(cx + 3, cy + 6); ctx.stroke(); // handle
  } else if (tool === 3) {
    // STENCIL (sheet with a cut circle)
    ctx.strokeRect(cx - 6, cy - 5, 12, 10);
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
  } else if (tool === 4) {
    // BUFF (paint-over roller block)
    ctx.fillRect(cx - 6, cy - 4.5, 9, 9);
    ctx.beginPath(); ctx.moveTo(cx + 3, cy); ctx.lineTo(cx + 6, cy - 3); ctx.stroke();
  } else {
    // MARKER (chisel-tip handstyle marker)
    ctx.beginPath(); ctx.moveTo(cx - 6, cy + 5); ctx.lineTo(cx + 2, cy - 3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 2, cy - 3); ctx.lineTo(cx + 5.5, cy - 6.5); ctx.lineTo(cx + 6.5, cy - 4); ctx.lineTo(cx + 3, cy - 0.5); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawStar(ctx, cx, cy, r, color) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    const px = cx + Math.cos(a) * rr;
    const py = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// Velocity-aware cubic Hermite (Catmull-Rom) sample of a timestamped buffer at
// time `rt`. Reproduces the accel/decel/dwell between 20 Hz samples as smooth
// 60 fps motion (vs. a lerp, which is piecewise-constant velocity = faceted).
function sampleHermite(buf, rt) {
  const n = buf.length;
  if (n === 0) return null;
  if (n === 1 || rt <= buf[0].t) return { x: buf[0].x, y: buf[0].y };
  const last = buf[n - 1];
  if (rt >= last.t) return { x: last.x, y: last.y }; // hold at newest on a gap
  let i = 0; while (i < n - 1 && buf[i + 1].t < rt) i++;
  const p1 = buf[i], p2 = buf[i + 1];
  const u = (rt - p1.t) / ((p2.t - p1.t) || 1);
  const p0 = buf[i - 1] || p1, p3 = buf[i + 2] || p2;
  const m1x = (p2.x - p0.x) * 0.5, m1y = (p2.y - p0.y) * 0.5;
  const m2x = (p3.x - p1.x) * 0.5, m2y = (p3.y - p1.y) * 0.5;
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  return {
    x: h00 * p1.x + h10 * m1x + h01 * p2.x + h11 * m2x,
    y: h00 * p1.y + h10 * m1y + h01 * p2.y + h11 * m2y,
  };
}

function curAlpha(hex, a) {
  const h = hex.replace("#", "");
  return `rgba(${parseInt(h.substring(0, 2), 16)},${parseInt(h.substring(2, 4), 16)},${parseInt(h.substring(4, 6), 16)},${a})`;
}

function roundRectC(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
