import { readonly, ref } from "vue";

export interface Toast {
  id: string;
  message: string;
  action?: { label: string; to: string };
}

const toasts = ref<Toast[]>([]);
let idCounter = 0;

const DEFAULT_DURATION_MS = 3000;

export function useToast() {
  function showToast(message: string, options?: { action?: { label: string; to: string } }) {
    const id = `toast-${++idCounter}-${Date.now()}`;
    toasts.value.push({ id, message, action: options?.action });
    setTimeout(() => dismissToast(id), DEFAULT_DURATION_MS);
  }

  function dismissToast(id: string) {
    const index = toasts.value.findIndex((t) => t.id === id);
    if (index !== -1) toasts.value.splice(index, 1);
  }

  return {
    toasts: readonly(toasts),
    showToast,
    dismissToast,
  };
}
