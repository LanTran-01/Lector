// Copies the pdf.js runtime assets the app needs into public/pdfjs/ so they ship
// inside the app (no network needed). CJK cmaps and the JS-scripting engine are
// left out on purpose to keep the app small.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const out = join(root, "public", "pdfjs");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "wasm"), { recursive: true });
cpSync(join(src, "standard_fonts"), join(out, "standard_fonts"), { recursive: true });
for (const f of ["openjpeg.wasm", "jbig2.wasm", "qcms_bg.wasm", "openjpeg_nowasm_fallback.js", "jbig2_nowasm_fallback.js"]) {
  cpSync(join(src, "wasm", f), join(out, "wasm", f));
}
cpSync(join(src, "iccs"), join(out, "iccs"), { recursive: true });

console.log("pdf.js assets copied to public/pdfjs");
