"use strict";

// =============================================================================
// main.js — Client entry point: boot sequence, game loop, UI overlays.
//           Punto de entrada del cliente: secuencia de arranque, bucle de juego, overlays de UI.
//
// Key concepts / Conceptos clave:
//   - Boots canvas renderer, input handler, and nickname menu / Arranca el renderizador de canvas, manejador de entrada y menu de apodo
//   - Runs the requestAnimationFrame game loop (input -> interpolation -> render) / Ejecuta el bucle de juego requestAnimationFrame (entrada -> interpolacion -> renderizado)
//   - Manages play/death/respawn UI transitions and leaderboard DOM / Gestiona transiciones de UI jugar/muerte/reaparecer y DOM de tabla de lideres
//   - Tracks FPS and delegates network events (welcome, death, disconnect) / Rastrea FPS y delega eventos de red (bienvenida, muerte, desconexion)
// =============================================================================

// AGAR-CLONE — client main.js. Boot, nick menu -> join, rAF game loop, leaderboard
// DOM, death/respawn overlay, fps (SPEC §13-§14).

const Main = {
  inMenu: true,
  fps: 0,
  _frames: 0,
  _fpsMs: 0,
  _lastMs: 0,
  nick: "",

  boot() {
    const canvas = document.getElementById("game");
    Render.init(canvas);
    Input.init(canvas);

    const nickInput = document.getElementById("nickInput");
    const playBtn = document.getElementById("playBtn");
    const respawnBtn = document.getElementById("respawnBtn");

    const start = () => {
      const name = (nickInput.value || "").trim().slice(0, C.NICK_MAX);
      this.nick = name;
      this._play(name);
    };
    playBtn.addEventListener("click", start);
    nickInput.addEventListener("keydown", (e) => { if (e.key === "Enter") start(); });
    if (respawnBtn) respawnBtn.addEventListener("click", () => this.requestRespawn());
    if (nickInput) nickInput.focus();

    this._lastMs = performance.now();
    requestAnimationFrame((t) => this._loop(t));
  },

  _play(name) {
    this.inMenu = false;
    document.getElementById("nameEntry").classList.add("hidden");
    document.getElementById("leaderboard").classList.remove("hidden");
    document.getElementById("scorePanel").classList.remove("hidden");
    document.getElementById("hint").classList.remove("hidden");
    if (!Net.connected) Net.connect(name);
    else { Net.sendNick(name); Net.sendRespawn(); }
  },

  _loop(t) {
    const dt = Math.min(0.1, (t - this._lastMs) / 1000);
    this._lastMs = t;

    // fps
    this._frames++;
    this._fpsMs += dt * 1000;
    if (this._fpsMs >= 500) { this.fps = Math.round(this._frames / (this._fpsMs / 1000)); this._frames = 0; this._fpsMs = 0; }

    if (!this.inMenu) {
      Input.update();
      tickInterpolation(dt, Input.mouseWorld);
    }
    Render.frame();
    requestAnimationFrame((tt) => this._loop(tt));
  },

  // --- net callbacks ---
  onWelcome(msg) {
    Render.hasCam = false; // let camera snap to first centroid
  },

  onDeath(finalMass) {
    const card = document.getElementById("deathCard");
    document.getElementById("deathText").innerHTML =
      "You were eaten<br><span class='death-mass'>Mass " + finalMass + "</span>";
    card.classList.remove("hidden");
  },

  requestRespawn() {
    if (!World.dead) return;
    document.getElementById("deathCard").classList.add("hidden");
    World.dead = false;
    Render.hasCam = false;
    Net.sendRespawn();
  },

  onDisconnect() {
    if (this.inMenu) return;
    const card = document.getElementById("deathCard");
    document.getElementById("deathText").innerHTML = "Disconnected<br><span class='death-mass'>Refresh to rejoin</span>";
    card.classList.remove("hidden");
  },

  renderLeaderboard() {
    const rowsEl = document.getElementById("lbRows");
    if (!rowsEl) return;
    const rows = World.leaderboard;
    let html = "";
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const mine = r.playerId === World.selfId;
      const nm = r.name && r.name.length ? escapeHtml(r.name) : "An unnamed cell";
      html += "<div class='lb-row" + (mine ? " lb-me" : "") + "'>" +
        "<span class='lb-rank'>" + (i + 1) + "</span>" +
        "<span class='lb-name'>" + nm + "</span></div>";
    }
    rowsEl.innerHTML = html;
  },
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

(function () { Main.boot(); })();
