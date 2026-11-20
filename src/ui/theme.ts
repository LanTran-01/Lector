export type Theme = "system" | "light" | "dark";

const root = document.documentElement;
const media = window.matchMedia("(prefers-color-scheme: dark)");
let current: Theme = "system";

export function applyTheme(theme: Theme): void {
  current = theme;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  root.dataset.effective = effectiveTheme();
}

export function effectiveTheme(): "light" | "dark" {
  if (current === "system") return media.matches ? "dark" : "light";
  return current;
}

media.addEventListener("change", () => {
  if (current === "system") root.dataset.effective = effectiveTheme();
});
