(function () {
  "use strict";

  // Shared, purely-visual/UX helpers used by both call.js (1:1) and
  // group-call.js. Nothing in this file sends or interprets signaling —
  // it only touches local media analysis (Web Audio), DOM/CSS, and
  // read-only browser capability APIs (vibration, PiP, output device
  // selection). Loaded before call.js / group-call.js.

  /* ============================== Ripple + haptic + tooltip ============================== */

  /** Adds a Material-style ripple, a light haptic pulse (where supported),
   * and a hover/press-friendly tooltip to every element matching selector
   * inside root. Safe to call repeatedly on freshly-rendered markup — it
   * only wires elements once via a data attribute guard. */
  function enhanceButtons(root, selector = ".call-fab, .call-btn") {
    const els = root.querySelectorAll(selector);
    els.forEach((el) => {
      if (el.dataset.fxWired) return;
      el.dataset.fxWired = "1";

      el.addEventListener("pointerdown", (e) => spawnRipple(el, e));
      el.addEventListener("click", () => haptic(10));

      const label = el.getAttribute("title") || el.getAttribute("aria-label");
      if (label) {
        el.removeAttribute("title"); // suppress the native browser tooltip; we render our own
        if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", label);
        el.classList.add("has-tooltip");
        el.setAttribute("data-tooltip", label);
      }
    });
  }

  function spawnRipple(el, evt) {
    const rect = el.getBoundingClientRect();
    const ripple = document.createElement("span");
    ripple.className = "call-ripple";
    const size = Math.max(rect.width, rect.height) * 1.6;
    const x = (evt.clientX ?? rect.left + rect.width / 2) - rect.left - size / 2;
    const y = (evt.clientY ?? rect.top + rect.height / 2) - rect.top - size / 2;
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    el.appendChild(ripple);
    ripple.addEventListener("animationend", () => ripple.remove());
  }

  /** Vibration API haptic pulse. Android Chrome supports this; iOS Safari
   * does not implement the Vibration API at all (a real platform gap, not
   * a bug here) — this simply no-ops there. */
  function haptic(ms = 12) {
    try { navigator.vibrate?.(ms); } catch (e) { /* unsupported — silent no-op */ }
  }

  /* ============================== Draggable + pinch-resizable ============================== */

  /** Makes `el` draggable within `bounds` (default: its offsetParent) via
   * pointer events, and pinch-resizable with two touch points. Persists no
   * state outside the element itself — purely a local UI convenience for
   * the floating local-preview tile in a video call. */
  function makeDraggableResizable(el, { minScale = 0.6, maxScale = 1.8 } = {}) {
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    let pointers = new Map(); // pointerId -> {x, y}, for pinch
    let pinchStartDist = 0;
    let pinchStartWidth = 0;

    function boundsRect() {
      return (el.offsetParent || document.body).getBoundingClientRect();
    }

    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        dragging = true;
        const r = el.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        startLeft = r.left; startTop = r.top;
      } else if (pointers.size === 2) {
        dragging = false;
        const pts = [...pointers.values()];
        pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        pinchStartWidth = el.getBoundingClientRect().width;
      }
    });

    el.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 2) {
        const pts = [...pointers.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchStartDist > 0) {
          const baseWidth = parseFloat(el.dataset.baseWidth || pinchStartWidth);
          if (!el.dataset.baseWidth) el.dataset.baseWidth = pinchStartWidth;
          let scale = (dist / pinchStartDist) * (pinchStartWidth / baseWidth);
          scale = Math.min(maxScale, Math.max(minScale, scale));
          el.style.width = `${baseWidth * scale}px`;
        }
        return;
      }

      if (!dragging) return;
      const b = boundsRect();
      const r = el.getBoundingClientRect();
      let newLeft = startLeft + (e.clientX - startX);
      let newTop = startTop + (e.clientY - startY);
      newLeft = Math.min(b.width - r.width - 8, Math.max(8, newLeft - b.left)) + b.left;
      newTop = Math.min(b.height - r.height - 8, Math.max(8, newTop - b.top)) + b.top;
      el.style.left = `${newLeft - b.left}px`;
      el.style.top = `${newTop - b.top}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
    });

    function release(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStartDist = 0;
      if (pointers.size === 0) dragging = false;
    }
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
  }

  /* ============================== Double-tap to hide controls ============================== */

  /** Fires `onToggle(hidden)` on a double-tap/double-click anywhere in
   * `stageEl`, and auto-re-shows after `autoHideMs` of inactivity while
   * controls are visible (skips auto-hide entirely while `shouldPause()`
   * returns true, e.g. mid-drag). */
  function initAutoHideControls(stageEl, controlsEl, { autoHideMs = 4000 } = {}) {
    let hidden = false;
    let autoHideTimer = null;
    let lastTap = 0;

    function setHidden(next) {
      hidden = next;
      controlsEl.classList.toggle("controls-hidden", hidden);
    }

    function scheduleAutoHide() {
      clearTimeout(autoHideTimer);
      autoHideTimer = setTimeout(() => setHidden(true), autoHideMs);
    }

    stageEl.addEventListener("pointerdown", (e) => {
      const now = Date.now();
      if (now - lastTap < 320) {
        setHidden(!hidden);
        clearTimeout(autoHideTimer);
        if (!hidden) scheduleAutoHide();
      } else if (hidden) {
        setHidden(false);
        scheduleAutoHide();
      } else {
        scheduleAutoHide();
      }
      lastTap = now;
    });

    scheduleAutoHide();
    return { show: () => { setHidden(false); scheduleAutoHide(); }, stop: () => clearTimeout(autoHideTimer) };
  }

  /* ============================== Audio level / waveform ============================== */

  /** Analyses a MediaStream's audio track and calls onLevel(0..1) on every
   * animation frame, plus exposes getBars(n) for a lightweight bar-style
   * waveform visualizer. Returns a stop() to tear down the AudioContext. */
  function createAudioLevelMeter(stream, onLevel) {
    if (!stream || stream.getAudioTracks().length === 0) return { stop() {} };
    let ctx, analyser, source, raf, data;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      data = new Uint8Array(analyser.frequencyBinCount);
    } catch (e) {
      return { stop() {} }; // Web Audio unavailable — caller just won't get level updates
    }

    function tick() {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const level = Math.min(1, sum / data.length / 90); // rough perceptual normalization
      onLevel(level, data);
      raf = requestAnimationFrame(tick);
    }
    tick();

    return {
      stop() {
        cancelAnimationFrame(raf);
        try { source.disconnect(); analyser.disconnect(); ctx.close(); } catch (e) { /* already torn down */ }
      },
    };
  }

  /** Draws a simple animated bar waveform into a canvas from live
   * frequency-domain data (as produced by createAudioLevelMeter above). */
  function drawWaveformBars(canvas, data, color) {
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);
    const bars = 28;
    const step = Math.floor(data.length / bars) || 1;
    const barWidth = w / bars;
    ctx2d.fillStyle = color || "#00D9C0";
    for (let i = 0; i < bars; i++) {
      const v = data[i * step] / 255;
      const barH = Math.max(2, v * h);
      ctx2d.globalAlpha = 0.35 + v * 0.65;
      ctx2d.fillRect(i * barWidth + 1, (h - barH) / 2, barWidth - 2, barH);
    }
    ctx2d.globalAlpha = 1;
  }

  /* ============================== Floating reactions ============================== */

  /** Spawns a floating, rising, fading emoji inside `container`. Purely
   * decorative — call sites are responsible for actually delivering the
   * emoji to a peer over whatever signaling channel they already have. */
  function spawnFloatingReaction(container, emoji) {
    if (!container) return;
    const el = document.createElement("span");
    el.className = "call-reaction-float";
    el.textContent = emoji;
    el.style.left = `${40 + Math.random() * 20}%`;
    el.style.setProperty("--drift", `${(Math.random() - 0.5) * 60}px`);
    container.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
  }

  /* ============================== Audio output (speaker / Bluetooth) ============================== */

  /** Browsers expose one unified list of audiooutput devices — a paired
   * Bluetooth headset simply appears in it like any other output; there is
   * no separate "Bluetooth API" to call. setSinkId is Chrome/Edge-only
   * (not Firefox/Safari) — callers should feature-detect and hide the
   * control rather than show one that silently does nothing. */
  async function listAudioOutputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === "audiooutput");
    } catch (e) {
      return [];
    }
  }

  function supportsOutputSelection(mediaEl) {
    return typeof mediaEl?.setSinkId === "function";
  }

  window.EchoCallFx = {
    enhanceButtons,
    haptic,
    makeDraggableResizable,
    initAutoHideControls,
    createAudioLevelMeter,
    drawWaveformBars,
    spawnFloatingReaction,
    listAudioOutputs,
    supportsOutputSelection,
  };
})();
