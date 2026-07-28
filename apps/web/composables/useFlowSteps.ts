import type { FlowStep } from "~/services/types";

/**
 * Flow-step config (backend env FLOW_STEPS_DISABLED, served as GET /config).
 *
 * Module-level shared ref (same pattern as useToast): every step defaults to
 * enabled so tiles render before the first fetch resolves, and
 * loadFlowSteps() is wired from the layout's session watch — a safe no-op
 * while logged out, re-fetched on each login. The env only changes on a
 * backend restart, so there is no polling.
 */
const steps = ref<Record<FlowStep, boolean>>({
  receiving: true,
  "put-away": true,
  picking: true,
  "goods-verify": true,
  measuring: true,
  verify: true,
  "stock-search": true,
});

let loading: Promise<void> | null = null;

async function loadFlowSteps(): Promise<void> {
  // No session → /config would 401; tiles stay at the all-enabled default.
  if (!useAuth().currentUser.value) return;
  loading ??= (async () => {
    try {
      const config = await useWarehouse().getFlowConfig();
      steps.value = { ...steps.value, ...config.flowSteps };
    } catch {
      // Config unavailable (old backend, offline) — keep the defaults.
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function useFlowSteps() {
  return {
    flowSteps: readonly(steps),
    loadFlowSteps,
  };
}
