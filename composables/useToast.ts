import { readonly, ref } from "vue";
import type { Ref } from "vue";

export interface ToastAction {
  label: string;
  to: string;
}

export interface Toast {
  id: string;
  message: string;
  action?: ToastAction;
}

// Module-level singleton: all callers share the same toast stack.
const toasts = ref<Toast[]>([]);
const timers = new Map<string, number>();
let idCounter = 0;

const DEFAULT_DURATION_MS = 3000;

export function useToast(): {
  toasts: Readonly<Ref<readonly Toast[]>>;
  showToast: (message: string, options?: { action?: ToastAction }) => void;
  dismissToast: (id: string) => void;
} {
  function showToast(message: string, options?: { action?: ToastAction }) {
    const id = `toast-${++idCounter}-${Date.now()}`;
    toasts.value.push({ id, message, action: options?.action });
    timers.set(id, window.setTimeout(() => dismissToast(id), DEFAULT_DURATION_MS));
  }

  function dismissToast(id: string) {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    const index = toasts.value.findIndex((t) => t.id === id);
    if (index !== -1) toasts.value.splice(index, 1);
  }

  return {
    toasts: readonly(toasts),
    showToast,
    dismissToast,
  };
}
