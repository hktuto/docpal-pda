import { onMounted, onUnmounted, ref } from 'vue';
import type { PluginListenerHandle } from '@capacitor/core';
import { ScannerBroadcast } from './useScannerBroadcast';
import { playScanError, playScanSuccess } from '~/utils/scanBeep';

/** After a broadcast scan, consume wedge key echo for this long (ms). */
const WEDGE_SUPPRESS_MS = 1500;

export interface UseHardwareScannerOptions {
  /**
   * Called with the full scanned string when Enter is pressed (wedge) or a
   * broadcast scan arrives. Return `false` (or throw) when the scan is
   * rejected — a low error buzz plays; any other result plays a short
   * success beep.
   */
  onScan: (value: string) => boolean | void | Promise<boolean | void>;
  /**
   * Additional guard to disable scanning (e.g. while a modal is open).
   * The listener already skips input/textarea/select/contenteditable elements.
   */
  enabled?: () => boolean;
  /** How long to wait after the last keystroke before clearing the buffer. */
  idleTimeoutMs?: number;
  /**
   * Optional predicate to ignore a keystroke (e.g. ignore function keys that
   * some scanner models emit as prefix/suffix characters).
   */
  ignoreKey?: (event: KeyboardEvent) => boolean;
}

function isInputElement(target: EventTarget | null): boolean {
  if (target == null || typeof target !== 'object') return false;
  const el = target as Record<string, unknown>;
  const tagName = String(el.tagName ?? '').toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true;
  }
  return Boolean(el.isContentEditable);
}

/**
 * Fill the focused element with a scanned value. Only elements marked with
 * the `data-scan-fill` attribute opt in — without that guard a trigger pull
 * while typing in a dialog field (issue report, scan review) would wipe the
 * half-written text. Returns true when a marked element was filled.
 *
 * In wedge mode this is unnecessary: the scanner types into the focused
 * field by itself. It matters for broadcast mode, where no key events exist.
 */
function fillFocusedInput(value: string): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement as HTMLElement | null;
  if (!isInputElement(el)) return false;
  if (!(el as Element).hasAttribute?.('data-scan-fill')) return false;

  const dispatch = (type: string) => el!.dispatchEvent(new Event(type, { bubbles: true }));
  const tagName = String(el!.tagName ?? '').toLowerCase();

  if (tagName === 'select') {
    (el as HTMLSelectElement).value = value;
    dispatch('change');
    return true;
  }
  if (el!.isContentEditable) {
    el!.textContent = value;
    dispatch('input');
    return true;
  }
  // Use the native value setter so Vue's v-model doesn't snap the value back.
  const proto =
    typeof HTMLInputElement !== 'undefined' && typeof HTMLTextAreaElement !== 'undefined'
      ? tagName === 'textarea'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
      : null;
  const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : undefined;
  if (setter) setter.call(el, value);
  else (el as HTMLInputElement).value = value;
  dispatch('input');
  return true;
}

export function useHardwareScanner(options: UseHardwareScannerOptions) {
  const buffer = ref('');
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let suppressWedgeUntil = 0;
  let broadcastHandle: PluginListenerHandle | null = null;
  let unmounted = false;

  function resetIdleTimer() {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      buffer.value = '';
    }, options.idleTimeoutMs ?? 300);
  }

  function clearIdleTimer() {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  async function deliver(source: string, value: string) {
    console.log(`[SCAN-TIME] ${source}:`, value);
    const start = performance.now();
    let ok = true;
    try {
      ok = (await options.onScan(value)) !== false;
    } catch (e) {
      ok = false;
      console.error('[SCAN] onScan handler threw:', e);
    }
    if (ok) playScanSuccess();
    else playScanError();
    console.log('[SCAN-TIME] onScan done in', (performance.now() - start).toFixed(1), 'ms');
  }

  async function flush() {
    clearIdleTimer();
    const value = buffer.value;
    buffer.value = '';
    if (!value) return;
    await deliver('hardware flush', value);
  }

  // Broadcast scan: the whole barcode arrives in one event — no key buffering.
  async function onBroadcastScan(value: string) {
    if (options.enabled && !options.enabled()) return;
    clearIdleTimer();
    buffer.value = '';
    // Eat the wedge echo if the device outputs broadcast + keyboard combined.
    suppressWedgeUntil = Date.now() + WEDGE_SUPPRESS_MS;
    if (fillFocusedInput(value)) {
      console.log('[SCAN-TIME] broadcast scan → focused input:', value);
      playScanSuccess();
      return;
    }
    await deliver('broadcast scan', value);
  }

  function onKeydown(event: KeyboardEvent) {
    if (options.enabled && !options.enabled()) return;
    if (event.repeat) return;
    if (event.isComposing) return;
    if (isInputElement(event.target)) return;

    // Wedge echo suppression window after a broadcast scan (see onBroadcastScan).
    if (Date.now() < suppressWedgeUntil) {
      if (event.key === 'Enter' || event.key.length === 1) event.preventDefault();
      return;
    }

    if (options.ignoreKey && options.ignoreKey(event)) return;

    if (event.key === 'Enter') {
      if (buffer.value) {
        event.preventDefault();
        void flush();
      }
      return;
    }

    // Ignore lone modifier / function keys. Printable keys have `key.length === 1`.
    if (event.key.length !== 1) return;

    event.preventDefault();
    resetIdleTimer();
    buffer.value += event.key;
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeydown, { capture: true });
    void ScannerBroadcast.addListener('scan', (data) => {
      void onBroadcastScan(data.value);
    }).then((handle) => {
      if (unmounted) void handle.remove();
      else broadcastHandle = handle;
    });
  });

  onUnmounted(() => {
    unmounted = true;
    window.removeEventListener('keydown', onKeydown, { capture: true });
    clearIdleTimer();
    if (broadcastHandle) {
      void broadcastHandle.remove();
      broadcastHandle = null;
    }
  });

  return { buffer };
}
