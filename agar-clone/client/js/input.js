"use strict";
// AGAR-CLONE — client input.js. Mouse -> INPUT_TARGET (throttled ~25Hz),
// SPACE -> SPLIT, W -> EJECT, respawn-on-death keys (SPEC §12.1).

const Input = {
  canvas: null,
  mouseX: 0, mouseY: 0,          // screen px
  mouseWorld: { x: C.WORLD_SIZE / 2, y: C.WORLD_SIZE / 2 }, // drift target (world)
  _lastSentMs: 0,
  _lastX: -1, _lastY: -1,

  init(canvas) {
    this.canvas = canvas;
    this.mouseX = window.innerWidth / 2;
    this.mouseY = window.innerHeight / 2;

    window.addEventListener("mousemove", (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });

    window.addEventListener("keydown", (e) => {
      if (Main.inMenu) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (!World.dead) Net.sendSplit();
      } else if (e.code === "KeyW") {
        e.preventDefault();
        if (!World.dead) Net.sendEject();
      } else if (e.code === "Enter") {
        if (World.dead) Main.requestRespawn();
      }
    });

    // click to respawn from death overlay
    window.addEventListener("mousedown", () => {
      if (!Main.inMenu && World.dead) Main.requestRespawn();
    });
  },

  // Called each frame: recompute the world-space mouse target (for prediction)
  // and throttle-send INPUT_TARGET to the server.
  update() {
    const w = Render.screenToWorld(this.mouseX, this.mouseY);
    // clamp into world bounds
    w.x = w.x < 0 ? 0 : w.x > World.worldW ? World.worldW : w.x;
    w.y = w.y < 0 ? 0 : w.y > World.worldH ? World.worldH : w.y;
    this.mouseWorld.x = w.x;
    this.mouseWorld.y = w.y;

    if (Main.inMenu || World.dead || !Net.connected) return;

    const now = performance.now();
    const ix = Math.round(w.x), iy = Math.round(w.y);
    if (now - this._lastSentMs >= 1000 / C.INPUT_HZ && (ix !== this._lastX || iy !== this._lastY)) {
      Net.sendTarget(ix, iy);
      this._lastSentMs = now;
      this._lastX = ix; this._lastY = iy;
    }
  },
};
