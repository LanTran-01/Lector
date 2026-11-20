import { invoke, isTauri } from "@tauri-apps/api/core";
import type { WorkerIn, WorkerOut } from "./kokoro.worker";

/** Quantised Kokoro model (q8, ~90 MB). Downloaded once in the desktop app. */
const MODEL_URL = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx";
const MODEL_BYTES_ESTIMATE = 92_400_000;

/** Natural-sounding English voices that ship with Kokoro (best first). */
export const KOKORO_VOICES = [
  { id: "af_heart", label: "Heart — US female" },
  { id: "af_bella", label: "Bella — US female" },
  { id: "af_nicole", label: "Nicole — US female, soft" },
  { id: "bf_emma", label: "Emma — UK female" },
  { id: "am_michael", label: "Michael — US male" },
  { id: "am_fenrir", label: "Fenrir — US male" },
  { id: "am_puck", label: "Puck — US male" },
  { id: "bm_george", label: "George — UK male" },
  { id: "bm_fable", label: "Fable — UK male" },
] as const;

export const DEFAULT_KOKORO_VOICE = "af_heart";

export type KokoroStatus = "idle" | "loading" | "ready" | "error";

interface Job {
  id: number;
  url: Promise<string>;
  resolve: (url: string) => void;
  reject: (err: Error) => void;
  objectUrl?: string;
}

/**
 * Main-thread handle on the Kokoro worker. Requests are cached per
 * (voice, text) so prefetching the next sentences makes playback seamless.
 */
export class KokoroEngine {
  status: KokoroStatus = "idle";
  progress = 0; // 0..1 while the model downloads
  threads = 0;
  error = "";
  onStatus: () => void = () => {};
  /** True inside the desktop app: the model runs natively (fast, multi-core). */
  readonly native = isTauri();
  /** Optional trace of setup steps (diagnostics builds). */
  trace: (step: string) => void = () => {};

  private worker: Worker | null = null;
  private nextId = 1;
  private jobs = new Map<string, Job>(); // key → job
  private byId = new Map<number, Job>();
  private readyWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

  /** Start downloading / initialising the model (safe to call repeatedly). */
  load(): Promise<void> {
    if (this.status === "ready") return Promise.resolve();
    const p = new Promise<void>((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
    if (this.status === "loading") return p;

    this.status = "loading";
    this.progress = 0;
    this.error = "";
    this.onStatus();
    this.worker ??= this.spawn();
    if (this.native) {
      this.prepareNativeModel()
        .then(() => {
          this.trace("worker load sent");
          this.send({ type: "load", native: true });
          // The model is already loaded natively; the worker only fetches a small tokenizer.
          // If that stalls (e.g. offline on first run), give up so the app can fall back.
          setTimeout(() => this.status === "loading" && this.fail("Voice engine did not start in time"), 60_000);
        })
        .catch((e) => this.fail(String((e as Error)?.message ?? e)));
    } else {
      this.send({ type: "load", native: false });
    }
    return p;
  }

  /** Desktop app: make sure the model file is on disk and loaded by the Rust side. */
  private async prepareNativeModel(): Promise<void> {
    const installed = await invoke<boolean>("voice_status");
    this.trace(`voice_status=${installed}`);
    if (installed) return;

    const res = await fetch(MODEL_URL);
    if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`);
    const total = Number(res.headers.get("content-length")) || MODEL_BYTES_ESTIMATE;
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.byteLength;
      this.progress = Math.min(0.99, loaded / total);
      this.onStatus();
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const p of parts) {
      bytes.set(p, offset);
      offset += p.byteLength;
    }
    this.progress = 1; // "preparing" while Rust saves and loads it
    this.onStatus();
    this.trace(`downloaded ${loaded} bytes`);
    await invoke("voice_install", bytes);
    this.trace("installed");
  }

  /** Worker asks for the neural network to run: do it natively in Rust. */
  private async runNative(id: number, inputIds: number[], style: Float32Array, speed: number): Promise<void> {
    try {
      const buf = await invoke<ArrayBuffer>("voice_infer", { inputIds, style: Array.from(style), speed });
      const samples = new Float32Array(buf);
      this.send({ type: "inferResult", id, samples }, [samples.buffer]);
    } catch (e) {
      this.send({ type: "inferResult", id, error: String((e as Error)?.message ?? e) });
    }
  }

  isCached(text: string, voice: string): boolean {
    return !!this.jobs.get(key(text, voice))?.objectUrl;
  }

  /** Object URL of a WAV for this sentence (generated on demand, cached). */
  audio(text: string, voice: string): Promise<string> {
    const k = key(text, voice);
    const existing = this.jobs.get(k);
    if (existing) return existing.url;

    const id = this.nextId++;
    let resolve!: (u: string) => void;
    let reject!: (e: Error) => void;
    const url = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    url.catch(() => {}); // avoid unhandled rejections for prefetches nobody awaits
    const job: Job = { id, url, resolve, reject };
    this.jobs.set(k, job);
    this.byId.set(id, job);

    this.load()
      .then(() => this.send({ type: "generate", id, text, voice }))
      .catch((e) => {
        this.drop(k);
        reject(e);
      });
    return url;
  }

  /** Keep only these sentences; cancel queued work and free audio for the rest. */
  keepOnly(items: { text: string; voice: string }[]): void {
    const keep = new Set(items.map((i) => key(i.text, i.voice)));
    for (const k of [...this.jobs.keys()]) {
      if (!keep.has(k)) this.drop(k);
    }
    if (this.worker) this.send({ type: "keep", ids: [...this.jobs.values()].map((j) => j.id) });
  }

  private drop(k: string): void {
    const job = this.jobs.get(k);
    if (!job) return;
    if (job.objectUrl) URL.revokeObjectURL(job.objectUrl);
    else job.reject(new Error("cancelled"));
    this.jobs.delete(k);
    this.byId.delete(job.id);
  }

  private spawn(): Worker {
    const w = new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<WorkerOut>) => this.onMessage(e.data);
    w.onerror = (e) => this.fail(e.message || "Voice engine crashed");
    return w;
  }

  private onMessage(msg: WorkerOut): void {
    switch (msg.type) {
      case "infer":
        void this.runNative(msg.id, msg.inputIds, msg.style, msg.speed);
        break;
      case "progress":
        this.progress = msg.total ? msg.loaded / msg.total : 0;
        this.onStatus();
        break;
      case "ready":
        this.threads = msg.threads;
        this.status = "ready";
        this.progress = 1;
        this.onStatus();
        this.readyWaiters.splice(0).forEach((w) => w.resolve());
        break;
      case "audio": {
        const job = this.byId.get(msg.id);
        if (!job) return; // dropped meanwhile
        job.objectUrl = URL.createObjectURL(msg.wav);
        job.resolve(job.objectUrl);
        break;
      }
      case "error":
        if (msg.id !== undefined) {
          const job = this.byId.get(msg.id);
          if (job) {
            for (const [k, j] of this.jobs) if (j === job) this.jobs.delete(k);
            this.byId.delete(msg.id);
            job.reject(new Error(msg.message));
          }
        } else {
          this.fail(msg.message);
        }
        break;
    }
  }

  private fail(message: string): void {
    this.status = "error";
    this.error = message;
    this.onStatus();
    const err = new Error(message);
    this.readyWaiters.splice(0).forEach((w) => w.reject(err));
    for (const k of [...this.jobs.keys()]) this.drop(k);
    this.worker?.terminate();
    this.worker = null;
  }

  private send(msg: WorkerIn, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }
}

const key = (text: string, voice: string) => `${voice}\u0000${text}`;
