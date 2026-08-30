"use strict";

// =============================================================================
// net.js — Client networking layer: WebSocket lifecycle, binary message
//          decode/dispatch, join handshake, PING/PONG RTT, and cursor uplink.
// Capa de red del cliente: ciclo de vida WebSocket, decodificacion/despacho
// de mensajes binarios, handshake de union, RTT PING/PONG y envio de cursor.
//
// Key concepts / Conceptos clave:
//   - Opens a binary WebSocket, sends HANDSHAKE + SET_NICK on connect / Abre un WebSocket binario, envia HANDSHAKE + SET_NICK al conectar
//   - Dispatches decoded server packets to World, Mural, Cursors, etc. / Despacha paquetes del servidor decodificados a World, Mural, Cursors, etc.
//   - Periodic PING for RTT measurement; ~16 Hz cursor position uplink / PING periodico para medir RTT; envio de posicion del cursor a ~16 Hz
//   - Stroke senders: one-shot commit, streaming begin/append/end, undo / Envio de trazos: commit directo, streaming begin/append/end, deshacer
// =============================================================================

// VANDAL — client net.js. WebSocket lifecycle, binary S->C decode dispatch,
// C->S encode, join sequence + PING/PONG clock read + live cursor uplink.

const Net = {
  ws: null,
  connected: false,
  pingTimer: null,
  cursorTimer: null,
  _pendingNick: "",

  connect(nick) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = proto + "//" + location.host + "/";
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this._pendingNick = nick;

    ws.onopen = () => {
      this.connected = true;
      World.connected = true;
      this.send(Protocol.encHandshake(C.PROTOCOL_VERSION));
      this.send(Protocol.encSetNick(this._pendingNick));
    };
    ws.onmessage = (ev) => this._onMessage(ev.data);
    ws.onclose = () => {
      this.connected = false;
      World.connected = false;
      this._stopPing();
      this._stopCursor();
      Main.onDisconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  },

  send(bytes) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
  },

  _onMessage(data) {
    const msg = Protocol.decodeServer(data);
    switch (msg.type) {
      case "welcome":
        World.reset();
        World.selfId = msg.yourId;
        World.canvasW = msg.canvasW;
        World.canvasH = msg.canvasH;
        // adopt the server-announced wall size end-to-end (paint buffer + scene
        // texture + camera fit) so a configured wall size actually takes effect
        if (typeof Scene !== "undefined" && Scene.resize) Scene.resize(World.canvasW, World.canvasH);
        if (typeof Mural !== "undefined" && Mural.resize) Mural.resize(World.canvasW, World.canvasH);
        this._startPing();
        this._startCursor();
        break;
      case "history":
        Mural.loadHistory(msg.strokes);
        break;
      case "stroke":
        Mural.addStroke(msg.stroke);
        if (msg.stroke.ownerId === World.selfId) Input.onCommit();
        break;
      case "stroke_begin":
        Mural.beginLive(msg);
        break;
      case "stroke_append":
        Mural.appendLive(msg.id, msg.points);
        break;
      case "undo":
        Mural.removeStroke(msg.strokeId);
        break;
      case "presence":
        World.painters = msg.count;
        Main.updatePresence(msg.count);
        break;
      case "cursors":
        Cursors.onSnapshot(msg.list);
        break;
      case "gallery":
        // Camera is hard-locked — ignore any legacy fly-through cue (no motion).
        break;
      case "pong":
        this._onPong(msg);
        break;
      case "version_outdated":
        alert("Client outdated — please refresh.");
        break;
    }
  },

  _startPing() {
    if (this.pingTimer) return;
    const doPing = () => this.send(Protocol.encPing(Date.now() & 0xffffffff));
    doPing();
    this.pingTimer = setInterval(doPing, 2000);
  },
  _stopPing() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } },

  // ~16 Hz: broadcast my brush position/pressing/color so others see me paint.
  _startCursor() {
    if (this.cursorTimer) return;
    this.cursorTimer = setInterval(() => {
      if (!World.connected) return;
      const w = Input.cursorWorld;
      if (!w) return;
      this.send(Protocol.encCursor(Math.round(w.x), Math.round(w.y), Input.painting, Input.color, Input.tool));
    }, C.CURSOR_SEND_MS);
  },
  _stopCursor() { if (this.cursorTimer) { clearInterval(this.cursorTimer); this.cursorTimer = null; } },

  _onPong(msg) {
    const nowMs = Date.now() & 0xffffffff;
    let rtt = nowMs - msg.clientMs;
    if (rtt < 0) rtt += 0x100000000;
    World.rtt = rtt;
  },

  // --- senders ---
  sendStroke(tool, color, size, flags, points) { this.send(Protocol.encStroke(tool, color, size, flags, points)); },
  sendStrokeBegin(tool, color, size, flags, x, y) { this.send(Protocol.encStrokeBegin(tool, color, size, flags, x, y)); },
  sendStrokeAppend(points) { this.send(Protocol.encStrokeAppend(points)); },
  sendStrokeEnd() { this.send(Protocol.encStrokeEnd()); },
  sendUndo() { this.send(Protocol.encUndo()); },
};
