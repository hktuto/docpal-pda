/**
 * Shared keyboard-wedge plumbing for the two scanner listeners
 * (composables/useHardwareScanner.ts + composables/useOrderScanNav.ts).
 * Both must agree on these values — a fix to the wedge-suppression window
 * that lands in only one of them reopens the duplicate-scan race
 * (audit 2026-11-06 #10).
 */

/** After a broadcast scan, consume wedge key echo for this long (ms). */
export const WEDGE_SUPPRESS_MS = 1500;

/** Per-listener wedge-echo suppression window (each listener instance owns
 *  one — both see the same broadcast and arm their own window). */
export function createWedgeSuppressor(windowMs = WEDGE_SUPPRESS_MS) {
  let suppressedUntil = 0;
  return {
    mark(): void {
      suppressedUntil = Date.now() + windowMs;
    },
    suppressed(): boolean {
      return Date.now() < suppressedUntil;
    },
  };
}

/** True when the event target is a form field — wedge key buffering must
 *  stay out of typing. */
export function isInputElement(target: EventTarget | null): boolean {
  if (target == null || typeof target !== "object") return false;
  const el = target as Record<string, unknown>;
  const tagName = String(el.tagName ?? "").toLowerCase();
  if (tagName === "input" || tagName === "textarea" || tagName === "select") return true;
  return Boolean(el.isContentEditable);
}

/** Trailing idle timer that discards a partially typed scan buffer. */
export function createIdleTimer(idleMs: number, onIdle: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    reset() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onIdle();
      }, idleMs);
    },
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
