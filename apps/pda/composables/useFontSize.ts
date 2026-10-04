// Global UI text-size setting (px applied to <html>). Mirrors the
// warehouse-locale persistence pattern: per-device localStorage, applied at
// app start by plugins/font-size.client.ts. All app CSS sizes in rem, so the
// whole UI scales off this one root value.
export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 32;
const DEFAULT_FONT_SIZE = 24;
const STORAGE_KEY = "warehouse-font-size";

const fontSize = ref(DEFAULT_FONT_SIZE);

function clamp(px: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(px)));
}

function apply(px: number): void {
  if (import.meta.client) {
    document.documentElement.style.fontSize = `${px}px`;
  }
}

function initFontSize(): void {
  if (!import.meta.client) return;
  let saved = DEFAULT_FONT_SIZE;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) saved = clamp(parsed);
  }
  fontSize.value = saved;
  apply(saved);
}

function setFontSize(px: number): void {
  const value = clamp(px);
  fontSize.value = value;
  if (import.meta.client) {
    localStorage.setItem(STORAGE_KEY, String(value));
  }
  apply(value);
}

export function useFontSize() {
  return {
    fontSize: readonly(fontSize),
    setFontSize,
    initFontSize,
  };
}
