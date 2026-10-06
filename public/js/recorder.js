(function () {
  "use strict";

  let mediaRecorder = null;
  let stream = null;
  let chunks = [];
  let startTime = 0;
  let timerInterval = null;
  let cancelled = false;
  let audioCtx = null;
  let analyser = null;
  let rafId = null;
  let recordedMimeType = "audio/webm";
  let pausedAccumMs = 0;
  let pauseStartedAt = 0;

  const bar = document.getElementById("recording-bar");
  const waveEl = document.getElementById("recording-wave");
  const timeEl = document.getElementById("recording-time");
  const cancelBtn = document.getElementById("btn-cancel-recording");

  const BAR_COUNT = 40;
  const barEls = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const span = document.createElement("span");
    span.style.height = "4px";
    waveEl.appendChild(span);
    barEls.push(span);
  }

  function formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  /** Pulls real amplitude data from the mic via Web Audio's AnalyserNode so
   * the bars reflect actual volume instead of random noise. */
  function drawLiveWaveform() {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);

    // Downsample the time-domain buffer into BAR_COUNT chunks and use each
    // chunk's peak deviation from silence (128) as that bar's height.
    const chunkSize = Math.floor(data.length / BAR_COUNT) || 1;
    for (let i = 0; i < BAR_COUNT; i++) {
      let peak = 0;
      const offset = i * chunkSize;
      for (let j = 0; j < chunkSize; j++) {
        const v = Math.abs(data[offset + j] - 128);
        if (v > peak) peak = v;
      }
      const height = Math.max(4, Math.min(24, (peak / 128) * 46));
      barEls[i].style.height = height + "px";
    }
    rafId = requestAnimationFrame(drawLiveWaveform);
  }

  function pickSupportedMimeType() {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    for (const type of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) return type;
    }
    return ""; // let the browser pick its own default
  }

  async function start() {
    // Defense in depth: if a previous session's MediaRecorder/stream is
    // still alive (recording *or* paused) when start() is called again —
    // whatever UI guard should have prevented that didn't — force it closed
    // first instead of overwriting the module-level references and leaking
    // the old mic stream/AudioContext/timer forever.
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      cancelled = true;
      try { mediaRecorder.stop(); } catch (e) { /* already stopping/stopped */ }
      cleanup();
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      EchoToast.error("Microphone access is required to record a voice note.");
      throw err;
    }
    chunks = [];
    cancelled = false;
    pausedAccumMs = 0;

    const mimeType = pickSupportedMimeType();
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recordedMimeType = mediaRecorder.mimeType || mimeType || "audio/webm";
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    // Live waveform via Web Audio, wired to the same mic stream.
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    drawLiveWaveform();

    mediaRecorder.start();
    startTime = Date.now();
    bar.classList.add("active");
    timerInterval = setInterval(() => { timeEl.textContent = formatTime(Date.now() - startTime - pausedAccumMs); }, 200);
  }

  function pause() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.pause();
      pauseStartedAt = Date.now();
      clearInterval(timerInterval);
      if (rafId) cancelAnimationFrame(rafId);
    }
  }

  function resume() {
    if (mediaRecorder && mediaRecorder.state === "paused") {
      pausedAccumMs += Date.now() - pauseStartedAt;
      mediaRecorder.resume();
      timerInterval = setInterval(() => { timeEl.textContent = formatTime(Date.now() - startTime - pausedAccumMs); }, 200);
      drawLiveWaveform();
    }
  }

  function stop() {
    return new Promise((resolve) => {
      if (!mediaRecorder || mediaRecorder.state === "inactive") return resolve(null);
      mediaRecorder.onstop = () => {
        const type = recordedMimeType;
        cleanup();
        if (cancelled) return resolve(null);
        const blob = new Blob(chunks, { type });
        resolve({ blob, mimeType: type });
      };
      mediaRecorder.stop();
    });
  }

  function cancel() {
    cancelled = true;
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    else cleanup();
  }

  function cleanup() {
    clearInterval(timerInterval);
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    bar.classList.remove("active");
    timeEl.textContent = "0:00";
    barEls.forEach((b) => (b.style.height = "4px"));
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    analyser = null;
  }

  cancelBtn.addEventListener("click", () => cancel());

  window.EchoRecorder = {
    start,
    stop,
    cancel,
    pause,
    resume,
    isRecording: () => !!mediaRecorder && mediaRecorder.state === "recording",
    isPaused: () => !!mediaRecorder && mediaRecorder.state === "paused",
  };
})();
