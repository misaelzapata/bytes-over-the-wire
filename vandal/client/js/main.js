"use strict";

// =============================================================================
// main.js — Application bootstrap: nickname entry, WebSocket join, the
//           requestAnimationFrame render loop, presence HUD & disconnect card.
// Arranque de la aplicacion: entrada de apodo, union por WebSocket, bucle de
// renderizado requestAnimationFrame, HUD de presencia y tarjeta de desconexion.
//
// Key concepts / Conceptos clave:
//   - Entry point: boots all subsystems (Scene, Mural, Render, Input) / Punto de entrada: arranca todos los subsistemas (Scene, Mural, Render, Input)
//   - Nickname menu gates the WebSocket connection / El menu de apodo controla la conexion WebSocket
//   - Drives the continuous rAF render loop via Render.frame() / Impulsa el bucle continuo rAF mediante Render.frame()
//   - Handles presence updates and disconnect UI / Gestiona actualizaciones de presencia e interfaz de desconexion
// =============================================================================

// VANDAL — main.js. Boot, nick menu -> join, rAF render loop, presence HUD,
// gallery banner, disconnect card.

const Main = {
  inMenu: true,
  nick: "",
  reducedMotion: false,
  _galleryHideAt: 0,

  boot() {
    const canvas = document.getElementById("game");
    Scene.init();
    Mural.init();
    Render.init(canvas);
    Input.init(canvas);
    BG.init();

    this.reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const nickInput = document.getElementById("nickInput");
    const playBtn = document.getElementById("playBtn");
    const start = () => {
      const name = (nickInput.value || "").trim().slice(0, C.NICK_MAX);
      this.nick = name;
      this._play(name);
    };
    playBtn.addEventListener("click", start);
    nickInput.addEventListener("keydown", (e) => { if (e.key === "Enter") start(); });
    nickInput.focus();

    requestAnimationFrame((t) => this._loop(t));
  },

  _play(name) {
    this.inMenu = false;
    document.getElementById("nameEntry").classList.add("hidden");
    document.getElementById("toolbar").classList.remove("hidden");
    document.getElementById("presence").classList.remove("hidden");
    document.getElementById("hint").classList.remove("hidden");
    if (!Net.connected) Net.connect(name);
  },

  _loop(t) {
    Render.frame(t);
    requestAnimationFrame((tt) => this._loop(tt));
  },

  updatePresence(count) {
    const el = document.getElementById("presenceVal");
    if (el) el.textContent = count;
  },

  onDisconnect() {
    if (this.inMenu) return;
    const card = document.getElementById("deathCard");
    document.getElementById("deathText").innerHTML =
      "Disconnected<br><span class='death-sub'>Refresh to rejoin the mural</span>";
    card.classList.remove("hidden");
  },
};

(function () { Main.boot(); })();
