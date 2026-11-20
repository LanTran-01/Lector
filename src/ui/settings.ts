import type { Theme } from "./theme";

export interface Settings {
  rate: number;
  voice: string; // "kokoro:<id>" or "system:<voiceURI>"
  theme: Theme;
  autoScroll: boolean;
  dimPages: boolean;
}

const KEY = "lector.settings";
const DEFAULTS: Settings = { rate: 1, voice: "kokoro:af_heart", theme: "system", autoScroll: true, dimPages: true };

export const RATE_MIN = 0.5;
export const RATE_MAX = 2;

export function clampRate(r: number): number {
  return Math.round(Math.min(RATE_MAX, Math.max(RATE_MIN, r)) * 10) / 10;
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    const s = { ...DEFAULTS, ...raw } as Settings;
    s.rate = clampRate(Number(s.rate) || 1);
    if (!["system", "light", "dark"].includes(s.theme)) s.theme = "system";
    if (typeof s.voice !== "string" || !/^(kokoro|system):/.test(s.voice)) s.voice = DEFAULTS.voice;
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}

export function formatRate(r: number): string {
  return `${r.toFixed(1)}×`;
}
