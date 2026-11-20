import "./styles/tokens.css";
import "./styles/app.css";

import { buildChunks, type Chunk } from "./pdf/extract";
import { openPdf, Viewer } from "./pdf/viewer";
import { DEFAULT_KOKORO_VOICE, KOKORO_VOICES } from "./tts/kokoro";
import { englishVoices, onVoicesChanged, Reader, type Engine } from "./tts/reader";
import { bindShortcuts } from "./ui/controls";
import { isPdf, setupDropzone } from "./ui/dropzone";
import { clampRate, formatRate, loadSettings, saveSettings, RATE_MAX, RATE_MIN } from "./ui/settings";
import { applyTheme, effectiveTheme, type Theme } from "./ui/theme";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const app = $("app");
const scroller = $("scroller");
const pagesEl = $("pages");
const playBtn = $<HTMLButtonElement>("play");
const speedSlider = $<HTMLInputElement>("speed");
const voiceSelect = $<HTMLSelectElement>("voice");
const pageReadout = $("page-readout");
const dropTitle = $("drop-title");
const dropSub = $("drop-sub");
const dropBar = $("drop-bar");

const settings = loadSettings();
const viewer = new Viewer(scroller, pagesEl);
const reader = new Reader();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let chunks: Chunk[] = [];
let spanToChunk = new Map<string, number>();
let highlighted: HTMLElement[] = [];
let anchor = 0; // where Stop returns to: document start or the sentence the user clicked
let loadToken = 0;
let userScrollUntil = 0;

/* ---------------- Settings & theme ---------------- */

function persist(): void {
  saveSettings(settings);
}

function setTheme(theme: Theme): void {
  settings.theme = theme;
  applyTheme(theme);
  document.querySelectorAll<HTMLButtonElement>("#theme button").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.value === theme));
  });
  persist();
}

function setDimPages(on: boolean): void {
  settings.dimPages = on;
  if (on) delete document.documentElement.dataset.dimPages;
  else document.documentElement.dataset.dimPages = "off";
  persist();
}

let rateTimer = 0;
function setRate(rate: number, immediate = false): void {
  settings.rate = clampRate(rate);
  const label = formatRate(settings.rate);
  $("speed-value").textContent = label;
  $("speed-readout").textContent = label;
  speedSlider.value = String(settings.rate);
  speedSlider.style.setProperty("--fill", `${((settings.rate - RATE_MIN) / (RATE_MAX - RATE_MIN)) * 100}%`);
  persist();
  // System voices restart the sentence on a rate change; wait for the user to settle.
  clearTimeout(rateTimer);
  const apply = () => reader.rate !== settings.rate && reader.setRate(settings.rate);
  if (immediate || reader.engine === "kokoro") apply();
  else rateTimer = window.setTimeout(apply, 250);
}

/* ---------------- Voices ---------------- */

/** Parse a saved voice setting into an engine + voice. */
function resolveVoice(value: string): { engine: Engine; voice: string | SpeechSynthesisVoice | null } {
  if (value.startsWith("system:")) {
    const uri = value.slice("system:".length);
    const voices = englishVoices();
    return { engine: "system", voice: voices.find((v) => v.voiceURI === uri) ?? voices[0] ?? null };
  }
  const id = value.slice("kokoro:".length);
  return { engine: "kokoro", voice: KOKORO_VOICES.some((v) => v.id === id) ? id : DEFAULT_KOKORO_VOICE };
}

function applyVoice(value: string): void {
  settings.voice = value;
  persist();
  const { engine, voice } = resolveVoice(value);
  reader.setVoice(engine, voice);
  if (engine === "kokoro") void reader.kokoro.load().catch(() => {});
  renderVoiceStatus();
}

function populateVoices(): void {
  const hd = document.createElement("optgroup");
  hd.label = "Natural voices (HD)";
  for (const v of KOKORO_VOICES) hd.append(new Option(v.label, `kokoro:${v.id}`));

  const sys = document.createElement("optgroup");
  sys.label = "System voices";
  for (const v of englishVoices()) {
    const name = v.name.replace(/^Microsoft\s+/, "").replace(/\s+-\s+English.*$/, "");
    sys.append(new Option(`${name} · ${v.lang}`, `system:${v.voiceURI}`));
  }
  voiceSelect.replaceChildren(hd, ...(sys.children.length ? [sys] : []));
  voiceSelect.value = settings.voice;
  if (voiceSelect.selectedIndex < 0) voiceSelect.selectedIndex = 0;

  // System voices load asynchronously; only (re)apply when the choice actually changes.
  const { engine, voice } = resolveVoice(settings.voice);
  const same =
    engine === reader.engine &&
    (engine === "kokoro"
      ? voice === reader.kokoroVoice
      : (voice as SpeechSynthesisVoice | null)?.voiceURI === reader.systemVoice?.voiceURI);
  if (!same) reader.setVoice(engine, voice);
}

/** Status for the neural voice: download progress, errors. */
function renderVoiceStatus(): void {
  const k = reader.kokoro;
  const pct = Math.round(k.progress * 100);
  const downloading = k.status === "loading" && k.progress > 0 && k.progress < 1;

  let pill = "";
  if (reader.engine === "kokoro" && k.status === "loading") {
    pill = downloading ? `DOWNLOADING HD VOICE · ${pct}% · ONE TIME ONLY` : "PREPARING HD VOICE";
  }
  const el = $("voice-status");
  el.textContent = pill;
  el.classList.toggle("show", !!pill);

  $("settings-voice-note").textContent =
    k.status === "ready"
      ? `HD VOICE READY · RUNS OFFLINE · ${k.threads} CPU THREAD${k.threads === 1 ? "" : "S"}`
      : k.status === "loading"
        ? downloading
          ? `DOWNLOADING HD VOICE · ${pct}%`
          : "PREPARING HD VOICE"
        : k.status === "error"
          ? "HD VOICE FAILED TO LOAD · CHECK YOUR CONNECTION"
          : "HD VOICES DOWNLOAD ONCE (ABOUT 90 MB), THEN WORK OFFLINE";
}

/* ---------------- Settings panel ---------------- */

function openSettings(): void {
  app.classList.add("settings-open");
  $("settings").setAttribute("aria-hidden", "false");
  $("settings").focus({ preventScroll: true });
}

function closeSettings(): boolean {
  if (!app.classList.contains("settings-open")) return false;
  app.classList.remove("settings-open");
  $("settings").setAttribute("aria-hidden", "true");
  return true;
}

/* ---------------- Toast ---------------- */

let toastTimer = 0;
function toast(msg: string, ms = 2600): void {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), ms);
}

/* ---------------- Opening files ---------------- */

function resetDropzone(): void {
  dropTitle.textContent = "DROP PDF HERE";
  dropSub.textContent = "OR CLICK TO BROWSE";
  dropBar.style.width = "0%";
}

function closeDoc(): void {
  loadToken++;
  reader.stop();
  clearHighlight();
  viewer.clear();
  chunks = [];
  spanToChunk = new Map();
  $("filename").textContent = "";
  document.title = "Lector";
  resetDropzone();
  app.dataset.state = "empty";
}

async function openFile(file: File): Promise<void> {
  if (!isPdf(file)) {
    if (app.dataset.state === "ready") toast("ONLY PDF FILES ARE SUPPORTED");
    else {
      app.dataset.state = "error";
      dropTitle.textContent = "NOT A PDF";
      dropSub.textContent = "DROP A .PDF FILE · OR CLICK TO BROWSE";
    }
    return;
  }

  closeDoc();
  const token = loadToken;
  app.dataset.state = "loading";
  dropTitle.textContent = "OPENING";
  dropSub.textContent = file.name;

  try {
    const loaded = await openPdf(await file.arrayBuffer(), (f) => {
      if (token !== loadToken) return;
      dropBar.style.width = `${Math.round(f * 100)}%`;
      dropTitle.textContent = `LOADING PAGES ${Math.round(f * 100)}%`;
    });
    if (token !== loadToken) {
      void loaded.doc.loadingTask.destroy();
      return;
    }

    // Let the label repaint before the (short) text preparation step.
    dropTitle.textContent = "PREPARING TEXT";
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    if (token !== loadToken) {
      void loaded.doc.loadingTask.destroy();
      return;
    }
    chunks = buildChunks(loaded.text, loaded.pages.map((p) => p.view));
    spanToChunk = new Map();
    chunks.forEach((c, i) => {
      for (const p of c.parts) {
        const key = `${p.page}:${p.item}`;
        if (!spanToChunk.has(key)) spanToChunk.set(key, i);
      }
    });
    reader.load(chunks);
    anchor = 0;

    app.dataset.state = "ready";
    viewer.setDoc(loaded);
    const name = file.name.replace(/\.pdf$/i, "");
    $("filename").textContent = name;
    document.title = `${name} — Lector`;
    updatePageReadout();
    scroller.focus({ preventScroll: true });

    if (!chunks.length) toast("NO READABLE TEXT IN THIS PDF — IT MAY BE A SCANNED IMAGE", 5000);
  } catch (err) {
    if (token !== loadToken) return;
    console.error(err);
    app.dataset.state = "error";
    dropBar.style.width = "0%";
    dropTitle.textContent = "COULD NOT OPEN FILE";
    dropSub.textContent =
      (err as Error)?.name === "PasswordException"
        ? "THIS PDF IS PASSWORD-PROTECTED"
        : "THE FILE MAY BE DAMAGED · CLICK TO TRY ANOTHER";
  }
}

/* ---------------- Reading: highlight, follow, controls ---------------- */

function clearHighlight(): void {
  for (const el of highlighted) el.classList.remove("speaking");
  highlighted = [];
}

function highlight(index: number): void {
  clearHighlight();
  const chunk = chunks[index];
  if (!chunk) return;
  for (const ref of chunk.parts) {
    const el = viewer.getSpan(ref);
    if (el) {
      el.classList.add("speaking");
      highlighted.push(el);
    }
  }
}

function follow(index: number): void {
  const chunk = chunks[index];
  if (!chunk || !settings.autoScroll || Date.now() < userScrollUntil) return;
  const h = scroller.clientHeight;
  const top = viewer.yOf(chunk.parts[0]);
  const bottom = viewer.yOf(chunk.parts[chunk.parts.length - 1]) + 28;
  const relTop = top - scroller.scrollTop;
  const relBottom = bottom - scroller.scrollTop;
  // Only move when the sentence drifts out of the comfortable reading band.
  if (relTop < h * 0.12 || relBottom > h * 0.66) {
    scroller.scrollTo({ top: Math.max(0, top - h * 0.3), behavior: reducedMotion.matches ? "auto" : "smooth" });
  }
}

function togglePlay(): void {
  if (!chunks.length) {
    toast("NO READABLE TEXT IN THIS PDF");
    return;
  }
  if (reader.state === "idle") {
    // Start where the user is looking if they've scrolled away from the start point.
    const visible = viewer.pageAtScroll();
    let from = reader.index;
    if (chunks[from]?.page !== visible) {
      const i = chunks.findIndex((c) => c.page >= visible);
      if (i >= 0) from = anchor = i;
    }
    userScrollUntil = 0;
    reader.play(from);
  } else {
    if (reader.state === "paused") userScrollUntil = 0;
    reader.toggle();
  }
}

function stop(): void {
  if (reader.state === "idle" && !highlighted.length) return;
  reader.stop(anchor);
  clearHighlight();
}

reader.on("chunk", (i) => {
  highlight(i);
  follow(i);
});
reader.on("state", (s) => {
  app.dataset.playing = s === "playing" ? "1" : "";
  playBtn.setAttribute("aria-label", s === "playing" ? "Pause" : "Play");
});
reader.on("end", () => {
  clearHighlight();
  anchor = 0;
  toast("END OF DOCUMENT");
});
reader.on("buffering", (waiting) => app.classList.toggle("buffering", waiting));
reader.on("error", (msg, engine) => {
  if (engine === "kokoro" && reader.kokoro.status === "error" && Reader.systemSupported) {
    // Neural voice couldn't load (e.g. offline on first run): keep reading with a system voice.
    reader.setVoice("system", englishVoices()[0] ?? null);
    renderVoiceStatus();
    toast("HD VOICE UNAVAILABLE · USING SYSTEM VOICE FOR NOW", 4000);
    reader.play();
    return;
  }
  toast(msg.toUpperCase(), 4000);
});
reader.kokoro.onStatus = renderVoiceStatus;

viewer.onPageText = (page) => {
  // A page's text layer just appeared — highlight the current sentence on it, if any.
  if (reader.state === "idle") return;
  const chunk = chunks[reader.index];
  if (chunk?.parts.some((p) => p.page === page)) highlight(reader.index);
};

/* ---------------- Scrolling & page readout ---------------- */

function updatePageReadout(): void {
  const n = viewer.pageCount;
  pageReadout.textContent = n ? `PAGE ${viewer.pageAtScroll() + 1} / ${n}` : "";
}

let scrollRaf = 0;
scroller.addEventListener(
  "scroll",
  () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      updatePageReadout();
    });
  },
  { passive: true },
);

const userScrolled = () => (userScrollUntil = Date.now() + 4000);
scroller.addEventListener("wheel", userScrolled, { passive: true });
scroller.addEventListener("touchmove", userScrolled, { passive: true });
scroller.addEventListener("pointerdown", (e) => {
  if (e.target === scroller) userScrolled(); // grabbing the scrollbar
});

// Click a sentence to read from there.
pagesEl.addEventListener("click", (e) => {
  const span = (e.target as HTMLElement).closest<HTMLElement>(".textLayer span[data-i]");
  if (!span) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return; // user is selecting text
  const page = Number(span.closest<HTMLElement>(".page")?.dataset.index);
  const index = spanToChunk.get(`${page}:${span.dataset.i}`);
  if (index === undefined) return;
  anchor = index;
  userScrollUntil = 0;
  reader.play(index);
});

/* ---------------- Wiring ---------------- */

setupDropzone({
  app,
  box: $("drop-box"),
  input: $<HTMLInputElement>("file-input"),
  onFile: (f) => void openFile(f),
});

playBtn.addEventListener("click", togglePlay);
$("stop").addEventListener("click", stop);
$("close-doc").addEventListener("click", closeDoc);
$("open-file").addEventListener("click", () => $<HTMLInputElement>("file-input").click());
$("speed-readout").addEventListener("click", openSettings);
$("settings-open").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", closeSettings);
$("scrim").addEventListener("click", closeSettings);
$("theme-toggle").addEventListener("click", () => setTheme(effectiveTheme() === "dark" ? "light" : "dark"));

speedSlider.addEventListener("input", () => setRate(Number(speedSlider.value)));
speedSlider.addEventListener("change", () => setRate(Number(speedSlider.value), true));

voiceSelect.addEventListener("change", () => applyVoice(voiceSelect.value));

let previewAudio: HTMLAudioElement | null = null;
$("voice-test").addEventListener("click", async () => {
  reader.pause();
  window.speechSynthesis?.cancel();
  previewAudio?.pause();
  const line = `Hello. This is how I sound at ${settings.rate.toFixed(1)} times speed.`;
  if (reader.engine === "kokoro") {
    try {
      const url = await reader.kokoro.audio(line, reader.kokoroVoice);
      previewAudio = new Audio(url);
      previewAudio.preservesPitch = true;
      previewAudio.playbackRate = settings.rate;
      void previewAudio.play();
    } catch {
      toast("HD VOICE IS NOT READY YET");
    }
    return;
  }
  if (!Reader.systemSupported) return toast("SPEECH IS NOT AVAILABLE ON THIS SYSTEM");
  const u = new SpeechSynthesisUtterance(line);
  u.rate = settings.rate;
  if (reader.systemVoice) {
    u.voice = reader.systemVoice;
    u.lang = reader.systemVoice.lang;
  }
  speechSynthesis.speak(u);
});

document.querySelectorAll<HTMLButtonElement>("#theme button").forEach((b) => {
  b.addEventListener("click", () => setTheme(b.dataset.value as Theme));
});

const autoScrollBox = $<HTMLInputElement>("autoscroll");
autoScrollBox.addEventListener("change", () => {
  settings.autoScroll = autoScrollBox.checked;
  persist();
  if (settings.autoScroll && reader.state === "playing") follow(reader.index);
});

const dimBox = $<HTMLInputElement>("dimpages");
dimBox.addEventListener("change", () => setDimPages(dimBox.checked));

bindShortcuts({
  isDocOpen: () => app.dataset.state === "ready",
  togglePlay,
  stop,
  nudgeRate: (d) => setRate(settings.rate + d),
  closeSettings,
  userScrolled,
  openFile: () => $<HTMLInputElement>("file-input").click(),
});

window.addEventListener("beforeunload", () => window.speechSynthesis?.cancel());

/* ---------------- Init ---------------- */

setTheme(settings.theme);
setDimPages(settings.dimPages);
setRate(settings.rate, true);
reader.rate = settings.rate;
autoScrollBox.checked = settings.autoScroll;
dimBox.checked = settings.dimPages;
{
  const { engine, voice } = resolveVoice(settings.voice);
  reader.setVoice(engine, voice);
}
onVoicesChanged(populateVoices);
renderVoiceStatus();
// Warm up the neural voice in the background so it's ready by the time you press Play.
if (reader.engine === "kokoro") void reader.kokoro.load().catch(() => {});
requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove("preload")));

// Diagnostics build only (VITE_DIAG=1, never in release): time the voice engine and
// report to a local log server so the desktop build can be verified automatically.
if (import.meta.env.VITE_DIAG) {
  const report = (msg: string) => {
    fetch(`http://127.0.0.1:4176/diag?${encodeURIComponent(msg)}`, { mode: "no-cors" }).catch(() => {});
  };
  void (async () => {
    // Big-document check: load a test book from the log server and time it.
    try {
      const t0 = performance.now();
      const blob = await (await fetch("http://127.0.0.1:4176/book.pdf")).blob();
      report(`book fetched ${blob.size} bytes`);
      const watch = setInterval(() => report(`book: ${dropTitle.textContent}`), 2000);
      await openFile(new File([blob], "book.pdf", { type: "application/pdf" }));
      clearInterval(watch);
      report(`book state=${app.dataset.state} sentences=${chunks.length} pages=${viewer.pageCount} in ${Math.round(performance.now() - t0)}ms`);
    } catch (e) {
      report(`book error ${(e as Error).message}`);
    }
    const k = reader.kokoro;
    k.trace = (step) => report(`step ${step}`);
    document.addEventListener("securitypolicyviolation", (e) =>
      report(`CSP blocked ${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`),
    );
    const tick = setInterval(() => report(`status=${k.status} progress=${Math.round(k.progress * 100)} err=${k.error}`), 3000);
    try {
      const t0 = performance.now();
      await k.load();
      report(`native=${k.native} ready in ${Math.round(performance.now() - t0)}ms`);
      const lines = [
        "The quick brown fox jumps over the lazy dog while engineers prepare the next launch.",
        "Electric cars glide silently across open highways under a sky full of bright stars.",
        "This third sentence checks that steady reading keeps well ahead of real time playback.",
      ];
      for (const line of lines) {
        const t = performance.now();
        const url = await k.audio(line, "af_heart");
        const a = new Audio(url);
        await new Promise((r) => a.addEventListener("loadedmetadata", r, { once: true }));
        report(`gen ${Math.round(performance.now() - t)}ms for ${a.duration.toFixed(2)}s of audio`);
      }
    } catch (e) {
      report(`error ${(e as Error).message}`);
    }
    clearInterval(tick);
  })();
}
