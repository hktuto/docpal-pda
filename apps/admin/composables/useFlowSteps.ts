import type { ApiClient } from "~/utils/api";

// Flow-step enablement mirrored from GET /config's `flowSteps` (module-level
// singleton so app.vue's sidebar and any saver (flow-config page) share one
// copy). Defaults match the backend's defaultFlowConfig: receiving on,
// receiving-cn off — the CN receiving nav link (route "/receiving-cn") and the
// standard receiving link (route "/receiving") are gated on these.
const steps = ref<Record<string, boolean>>({ receiving: true, "receiving-cn": false });

/** GET /config and mirror its flat `flowSteps` boolean record. */
export async function loadFlowSteps(api: ApiClient): Promise<void> {
  try {
    const cfg = await api.get<{ flowSteps?: Record<string, boolean> }>("/config");
    steps.value = { ...steps.value, ...cfg.flowSteps };
  } catch {
    // Keep defaults when the config can't be read.
  }
}

export function useFlowSteps() {
  return { steps, load: loadFlowSteps };
}
