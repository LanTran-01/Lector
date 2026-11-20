# Lector

A small Windows app that reads PDFs out loud. Drop in a PDF and press Play. Lector reads it in an English voice, highlights the sentence it's on, and scrolls to keep up.

- **Shell:** Tauri 2. It uses Windows' built-in WebView2, so the installer is only a few MB.
- **PDF:** PDF.js draws the pages and pulls out their text.
- **Voice:** **Kokoro**, a free open-source neural voice (Apache-2.0) that sounds natural. It runs natively on your computer through ONNX Runtime in the Rust backend and uses all CPU cores. The first time you use it, the app downloads the voice model once (about 90 MB, from Hugging Face). After that it works offline. The operating system's own voices are still available in Settings as a fallback.
- **Clean reading:** before speaking, the app skips running headers and footers, page numbers, rotated or giant watermark text, and superscript reference markers. It also removes links, bullets, stray dashes, slashes, ®/™/© symbols and dot leaders, rejoins words hyphenated across line breaks, and keeps abbreviations like "Dr." inside their sentence.

## Using it

| Action | How |
| --- | --- |
| Open a PDF | Drop it anywhere on the window, or click the box |
| Play / pause | ▶ button or **Space** |
| Stop | ■ button or **Esc** |
| Speed (0.5×–2.0×) | Settings (top-right) or **↑ / ↓** |
| Read from a sentence | Click it |
| Voice, theme, auto-scroll | Settings panel |

If you scroll by hand while it's reading, auto-scroll waits 4 seconds before taking over again. When nothing is playing, Play starts on the page you're looking at.

## Development (macOS or Windows)

Prerequisites:
- Node 20 or later
- Rust (https://rustup.rs)
- On Windows: the "Desktop development with C++" build tools

```sh
npm install
npm run dev          # UI only, in the browser at http://localhost:1420
npm run tauri dev    # the real desktop window
```

## Building the Windows installer

- **On a Windows PC:** run `npm run tauri build`. The installer appears in `src-tauri/target/release/bundle/nsis/`.
- **From a Mac:** push the project to GitHub. Then either run the **Build Windows** workflow from the Actions tab, or push a tag such as `v0.1.0`. The workflow uploads `lector-windows` as an artifact containing the installer and the standalone `lector.exe`.

## Project layout

```
src/main.ts            app wiring: open file, play/pause/stop, settings
src/pdf/viewer.ts      lazy page rendering + text layer
src/pdf/extract.ts     PDF text → sentence chunks mapped to on-screen spans
src/tts/reader.ts      sentence-by-sentence playback (HD voice or system voice)
src/tts/kokoro*.ts     Kokoro: text → phonemes → tokens in a worker; model download
src/pdf/clean.ts       text cleanup rules for speech
src-tauri/src/voice.rs native Kokoro inference (ONNX Runtime)
src/ui/*               theme, settings storage, drop zone, keyboard shortcuts
src/styles/*           design tokens (light/dark) + layout
src-tauri/             desktop shell config (window, CSP, installer)
```

## Known limits

- Scanned PDFs that contain only images have no text to read. OCR is not included.
- Only English voices are listed.
- The HD voice needs an internet connection the first time it's used, to download the model. If that fails, the app reads with a system voice instead.
