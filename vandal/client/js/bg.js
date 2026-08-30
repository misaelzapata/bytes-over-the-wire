"use strict";
// VANDAL — bg.js. Lets the player choose the painting SURFACE: the default
// clean-vector brick wall, one of the bundled CC0 real wall photos, an image
// URL, or an uploaded file. Whatever is picked becomes the mural background;
// paint (and the eraser) sit on top of it. Vector brick stays the default so
// the game still works fully offline.

const BG = {
  panel: null,
  btn: null,
  svPanel: null,
  svBtn: null,

  init() {
    this.panel = document.getElementById("bgPanel");
    this.btn = document.getElementById("bgBtn");
    if (this.btn) this.btn.addEventListener("click", (e) => { e.stopPropagation(); this.toggle(); });
    this._initStreetView();

    document.querySelectorAll("[data-bg]").forEach((el) => {
      el.addEventListener("click", () => this.pick(el.getAttribute("data-bg"), el));
    });

    const urlBtn = document.getElementById("bgUrlBtn");
    const urlInput = document.getElementById("bgUrl");
    if (urlBtn && urlInput) {
      const setUrl = () => { const u = urlInput.value.trim(); if (u) { Scene.setImage(u, "url"); this._active(null); this.close(); } };
      urlBtn.addEventListener("click", setUrl);
      urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") setUrl(); });
    }

    const file = document.getElementById("bgFile");
    if (file) {
      file.addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => { Scene.setImage(rd.result, "file"); this._active(null); this.close(); };
        rd.readAsDataURL(f);
      });
    }

    document.addEventListener("click", (e) => {
      if (this.panel && !this.panel.classList.contains("hidden") && !this.panel.contains(e.target) && !(this.btn && this.btn.contains(e.target))) this.close();
      if (this.svPanel && !this.svPanel.classList.contains("hidden") && !this.svPanel.contains(e.target) && !(this.svBtn && this.svBtn.contains(e.target))) this.svClose();
    });
  },

  // --- Street View / Map: paint graffiti on a real place --------------------
  _initStreetView() {
    this.svPanel = document.getElementById("svPanel");
    this.svBtn = document.getElementById("svBtn");
    if (this.svBtn) this.svBtn.addEventListener("click", (e) => { e.stopPropagation(); this.svToggle(); });
    if (!this.svPanel) return;

    const addr = document.getElementById("svAddr");
    const go = document.getElementById("svGo");
    const note = document.getElementById("svNote");
    const enabled = (typeof window !== "undefined" && window.MAPS_ENABLED === true);

    const loadAddress = () => {
      const a = (addr && addr.value || "").trim();
      if (!a) return;
      if (!enabled) {
        this.svSetNote("Live address lookup needs a Maps API key — paste a Street View image URL or upload a screenshot below.");
        return;
      }
      const heading = valOf("svHeading"), pitch = valOf("svPitch"), fov = valOf("svFov");
      const q = "location=" + encodeURIComponent(a) + "&heading=" + heading + "&pitch=" + pitch + "&fov=" + fov + "&size=640x640";
      this.svSetNote("Loading Street View…");
      // One request through the same-origin proxy (the key stays server-side).
      // On success stream the JPEG into an object URL and paint on it; on
      // failure show the proxy's clear status.
      fetch("/streetview?" + q).then(async (r) => {
        const ct = r.headers.get("content-type") || "";
        if (r.ok && ct.indexOf("image") === 0) {
          const obj = URL.createObjectURL(await r.blob());
          Scene.setImage(obj, "streetview");
          this.svSetNote("Painting on: " + a);
          this.svClose();
        } else {
          const t = (await r.text().catch(() => "")).trim();
          const s = t.replace(/^streetview-/, "");
          if (t === "maps-key-missing" || s === "request_denied" || s === "over_query_limit") {
            this.svSetNote("Live lookup unavailable (" + (s || "no key") + ") — paste a Street View image URL or upload a screenshot below.");
          } else if (s === "zero_results" || s === "not_found") {
            this.svSetNote("No Street View imagery there. Try another address, or paste a URL / upload.");
          } else {
            this.svSetNote("Street View unavailable (" + (s || "error") + ") — paste a URL or upload a screenshot.");
          }
        }
      }).catch(() => this.svSetNote("Street View request failed — paste a URL or upload a screenshot."));
    };
    if (go) go.addEventListener("click", loadAddress);
    if (addr) addr.addEventListener("keydown", (e) => { if (e.key === "Enter") loadAddress(); });

    // "Mi ubicación / Aquí" — use the device GPS so people paint the Street View
    // of where they REALLY are (not anywhere they like).
    const here = document.getElementById("svHere");
    if (here) here.addEventListener("click", () => this.svUseMyLocation());

    const urlBtn = document.getElementById("svUrlBtn");
    const urlInput = document.getElementById("svUrl");
    if (urlBtn && urlInput) {
      const setUrl = () => { const u = urlInput.value.trim(); if (u) { Scene.setImage(u, "sv-url"); this.svSetNote("Painting on pasted image."); this.svClose(); } };
      urlBtn.addEventListener("click", setUrl);
      urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") setUrl(); });
    }
    const file = document.getElementById("svFile");
    if (file) {
      file.addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => { Scene.setImage(rd.result, "sv-file"); this.svClose(); };
        rd.readAsDataURL(f);
      });
    }
    if (!enabled) this.svSetNote("Live address lookup needs a Maps API key — paste a Street View image URL or upload a screenshot.");
  },

  // Geolocation flow: ask the browser for the real lat,lng (secure context —
  // works on localhost + https), then load the Street View of that exact spot
  // through the same-origin proxy. Every failure path (no geolocation API,
  // permission denied, no Maps key, Street View API not enabled / non-image
  // body, network error) falls back to the manual paste/upload flow with a
  // short honest note. We detect a non-image response by its content-type
  // BEFORE ever setting it as the background.
  svUseMyLocation() {
    const FALLBACK = "Street View no disponible — pegá una imagen o subí una foto.";
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      this.svSetNote("Geolocalización no disponible en este navegador — pegá una imagen o subí una foto.");
      return;
    }
    const enabled = (typeof window !== "undefined" && window.MAPS_ENABLED === true);
    this.svSetNote("Buscando tu ubicación…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        const loc = lat.toFixed(6) + "," + lng.toFixed(6);
        if (!enabled) {
          // No server-side Maps key: can't reach Street View. Be honest + fall back.
          this.svSetNote(FALLBACK);
          return;
        }
        this.svSetNote("Cargando Street View de tu ubicación…");
        const heading = valOf("svHeading") || "0";
        const pitch = valOf("svPitch") || "0";
        const fov = valOf("svFov") || "80";
        const q = "location=" + encodeURIComponent(loc) + "&heading=" + heading + "&pitch=" + pitch + "&fov=" + fov + "&size=640x640";
        fetch("/streetview?" + q).then(async (r) => {
          const ct = r.headers.get("content-type") || "";
          // Only an actual image becomes the background. The proxy returns a
          // 200 text/plain status body ("streetview-request_denied", etc.) when
          // the Street View Static API is off — that must NOT be drawn as a bg.
          if (r.ok && ct.indexOf("image") === 0) {
            const obj = URL.createObjectURL(await r.blob());
            Scene.setImage(obj, "streetview");
            this.svSetNote("Pintando sobre tu ubicación (" + loc + ").");
            this.svClose();
          } else {
            this.svSetNote(FALLBACK);
          }
        }).catch(() => this.svSetNote(FALLBACK));
      },
      (err) => {
        // PERMISSION_DENIED (1), POSITION_UNAVAILABLE (2), TIMEOUT (3)
        const denied = err && err.code === 1;
        this.svSetNote(denied
          ? "Permiso de ubicación denegado — " + FALLBACK
          : "No pudimos obtener tu ubicación — " + FALLBACK);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  },

  svSetNote(t) { const n = document.getElementById("svNote"); if (n) n.textContent = t || ""; },
  svToggle() { if (this.svPanel) { this.svPanel.classList.toggle("hidden"); this.close(); } },
  svClose() { if (this.svPanel) this.svPanel.classList.add("hidden"); },
  onImageLoaded(key) { if (key === "streetview" && this._svPending) this.svSetNote("Painting on: " + this._svPending); },

  pick(key, el) {
    if (key === "vector") Scene.setVector();
    else Scene.setImage("img/" + key, key);
    this._active(el);
    this.close();
  },

  _active(el) {
    document.querySelectorAll("[data-bg]").forEach((x) => x.classList.remove("active"));
    if (el) el.classList.add("active");
  },

  toggle() { if (this.panel) this.panel.classList.toggle("hidden"); },
  close() { if (this.panel) this.panel.classList.add("hidden"); },

  flashError() {
    const n = document.getElementById("bgNote");
    if (n) { n.textContent = "Couldn't load that image — kept brick."; setTimeout(() => { n.textContent = ""; }, 2600); }
  },
};

function valOf(id) { const el = document.getElementById(id); return el ? encodeURIComponent(el.value) : ""; }
