"use strict";

// =============================================================================
// net.js — Client networking: WebSocket lifecycle, binary protocol dispatch.
//          Red del cliente: ciclo de vida WebSocket, despacho de protocolo binario.
//
// Key concepts / Conceptos clave:
//   - Connects via WebSocket, sends HANDSHAKE + SET_NICK join sequence / Conecta via WebSocket, envia secuencia de union HANDSHAKE + SET_NICK
//   - Decodes server packets (welcome, snapshot, leaderboard, pong, death) / Decodifica paquetes del servidor (welcome, snapshot, leaderboard, pong, death)
//   - Encodes client packets (target, split, eject, ping, respawn) / Codifica paquetes del cliente (target, split, eject, ping, respawn)
//   - Manages PING/PONG clock synchronization and RTT measurement / Gestiona sincronizacion de reloj PING/PONG y medicion de RTT
// =============================================================================

// AGAR-CLONE — client net.js. WebSocket lifecycle, binary S->C decode dispatch,
// C->S encode, join sequence + PING/PONG clock sync (SPEC §11-§12).

const Net = {
  ws: null,
  connected: false,
  pingTimer: null,
  _pendingNick: "",

  connect(nick) {
    // 'BULLSEYE_WS' style rewrite is handled server-side; default to same host.
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = proto + "//" + location.host + "/";
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this._pendingNick = nick;

    ws.onopen = () => {
      this.connected = true;
      // Join sequence: HANDSHAKE(version) -> SET_NICK(name) (SPEC §12.3)
      this.send(Protocol.encHandshake(C.PROTOCOL_VERSION));
      this.send(Protocol.encSetNick(this._pendingNick));
    };
    ws.onmessage = (ev) => this._onMessage(ev.data);
    ws.onclose = () => { this.connected = false; this._stopPing(); Main.onDisconnect(); };
    ws.onerror = () => { /* onclose follows */ };
  },

  send(bytes) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
  },

  _onMessage(data) {
    const msg = Protocol.decodeServer(data);
    switch (msg.type) {
      case "welcome": this._onWelcome(msg); break;
      case "snapshot": applySnapshot(msg); break;
      case "leaderboard":
        World.leaderboard = msg.rows;
        World.yourRank = msg.yourRank;
        break;
      case "pong": this._onPong(msg); break;
      case "death":
        World.dead = true;
        World.finalMass = msg.finalMass;
        Main.onDeath(msg.finalMass);
        break;
      case "version_outdated":
        alert("Client outdated — please refresh.");
        break;
    }
  },

  _onWelcome(msg) {
    World.reset();
    World.selfId = msg.yourPlayerId;
    World.worldW = msg.worldW;
    World.worldH = msg.worldH;
    World.dead = false;
    this._syncClockFromTick(msg.serverTick);
    Main.onWelcome(msg);
    this._startPing();
  },

  _syncClockFromTick(serverTick) {
    World.serverTickAtSync = serverTick;
    World.clientMsAtSync = performance.now();
    World.hasClock = true;
  },

  _startPing() {
    if (this.pingTimer) return;
    const doPing = () => this.send(Protocol.encPing(Date.now() & 0xffffffff));
    doPing();
    this.pingTimer = setInterval(doPing, 1000);
  },
  _stopPing() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } },

  _onPong(msg) {
    const nowMs = Date.now() & 0xffffffff;
    let rtt = nowMs - msg.clientMs;
    if (rtt < 0) rtt += 0x100000000;
    World.rtt = rtt;
    // Re-anchor clock: est. server tick now = pong.serverTick + (rtt/2)/STEP_MS.
    World.serverTickAtSync = msg.serverTick + (rtt / 2) / C.STEP_MS;
    World.clientMsAtSync = performance.now();
    World.hasClock = true;
  },

  // --- input senders ---
  sendTarget(x, y) { this.send(Protocol.encInputTarget(x, y)); },
  sendSplit() { this.send(Protocol.encSplit()); },
  sendEject() { this.send(Protocol.encEject()); },
  sendRespawn() { this.send(Protocol.encRespawn()); },
  sendNick(name) { this.send(Protocol.encSetNick(name)); },
};
