"use strict";
// VANDAL — scene.js. The believable place you paint in.
//  - Builds the default clean-vector weathered-brick WALL (baked once) + a
//    mortar-grain overlay that multiplies over the paint so strokes sink in.
//  - OR uses a real WALL PHOTO the player picks (bundled CC0 photo / URL / file).
//  - Draws the ENVIRONMENT around the wall each frame: warm dusk sky with
//    distant rooftops, a street-lamp, a tan sidewalk with cast shadow + puddle,
//    alley framing, atmosphere. Warm pastel — absolutely no purple/violet.

const BRICK_H = 82;
const BRICK_W = 172;
const JOINT = 12;
const ROW_H = BRICK_H + JOINT;

const Scene = {
  wallCanvas: null,
  grainCanvas: null,
  bg: { type: "vector", img: null, key: "vector" }, // current painting surface

  init() {
    this._build(World.canvasW || C.CANVAS_W, World.canvasH || C.CANVAS_H);
  },

  _build(w, h) {
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    buildWall(cv.getContext("2d"), w, h);
    this.wallCanvas = cv;

    const gr = document.createElement("canvas");
    gr.width = w;
    gr.height = h;
    buildGrain(gr.getContext("2d"), w, h);
    this.grainCanvas = gr;
    this._w = w; this._h = h;
  },

  // Rebuild the baked wall texture for a new (server-announced) wall size.
  resize(w, h) {
    if (this._w === w && this._h === h) return;
    this._build(w, h);
  },

  usingPhoto() {
    return this.bg.type === "image" && this.bg.img && this.bg.img.complete && this.bg.img.naturalWidth > 0;
  },

  // Choose the vector wall.
  setVector() { this.bg = { type: "vector", img: null, key: "vector" }; },

  // Choose a photo surface from a src (bundled path, same-origin /streetview
  // proxy, external URL, or data URL). The background is display-only (drawn
  // each frame, never read back), so we do NOT set crossOrigin — that keeps
  // arbitrary URLs / Street View stills loading even without CORS headers.
  setImage(src, key) {
    const img = new Image();
    img.onload = () => { this.bg = { type: "image", img, key: key || src }; if (typeof BG !== "undefined" && BG.onImageLoaded) BG.onImageLoaded(key); };
    img.onerror = () => { this.setVector(); if (typeof BG !== "undefined") BG.flashError(); };
    img.src = src;
  },

  // Draw the painting surface into world space (camera transform already set).
  drawWall(ctx) {
    const W = World.canvasW || C.CANVAS_W, H = World.canvasH || C.CANVAS_H;
    if (this.usingPhoto()) {
      drawCover(ctx, this.bg.img, W, H);
    } else if (this.wallCanvas) {
      ctx.drawImage(this.wallCanvas, 0, 0);
    }
  },

  // Multiplied over wall+paint so paint picks up the mortar joints (vector only).
  drawGrain(ctx) {
    if (this.usingPhoto() || !this.grainCanvas) return;
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = 0.22;
    ctx.drawImage(this.grainCanvas, 0, 0);
    ctx.restore();
  },

  // Top-lit sheen + frame over the finished surface (world space).
  drawWallOverlay(ctx) {
    const W = World.canvasW || C.CANVAS_W;
    const H = World.canvasH || C.CANVAS_H;
    const sheen = ctx.createLinearGradient(0, 0, 0, H);
    sheen.addColorStop(0, "rgba(255,244,214,0.16)");
    sheen.addColorStop(0.32, "rgba(255,244,214,0)");
    sheen.addColorStop(0.86, "rgba(70,52,30,0.06)");
    sheen.addColorStop(1, "rgba(52,38,22,0.20)");
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, W, H);
    // No border stroke: the wall is full-bleed so the view reads as a frontal,
    // proportional surface filling the viewport (a border re-introduced the
    // "floating panel" look). The flat frame clear in render.js handles margins.
  },

  // DISABLED — the old faux-3D environment (converging pavement, cast shadows,
  // drop shadow, street-lamp, skyline, puddle) made the wall read as angled and
  // disproportionate. The wall is now frontal + full-bleed and render.js paints a
  // flat clear behind it, so there is nothing to draw around it. Kept as an
  // early-return no-op so any caller is harmless.
  drawEnvironment(ctx, vw, vh, r) {
    return;
    /* eslint-disable no-unreachable */
    const groundY = r.y + r.h;

    // warm dusk sky
    const sky = ctx.createLinearGradient(0, 0, 0, vh);
    sky.addColorStop(0, "#FBE4C4");
    sky.addColorStop(0.38, "#F6DFC4");
    sky.addColorStop(1, "#EAD9BC");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, vw, vh);

    // distant rooftops on the horizon (behind + above the wall)
    drawSkyline(ctx, vw, r.y);

    // sidewalk / street below the wall
    const g = ctx.createLinearGradient(0, groundY, 0, vh);
    g.addColorStop(0, "#D3C09E");
    g.addColorStop(1, "#BEA983");
    ctx.fillStyle = g;
    ctx.fillRect(0, groundY, vw, Math.max(0, vh - groundY));
    // pavement slabs receding
    ctx.strokeStyle = "rgba(120,94,58,0.16)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 7; i++) {
      const gx = (vw / 7) * i;
      ctx.beginPath();
      ctx.moveTo(gx, groundY);
      ctx.lineTo(gx + (gx - vw / 2) * 0.18, vh);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(120,94,58,0.12)";
    ctx.beginPath();
    ctx.moveTo(0, groundY + (vh - groundY) * 0.55);
    ctx.lineTo(vw, groundY + (vh - groundY) * 0.55);
    ctx.stroke();
    // reflective puddle catching the lamp (only when there's visible sidewalk —
    // at high user zoom the wall bottom can fall below the viewport, which would
    // make the puddle radius negative)
    const belowH = vh - groundY;
    if (belowH > 6) {
      const pud = ctx.createRadialGradient(vw * 0.3, groundY + belowH * 0.62, 4, vw * 0.3, groundY + belowH * 0.62, vw * 0.16);
      pud.addColorStop(0, "rgba(255,232,180,0.22)");
      pud.addColorStop(1, "rgba(255,232,180,0)");
      ctx.fillStyle = pud;
      ctx.beginPath();
      ctx.ellipse(vw * 0.3, groundY + belowH * 0.62, vw * 0.16, belowH * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // alley framing
    const edge = Math.max(28, Math.min(r.x, vw - (r.x + r.w)) + 18);
    let ls = ctx.createLinearGradient(0, 0, edge, 0);
    ls.addColorStop(0, "rgba(52,38,22,0.32)");
    ls.addColorStop(1, "rgba(52,38,22,0)");
    ctx.fillStyle = ls;
    ctx.fillRect(0, 0, edge, vh);
    let rs = ctx.createLinearGradient(vw, 0, vw - edge, 0);
    rs.addColorStop(0, "rgba(52,38,22,0.32)");
    rs.addColorStop(1, "rgba(52,38,22,0)");
    ctx.fillStyle = rs;
    ctx.fillRect(vw - edge, 0, edge, vh);

    // street lamp (prop) on the left, with its warm glow
    drawLamp(ctx, vw, vh, r);

    // atmospheric warm haze
    const haze = ctx.createLinearGradient(0, 0, 0, vh);
    haze.addColorStop(0, "rgba(255,236,198,0.10)");
    haze.addColorStop(1, "rgba(255,236,198,0)");
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, vw, vh);

    // cast shadow of the wall onto the sidewalk
    ctx.save();
    const cast = ctx.createLinearGradient(0, groundY, 0, groundY + 120);
    cast.addColorStop(0, "rgba(48,34,18,0.42)");
    cast.addColorStop(1, "rgba(48,34,18,0)");
    ctx.fillStyle = cast;
    ctx.beginPath();
    ctx.moveTo(r.x, groundY);
    ctx.lineTo(r.x + r.w, groundY);
    ctx.lineTo(r.x + r.w + 80, groundY + 104);
    ctx.lineTo(r.x - 30, groundY + 104);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // tight contact seam
    const seam = ctx.createLinearGradient(0, groundY - 6, 0, groundY + 14);
    seam.addColorStop(0, "rgba(40,28,15,0)");
    seam.addColorStop(0.4, "rgba(40,28,15,0.4)");
    seam.addColorStop(1, "rgba(40,28,15,0)");
    ctx.fillStyle = seam;
    ctx.fillRect(r.x - 6, groundY - 6, r.w + 12, 20);

    // drop shadow behind the wall (wall texture covers the caster)
    ctx.save();
    ctx.shadowColor = "rgba(46,32,18,0.48)";
    ctx.shadowBlur = 50;
    ctx.shadowOffsetY = 20;
    ctx.fillStyle = "#E7D8BC";
    roundRectS(ctx, r.x, r.y, r.w, r.h, 3);
    ctx.fill();
    ctx.restore();
  },
};

// --- cover-fit an image into a w×h box in the current transform ---
function drawCover(ctx, img, w, h) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const ir = iw / ih;
  const tr = w / h;
  let sx = 0, sy = 0, sw = iw, sh = ih;
  if (ir > tr) { sw = ih * tr; sx = (iw - sw) / 2; }
  else { sh = iw / tr; sy = (ih - sh) / 2; }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
}

// --- props ---------------------------------------------------------------
function drawSkyline(ctx, vw, wallTop) {
  const base = Math.max(0, wallTop);
  ctx.save();
  ctx.fillStyle = "rgba(150,120,84,0.20)";
  let x = -20;
  let seed = 7;
  while (x < vw + 40) {
    const bw = 40 + ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 60);
    const bh = 20 + (seed % 60);
    ctx.fillRect(x, base - bh, bw, bh + 4);
    // a couple of lit windows
    ctx.fillStyle = "rgba(255,226,158,0.16)";
    for (let wy = base - bh + 6; wy < base - 4; wy += 12) {
      for (let wx = x + 5; wx < x + bw - 5; wx += 12) ctx.fillRect(wx, wy, 3, 4);
    }
    ctx.fillStyle = "rgba(150,120,84,0.20)";
    x += bw + 6;
  }
  ctx.restore();
}

function drawLamp(ctx, vw, vh, r) {
  const lx = Math.max(26, r.x * 0.42);
  const topY = vh * 0.12;
  const groundY = r.y + r.h;
  ctx.save();
  // glow
  const lg = ctx.createRadialGradient(lx, topY, 6, lx, topY, Math.max(vw, vh) * 0.5);
  lg.addColorStop(0, "rgba(255,226,158,0.5)");
  lg.addColorStop(0.4, "rgba(255,226,158,0.14)");
  lg.addColorStop(1, "rgba(255,226,158,0)");
  ctx.fillStyle = lg;
  ctx.fillRect(0, 0, vw, vh);
  // post
  ctx.strokeStyle = "rgba(60,45,28,0.55)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(lx, topY + 14);
  ctx.lineTo(lx, groundY + (vh - groundY) * 0.5);
  ctx.stroke();
  // arm + lamp head
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(lx, topY + 14);
  ctx.lineTo(lx + 22, topY + 6);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,222,150,0.95)";
  ctx.beginPath();
  ctx.moveTo(lx + 16, topY);
  ctx.lineTo(lx + 30, topY);
  ctx.lineTo(lx + 27, topY + 12);
  ctx.lineTo(lx + 19, topY + 12);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ===========================================================================
// Procedural weathered-brick wall (baked once) — richer texture + weathering
// ===========================================================================
function buildWall(ctx, W, H) {
  const mortar = ctx.createLinearGradient(0, 0, 0, H);
  mortar.addColorStop(0, "#E6D4B4");
  mortar.addColorStop(1, "#D6C4A0");
  ctx.fillStyle = mortar;
  ctx.fillRect(0, 0, W, H);

  const tones = ["#F3E7D0", "#F0E2C8", "#F5EBD8", "#EEDFC2", "#F2E6CF", "#ECDCBE", "#F4E9D3", "#E9D9BC"];

  let row = 0;
  for (let y = -ROW_H; y < H + ROW_H; y += ROW_H, row++) {
    const offset = row % 2 ? -(BRICK_W / 2 + JOINT / 2) : JOINT / 2;
    for (let x = offset; x < W; x += BRICK_W + JOINT) {
      const bw = BRICK_W;
      const bh = BRICK_H;
      const seed = pseudoInt(row, x);
      let t = tones[seed % tones.length];
      const aged = (seed >> 5) % 7 === 0; // some darker weathered bricks
      ctx.fillStyle = aged ? "#E4D2B0" : t;
      roundRectS(ctx, x, y, bw, bh, 5);
      ctx.fill();
      // subtle per-brick tonal wash
      if ((seed >> 3) % 3 === 0) {
        ctx.fillStyle = "rgba(150,120,80,0.05)";
        roundRectS(ctx, x, y, bw, bh, 5);
        ctx.fill();
      }
      // top-left highlight bevel
      ctx.strokeStyle = "rgba(255,251,240,0.55)";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x + 3, y + bh - 3);
      ctx.lineTo(x + 3, y + 3);
      ctx.lineTo(x + bw - 3, y + 3);
      ctx.stroke();
      // bottom-right shadow bevel
      ctx.strokeStyle = "rgba(120,94,58,0.24)";
      ctx.beginPath();
      ctx.moveTo(x + bw - 3, y + 3);
      ctx.lineTo(x + bw - 3, y + bh - 3);
      ctx.lineTo(x + 3, y + bh - 3);
      ctx.stroke();
      // occasional hairline crack
      if ((seed >> 8) % 11 === 0) {
        ctx.strokeStyle = "rgba(90,68,40,0.18)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        let crx = x + bw * 0.5;
        let cry = y + 4;
        ctx.moveTo(crx, cry);
        for (let k = 0; k < 5; k++) { crx += (((seed >> (k + 1)) % 7) - 3) * 3; cry += bh / 5; ctx.lineTo(crx, cry); }
        ctx.stroke();
      }
    }
  }

  // broad tonal irregularities (painted-over patches)
  for (let i = 0; i < 26; i++) {
    const cx = Math.random() * W;
    const cy = Math.random() * H;
    const rad = 180 + Math.random() * 460;
    const patch = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    const warm = Math.random() < 0.5;
    patch.addColorStop(0, warm ? "rgba(206,172,120,0.07)" : "rgba(255,250,238,0.06)");
    patch.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = patch;
    ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
  }

  // weathered speckle
  for (let i = 0; i < 16000; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    ctx.fillStyle = Math.random() < 0.5 ? "rgba(255,252,244,0.05)" : "rgba(120,94,58,0.055)";
    ctx.beginPath();
    ctx.arc(x, y, Math.random() * 2.1, 0, Math.PI * 2);
    ctx.fill();
  }
  // runoff streaks (denser toward the base)
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H * (i < 50 ? 0.6 : 1);
    ctx.strokeStyle = "rgba(110,86,52,0.055)";
    ctx.lineWidth = 1 + Math.random() * 2.4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 26, y + 40 + Math.random() * 220);
    ctx.stroke();
  }
  // ochre stains near the base (grime, not moss — stays warm)
  for (let i = 0; i < 30; i++) {
    const x = Math.random() * W;
    const y = H - Math.random() * H * 0.18;
    const rad = 40 + Math.random() * 120;
    const st = ctx.createRadialGradient(x, y, 0, x, y, rad);
    st.addColorStop(0, "rgba(120,92,50,0.08)");
    st.addColorStop(1, "rgba(120,92,50,0)");
    ctx.fillStyle = st;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }

  // ambient light bloom
  const glow = ctx.createRadialGradient(W * 0.34, H * 0.16, 40, W * 0.34, H * 0.16, Math.max(W, H) * 0.72);
  glow.addColorStop(0, "rgba(255,242,212,0.32)");
  glow.addColorStop(1, "rgba(255,242,212,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // grime band at the base
  const grime = ctx.createLinearGradient(0, H, 0, H - H * 0.18);
  grime.addColorStop(0, "rgba(54,40,22,0.32)");
  grime.addColorStop(1, "rgba(54,40,22,0)");
  ctx.fillStyle = grime;
  ctx.fillRect(0, H - H * 0.18, W, H * 0.18);

  // warm edge vignette
  const vig = ctx.createRadialGradient(W / 2, H * 0.44, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.64);
  vig.addColorStop(0, "rgba(84,62,36,0)");
  vig.addColorStop(1, "rgba(84,62,36,0.18)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);
}

// Grain overlay: mortar joints as recessed dark lines (aligned to bricks).
function buildGrain(ctx, W, H) {
  ctx.clearRect(0, 0, W, H);
  let row = 0;
  for (let y = -ROW_H; y < H + ROW_H; y += ROW_H, row++) {
    const offset = row % 2 ? -(BRICK_W / 2 + JOINT / 2) : JOINT / 2;
    for (let x = offset; x < W; x += BRICK_W + JOINT) {
      ctx.strokeStyle = "rgba(70,52,30,0.5)";
      ctx.lineWidth = JOINT * 0.8;
      roundRectS(ctx, x - JOINT / 2, y - JOINT / 2, BRICK_W + JOINT, BRICK_H + JOINT, 6);
      ctx.stroke();
    }
  }
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = "rgba(70,52,30,0.05)";
    ctx.beginPath();
    ctx.arc(Math.random() * W, Math.random() * H, Math.random() * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function pseudoInt(a, b) {
  let n = (Math.imul(a | 0, 73856093) ^ Math.imul(Math.round(b), 19349663)) >>> 0;
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return n >>> 0;
}

function roundRectS(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
