/// <reference lib="webworker" />
/**
 * Kokoro neural TTS (Apache-2.0, 82M params), off the UI thread.
 *
 * The worker always does the text side: normalisation, eSpeak phonemes,
 * token ids and the voice's style vector. The neural network itself runs either
 *  - natively in the desktop app (ONNX Runtime in Rust, all CPU cores), or
 *  - here in WebAssembly when running in a plain browser (`npm run dev`).
 */
import "./stream-polyfill"; // must come first: fixes WebKit hang in the phonemizer
import { AutoTokenizer, env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

export type WorkerIn =
  | { type: "load"; native: boolean }
  | { type: "generate"; id: number; text: string; voice: string }
  | { type: "keep"; ids: number[] } // drop queued jobs not in this list
  | { type: "inferResult"; id: number; samples?: Float32Array; error?: string };

export type WorkerOut =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; threads: number }
  | { type: "audio"; id: number; wav: Blob; seconds: number }
  | { type: "error"; id?: number; message: string }
  | { type: "infer"; id: number; inputIds: number[]; style: Float32Array; speed: number };

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

let tts: KokoroTTS | null = null;
let loading: Promise<void> | null = null;
const queue: { id: number; text: string; voice: string }[] = [];
let busy = false;

const post = (msg: WorkerOut, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

/* ---------- Native inference bridge (desktop app) ---------- */

let nextInfer = 1;
const inferWaiting = new Map<number, { resolve: (s: Float32Array) => void; reject: (e: Error) => void }>();

interface ModelInputs {
  input_ids: { data: BigInt64Array | number[] };
  style: { data: Float32Array };
  speed: { data: Float32Array | number[] };
}

/** Stands in for the ONNX model inside kokoro-js: forwards the tensors to Rust. */
const nativeModel = (inputs: ModelInputs) =>
  new Promise<{ waveform: { data: Float32Array } }>((resolve, reject) => {
    const id = nextInfer++;
    inferWaiting.set(id, { resolve: (data) => resolve({ waveform: { data } }), reject });
    post({
      type: "infer",
      id,
      inputIds: Array.from(inputs.input_ids.data, Number),
      style: new Float32Array(inputs.style.data),
      speed: Number(inputs.speed.data[0]),
    });
  });

/* ---------- Loading ---------- */

function progressReporter() {
  const files = new Map<string, { loaded: number; total: number }>();
  return (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status !== "progress" || !p.file) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
    let loaded = 0;
    let total = 0;
    files.forEach((f) => {
      loaded += f.loaded;
      total += f.total;
    });
    post({ type: "progress", loaded, total });
  };
}

async function load(native: boolean): Promise<void> {
  env.allowLocalModels = false;

  if (native) {
    // Only the small tokenizer is needed here; the model lives in the Rust side.
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
    tts = new KokoroTTS(nativeModel as never, tokenizer);
    post({ type: "ready", threads: navigator.hardwareConcurrency || 0 });
    return;
  }

  const wasm = env.backends.onnx.wasm!;
  // An empty object stops transformers.js from pointing ONNX Runtime at a CDN, so it
  // uses the .wasm file Vite bundled with the app instead (works offline).
  wasm.wasmPaths = {};
  wasm.numThreads = self.crossOriginIsolated ? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  tts = await KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "wasm", progress_callback: progressReporter() });
  post({ type: "ready", threads: wasm.numThreads ?? 1 });
}

/* ---------- Generation queue ---------- */

async function pump(): Promise<void> {
  if (busy || !tts) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift()!;
    try {
      const t0 = performance.now();
      const audio = await tts.generate(job.text, { voice: job.voice as never });
      post({ type: "audio", id: job.id, wav: audio.toBlob(), seconds: (performance.now() - t0) / 1000 });
    } catch (e) {
      post({ type: "error", id: job.id, message: String((e as Error)?.message ?? e) });
    }
  }
  busy = false;
}

// ONNX Runtime starts its CPU-thread workers from this same script (named "em-pthread").
// Those must keep the runtime's own message handler, so only the main worker listens here.
const isRuntimeThread = self.name?.startsWith("em-pthread");

const onMessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  switch (msg.type) {
    case "load":
      loading ??= load(msg.native).catch((err) => {
        loading = null;
        post({ type: "error", message: String((err as Error)?.message ?? err) });
      });
      await loading;
      void pump();
      break;
    case "generate":
      queue.push({ id: msg.id, text: msg.text, voice: msg.voice });
      void pump();
      break;
    case "keep": {
      const keep = new Set(msg.ids);
      for (let i = queue.length - 1; i >= 0; i--) if (!keep.has(queue[i].id)) queue.splice(i, 1);
      break;
    }
    case "inferResult": {
      const w = inferWaiting.get(msg.id);
      inferWaiting.delete(msg.id);
      if (!w) break;
      if (msg.samples) w.resolve(msg.samples);
      else w.reject(new Error(msg.error ?? "inference failed"));
      break;
    }
  }
};

if (!isRuntimeThread) self.onmessage = onMessage;
