// Windows builds only: copy the Microsoft Visual C++ runtime DLLs next to the app so
// Lector starts even on PCs without the VC++ Redistributable installed.
// (Microsoft permits shipping these files app-locally.) Does nothing on other systems.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  const sys32 = join(process.env.SystemRoot || "C:\\Windows", "System32");
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "vcruntime");
  mkdirSync(out, { recursive: true });
  for (const dll of ["msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll"]) {
    const src = join(sys32, dll);
    if (!existsSync(src)) {
      console.error(`Missing ${src}. Install the Visual C++ Redistributable (x64) and try again.`);
      process.exit(1);
    }
    copyFileSync(src, join(out, dll));
  }
  console.log("VC++ runtime DLLs copied to src-tauri/vcruntime");
}
