import type { ApiClient } from "~/utils/api";

// Flow-step enablement mirrored from GET /config (module-level singleton so
// app.vue's sidebar and any saver (flow-config page) share one copy).
// Steps default to off until the config loads — the CN receiving nav link
// (route "/receiving-cn") is the first consumer.
const steps = ref<Record<string, boolean>>({ "receiving-cn": false });

/** GET /config and mirror its `steps` (Record<key, { enabled }>) as booleans. */
export async function loadFlowSteps(api: ApiClient): Promise<void> {
  try {
    const cfg = await api.get<{ steps?: Record<string, { enabled?: boolean }> }>("/config");
    for (const [key, value] of Object.entries(cfg?.steps ?? {})) {
      steps.value[key] = value?.enabled === true;
    }
  } catch {
    // Keep defaults (all off) when the config can't be read.
  }
}

export function useFlowSteps() {
  return { steps, load: loadFlowSteps };
}
