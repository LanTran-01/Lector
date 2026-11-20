import type { Chunk } from "../pdf/extract";
import { DEFAULT_KOKORO_VOICE, KokoroEngine } from "./kokoro";

export type ReaderState = "idle" | "playing" | "paused";
export type Engine = "kokoro" | "system";

export interface ReaderEvents {
  chunk: (index: number) => void; // a chunk started being spoken
  state: (state: ReaderState) => void;
  buffering: (waiting: boolean) => void; // waiting for neural audio to be generated
  end: () => void; // reached the end of the document
  error: (message: string, engine: Engine) => void;
}

const synth: SpeechSynthesis | undefined = typeof window !== "undefined" ? window.speechSynthesis : undefined;
const PREFETCH = 3; // sentences generated ahead of the one playing

/**
 * Reads chunks one at a time, either with the Kokoro neural voice (default)
 * or the operating system's voices via the Web Speech API.
 */
export class Reader {
  chunks: Chunk[] = [];
  index = 0;
  state: ReaderState = "idle";
  rate = 1;
  engine: Engine = "kokoro";
  kokoroVoice: string = DEFAULT_KOKORO_VOICE;
  systemVoice: SpeechSynthesisVoice | null = null;
  readonly kokoro = new KokoroEngine();

  private gen = 0; // invalidates callbacks from superseded playback
  private audio = new Audio();
  private audioIndex = -1; // chunk currently loaded into `audio`
  current: SpeechSynthesisUtterance | null = null; // keep a ref: avoids GC dropping onend
  private handlers: Partial<ReaderEvents> = {};

  constructor() {
    this.audio.preload = "auto";
    this.audio.preservesPitch = true;
  }

  static get systemSupported(): boolean {
    return !!synth && typeof SpeechSynthesisUtterance !== "undefined";
  }

  on<K extends keyof ReaderEvents>(event: K, fn: ReaderEvents[K]): void {
    this.handlers[event] = fn;
  }

  load(chunks: Chunk[]): void {
    this.stop();
    this.chunks = chunks;
    this.index = 0;
    this.kokoro.keepOnly([]);
  }

  play(from = this.index): void {
    if (!this.chunks.length) return;
    from = Math.max(0, Math.min(from, this.chunks.length - 1));
    // Resume a paused neural sentence exactly where it stopped.
    if (this.state === "paused" && from === this.index && this.canResumeAudio()) {
      const gen = ++this.gen;
      this.audio.onended = () => gen === this.gen && this.next();
      this.setState("playing");
      void this.audio.play();
      return;
    }
    this.index = from;
    this.setState("playing");
    this.speakCurrent();
  }

  pause(): void {
    if (this.state !== "playing") return;
    this.gen++;
    synth?.cancel();
    this.audio.pause();
    this.handlers.buffering?.(false);
    this.setState("paused");
  }

  toggle(): void {
    if (this.state === "playing") this.pause();
    else this.play();
  }

  stop(resetTo = 0): void {
    this.gen++;
    this.halt();
    this.current = null;
    this.index = resetTo;
    this.handlers.buffering?.(false);
    this.setState("idle");
  }

  setRate(rate: number): void {
    this.rate = rate;
    if (this.engine === "kokoro") {
      this.audio.defaultPlaybackRate = rate;
      this.audio.playbackRate = rate; // live, no restart needed
    } else if (this.state === "playing") {
      this.speakCurrent();
    }
  }

  setVoice(engine: Engine, voice: string | SpeechSynthesisVoice | null): void {
    this.engine = engine;
    if (engine === "kokoro") this.kokoroVoice = (voice as string) || DEFAULT_KOKORO_VOICE;
    else this.systemVoice = voice as SpeechSynthesisVoice | null;
    this.audioIndex = -1;
    if (this.state === "playing") this.speakCurrent();
    else if (this.state === "paused") this.halt();
  }

  private canResumeAudio(): boolean {
    return this.engine === "kokoro" && this.audioIndex === this.index && !!this.audio.src && !this.audio.ended;
  }

  private halt(): void {
    synth?.cancel();
    this.audio.pause();
    this.audio.onended = null;
    this.audioIndex = -1;
  }

  private next(): void {
    if (this.index < this.chunks.length - 1) {
      this.index++;
      this.speakCurrent();
    } else {
      this.stop(0);
      this.handlers.end?.();
    }
  }

  private speakCurrent(): void {
    const gen = ++this.gen;
    this.halt();
    this.handlers.chunk?.(this.index);
    if (this.engine === "kokoro") void this.speakKokoro(gen);
    else this.speakSystem(gen);
  }

  /* ---------- Kokoro neural voice ---------- */

  private async speakKokoro(gen: number): Promise<void> {
    const i = this.index;
    const voice = this.kokoroVoice;
    const window = this.chunks.slice(i, i + 1 + PREFETCH).map((c) => ({ text: c.text, voice }));
    this.kokoro.keepOnly(window); // forget sentences we've jumped away from
    const wait = !this.kokoro.isCached(this.chunks[i].text, voice);
    const current = this.kokoro.audio(this.chunks[i].text, voice);
    // Queue the next sentences behind the current one.
    for (const w of window.slice(1)) void this.kokoro.audio(w.text, w.voice);

    if (wait) this.handlers.buffering?.(true);
    let url: string;
    try {
      url = await current;
    } catch (e) {
      if (gen !== this.gen) return;
      this.handlers.buffering?.(false);
      this.pause();
      this.handlers.error?.((e as Error).message, "kokoro");
      return;
    }
    if (gen !== this.gen) return;
    this.handlers.buffering?.(false);

    this.audio.src = url;
    this.audio.defaultPlaybackRate = this.rate;
    this.audio.playbackRate = this.rate;
    this.audioIndex = i;
    this.audio.onended = () => gen === this.gen && this.next();
    try {
      await this.audio.play();
    } catch (e) {
      if (gen !== this.gen || (e as Error).name === "AbortError") return;
      this.pause();
      this.handlers.error?.(`Audio playback failed: ${(e as Error).message}`, "kokoro");
    }
  }

  /* ---------- Operating-system voices ---------- */

  private speakSystem(gen: number): void {
    if (!Reader.systemSupported) {
      this.pause();
      this.handlers.error?.("System speech is not available.", "system");
      return;
    }
    const u = new SpeechSynthesisUtterance(this.chunks[this.index].text);
    u.rate = this.rate;
    u.lang = this.systemVoice?.lang ?? "en-US";
    if (this.systemVoice) u.voice = this.systemVoice;
    u.onend = () => gen === this.gen && this.next();
    u.onerror = (e) => {
      if (gen !== this.gen || e.error === "interrupted" || e.error === "canceled") return;
      this.pause();
      this.handlers.error?.(`Speech error: ${e.error}`, "system");
    };
    this.current = u;
    synth!.speak(u);
  }

  private setState(s: ReaderState): void {
    if (s === this.state) return;
    this.state = s;
    this.handlers.state?.(s);
  }
}

/** English system voices, best first. */
export function englishVoices(): SpeechSynthesisVoice[] {
  if (!synth) return [];
  const rank = (v: SpeechSynthesisVoice) =>
    (/natural|neural|online|premium|enhanced/i.test(v.name) ? 0 : 8) +
    (v.default ? 0 : 4) +
    (v.localService ? 0 : 1) +
    (/^en[-_]US/i.test(v.lang) ? 0 : 2);
  return synth
    .getVoices()
    .filter((v) => /^en([-_]|$)/i.test(v.lang))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function onVoicesChanged(fn: () => void): void {
  if (!synth) return;
  synth.addEventListener?.("voiceschanged", fn);
  fn();
}
