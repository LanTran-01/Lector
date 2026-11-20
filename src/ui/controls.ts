export interface ShortcutActions {
  isDocOpen: () => boolean;
  togglePlay: () => void;
  stop: () => void;
  nudgeRate: (delta: number) => void;
  closeSettings: () => boolean; // returns true if it was open
  userScrolled: () => void;
  openFile: () => void;
}

const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End"]);

export function bindShortcuts(a: ShortcutActions): void {
  window.addEventListener("keydown", (e) => {
    // Ctrl+O (Windows) / Cmd+O (Mac): open another PDF at any time.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      a.openFile();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    const inField = t.matches("input, select, textarea");

    if (e.key === "Escape") {
      if (!a.closeSettings() && a.isDocOpen()) a.stop();
      return;
    }
    if (inField || !a.isDocOpen()) return;

    if (e.key === " " && t.tagName !== "BUTTON") {
      e.preventDefault();
      a.togglePlay();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      a.nudgeRate(e.key === "ArrowUp" ? 0.1 : -0.1);
    } else if (SCROLL_KEYS.has(e.key)) {
      a.userScrolled();
    }
  });

  // Mouse clicks shouldn't leave focus on buttons (so Space always means play/pause),
  // but keyboard users can still Tab to them.
  document.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest("button")) e.preventDefault();
  });
}
