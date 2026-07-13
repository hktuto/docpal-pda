import { onMounted, onUnmounted, ref } from 'vue';
import type { PluginListenerHandle } from '@capacitor/core';
import { ScannerBroadcast } from './useScannerBroadcast';

/** After a broadcast scan, consume wedge key echo for this long (ms). */
const WEDGE_SUPPRESS_MS = 1500;

export interface UseHardwareScannerOptions {
  /** Called with the full scanned string when Enter is pressed. */
  onScan: (value: string) => void | Promise<void>;
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
    await options.onScan(value);
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
