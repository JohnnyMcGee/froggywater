"use strict";

// --- Settings (persisted) ---

const STORAGE_KEY = "froggywater";
const SCHEMA_VERSION = 1;

const DEFAULT_SETTINGS = {
  version: SCHEMA_VERSION,
  startBpm: 60,
  endBpm: 120,
  barsPerLoop: 32,
  increment: 1,
  timeSignature: "4/4",
  volume: 80,
  emphasize: true,
};

const LIMITS = {
  startBpm: [20, 300],
  endBpm: [20, 300],
  barsPerLoop: [1, 999],
  increment: [1, 20],
  volume: [0, 100],
};

function clamp(value, [min, max]) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!raw || raw.version !== SCHEMA_VERSION) return { ...DEFAULT_SETTINGS };
    const settings = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(LIMITS)) {
      if (Number.isFinite(raw[key])) settings[key] = clamp(raw[key], LIMITS[key]);
    }
    if (typeof raw.timeSignature === "string" && /^\d+\/\d+$/.test(raw.timeSignature)) {
      settings.timeSignature = raw.timeSignature;
    }
    if (typeof raw.emphasize === "boolean") settings.emphasize = raw.emphasize;
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (private mode, etc.) — the app still works, just without persistence.
  }
}

const settings = loadSettings();

// --- Runtime state (never persisted) ---

const runtime = {
  playing: false,
  sessionActive: false, // true once playback has begun, until Reset
  currentBpm: settings.startBpm,
  beat: 0,
  bar: 0,
  nextNoteTime: 0,
};

// --- Audio ---

let audioCtx = null;
let masterGain = null;
let schedulerTimer = null;
const SCHEDULE_AHEAD = 0.1; // seconds of audio scheduled in advance
const SCHEDULER_INTERVAL = 25; // ms
const pulseQueue = [];

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    masterGain = audioCtx.createGain();
    masterGain.connect(audioCtx.destination);
    applyVolume();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
}

function applyVolume() {
  if (masterGain) masterGain.gain.value = (settings.volume / 100) ** 2;
}

function scheduleClick(time, accent) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = accent ? 1660 : 1000;
  const decay = accent ? 0.09 : 0.04;
  gain.gain.setValueAtTime(1, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + decay);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(time);
  osc.stop(time + decay + 0.02);
}

function beatsPerBar() {
  return parseInt(settings.timeSignature.split("/")[0], 10);
}

function stepTempo() {
  const direction = Math.sign(settings.endBpm - runtime.currentBpm);
  if (direction === 0) return;
  const next = runtime.currentBpm + direction * settings.increment;
  runtime.currentBpm = direction > 0
    ? Math.min(next, settings.endBpm)
    : Math.max(next, settings.endBpm);
}

function advance() {
  runtime.nextNoteTime += 60 / runtime.currentBpm;
  runtime.beat += 1;
  if (runtime.beat >= beatsPerBar()) {
    runtime.beat = 0;
    runtime.bar += 1;
    if (runtime.bar >= settings.barsPerLoop) {
      runtime.bar = 0;
      stepTempo();
    }
  }
}

function scheduler() {
  while (runtime.nextNoteTime < audioCtx.currentTime + SCHEDULE_AHEAD) {
    const accent = runtime.beat === 0;
    scheduleClick(runtime.nextNoteTime, accent && settings.emphasize);
    pulseQueue.push({ time: runtime.nextNoteTime, accent });
    advance();
  }
}

// --- Transport ---

function play() {
  ensureAudio();
  runtime.playing = true;
  runtime.sessionActive = true;
  runtime.nextNoteTime = audioCtx.currentTime + 0.05;
  schedulerTimer = setInterval(scheduler, SCHEDULER_INTERVAL);
  requestAnimationFrame(pulseLoop);
  render();
}

function pause() {
  runtime.playing = false;
  clearInterval(schedulerTimer);
  pulseQueue.length = 0;
  render();
}

function togglePlay() {
  if (runtime.playing) pause();
  else play();
}

function reset() {
  runtime.sessionActive = false;
  runtime.currentBpm = settings.startBpm;
  runtime.beat = 0;
  runtime.bar = 0;
  if (runtime.playing && audioCtx) runtime.nextNoteTime = audioCtx.currentTime + 0.05;
  render();
}

// --- Visual pulse ---

function pulseLoop() {
  if (!runtime.playing) return;
  while (pulseQueue.length && pulseQueue[0].time <= audioCtx.currentTime) {
    const { accent } = pulseQueue.shift();
    els.pulse.classList.remove("is-pulsing", "is-pulsing--accent");
    void els.pulse.offsetWidth; // restart the CSS animation
    els.pulse.classList.add(
      accent && settings.emphasize ? "is-pulsing--accent" : "is-pulsing"
    );
    render();
  }
  requestAnimationFrame(pulseLoop);
}

// --- Tap tempo ---

function makeTapper(onTempo) {
  let taps = [];
  return () => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    if (taps.length < 2) return;
    const recent = taps.slice(-6);
    const avgInterval = (recent[recent.length - 1] - recent[0]) / (recent.length - 1);
    onTempo(clamp(60000 / avgInterval, LIMITS.startBpm));
  };
}

// --- DOM ---

const els = {
  bpm: document.getElementById("hero-bpm"),
  pulse: document.getElementById("hero-pulse"),
  ring: document.getElementById("ring-progress"),
  play: document.getElementById("btn-play"),
  reset: document.getElementById("btn-reset"),
  start: document.getElementById("input-start"),
  end: document.getElementById("input-end"),
  bars: document.getElementById("input-bars"),
  increment: document.getElementById("input-increment"),
  timesig: document.getElementById("input-timesig"),
  volume: document.getElementById("input-volume"),
  emphasize: document.getElementById("input-emphasize"),
  tapStart: document.getElementById("tap-start"),
  tapEnd: document.getElementById("tap-end"),
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 90;

function render() {
  els.bpm.textContent = runtime.currentBpm;
  els.play.textContent = runtime.playing ? "Pause" : "Start";
  const span = settings.endBpm - settings.startBpm;
  const progress = span === 0
    ? 1
    : Math.min(1, Math.max(0, (runtime.currentBpm - settings.startBpm) / span));
  els.ring.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - progress);
}

function renderInputs() {
  els.start.value = settings.startBpm;
  els.end.value = settings.endBpm;
  els.bars.value = settings.barsPerLoop;
  els.increment.value = settings.increment;
  els.timesig.value = settings.timeSignature;
  els.volume.value = settings.volume;
  els.emphasize.checked = settings.emphasize;
}

function setSetting(key, value) {
  settings[key] = value;
  // Before a session starts, the hero display tracks the start tempo live.
  // Mid-session, edits never yank the currently ramping tempo.
  if (key === "startBpm" && !runtime.sessionActive) runtime.currentBpm = value;
  saveSettings();
  renderInputs();
  render();
}

function bindNumberInput(el, key) {
  el.addEventListener("change", () => {
    const value = parseFloat(el.value);
    setSetting(key, Number.isFinite(value) ? clamp(value, LIMITS[key]) : DEFAULT_SETTINGS[key]);
  });
}

bindNumberInput(els.start, "startBpm");
bindNumberInput(els.end, "endBpm");
bindNumberInput(els.bars, "barsPerLoop");
bindNumberInput(els.increment, "increment");

els.timesig.addEventListener("change", () => setSetting("timeSignature", els.timesig.value));

els.volume.addEventListener("input", () => {
  settings.volume = clamp(parseFloat(els.volume.value), LIMITS.volume);
  applyVolume();
  saveSettings();
});

els.emphasize.addEventListener("change", () => setSetting("emphasize", els.emphasize.checked));

const tapStart = makeTapper((bpm) => setSetting("startBpm", bpm));
const tapEnd = makeTapper((bpm) => setSetting("endBpm", bpm));

els.tapStart.addEventListener("click", tapStart);
els.tapEnd.addEventListener("click", tapEnd);
els.play.addEventListener("click", togglePlay);
els.reset.addEventListener("click", reset);

document.addEventListener("keydown", (event) => {
  const tag = event.target.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (event.repeat) return;
  if (event.code === "Space") {
    event.preventDefault(); // keep focused buttons from re-triggering via Space
    togglePlay();
  } else if (event.code === "KeyS") {
    tapStart();
  } else if (event.code === "KeyE") {
    tapEnd();
  }
});

renderInputs();
render();
