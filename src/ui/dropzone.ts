/**
 * Whole-window drag & drop plus click-to-browse.
 * Calls onFile with the first dropped/selected file.
 */
export function setupDropzone(opts: {
  app: HTMLElement;
  box: HTMLElement;
  input: HTMLInputElement;
  onFile: (file: File) => void;
}): void {
  const { app, box, input, onFile } = opts;
  let depth = 0; // dragenter/dragleave fire for every child element

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    app.classList.add("dragging");
  });
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) app.classList.remove("dragging");
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    app.classList.remove("dragging");
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });

  box.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = ""; // allow re-opening the same file
    if (file) onFile(file);
  });
}

export function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}
