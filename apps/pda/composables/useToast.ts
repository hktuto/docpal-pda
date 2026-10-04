import { ref, readonly } from 'vue';

export interface ToastAction {
  label: string;
  to: string;
}

export interface Toast {
  id: string;
  message: string;
  action?: ToastAction;
}

const DEFAULT_DURATION_MS = 3000;

const toasts = ref<Toast[]>([]);
const timers = new Map<string, number>();
let idCounter = 0;

export function useToastState() {
  return {
    toasts: readonly(toasts),
    dismissToast,
  };
}

export function useToast(): {
  showToast: (message: string, options?: { action?: ToastAction }) => void;
} {
  function showToast(message: string, options?: { action?: ToastAction }) {
    const id = `toast-${++idCounter}-${Date.now()}`;
    toasts.value = [...toasts.value, { id, message, action: options?.action }];
    timers.set(id, window.setTimeout(() => dismissToast(id), DEFAULT_DURATION_MS));
  }

  return { showToast };
}

export function dismissToast(id: string) {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const index = toasts.value.findIndex((t) => t.id === id);
  if (index !== -1) {
    toasts.value = [...toasts.value.slice(0, index), ...toasts.value.slice(index + 1)];
  }
}

export type { ToastAction as ToastActionType };
