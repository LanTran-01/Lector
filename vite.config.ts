import { defineConfig } from "vite";

// Tauri expects a fixed port and no screen clearing during `tauri dev`.
// Cross-origin isolation lets the voice model use several CPU threads.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, headers: isolation },
  preview: { headers: isolation },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@huggingface/transformers", "kokoro-js"] },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
