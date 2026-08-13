import type { FlowStep } from "~/services/types";

/**
 * Flow-step config (backend warehouse_config row "flow" — FLOW_CONFIG env
 * override, legacy FLOW_STEPS_DISABLED deprecated — served as GET /config).
 *
 * Module-level shared refs (same pattern as useToast): every step defaults to
 * enabled so tiles render before the first fetch resolves, and
 * loadFlowSteps() is wired from the layout's session watch — a safe no-op
 * while logged out, re-fetched on each login. The config only changes on a
 * backend restart, so there is no polling. putAwayConfig carries the resolved
 * steps.put-away section (autoCreateTasks / suggestShelf) and defaults to
 * manual mode.
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

// Resolved steps.put-away config (GET /config putAway). Defaults = manual
// mode (derived candidates list, no task queue) so pages behave as before
// until the first fetch resolves.
const putAwayConfig = ref<{ autoCreateTasks: boolean; suggestShelf: string }>({
  autoCreateTasks: false,
  suggestShelf: "existing-stock",
});

// Resolved steps.picking.allocation config (GET /config pickingAllocation).
// Default = dock stock allocatable (cross-dock), so pages behave as before
// until the first fetch resolves.
const pickingAllocation = ref<{ allowDockStock: boolean }>({
  allowDockStock: true,
});

let loading: Promise<void> | null = null;

async function loadFlowSteps(): Promise<void> {
  // No session → /config would 401; tiles stay at the all-enabled default.
  if (!useAuth().currentUser.value) return;
  loading ??= (async () => {
    try {
      const config = await useWarehouse().getFlowConfig();
      steps.value = { ...steps.value, ...config.flowSteps };
      if (config.putAway) {
        putAwayConfig.value = { ...putAwayConfig.value, ...config.putAway };
      }
      if (config.pickingAllocation) {
        pickingAllocation.value = { ...pickingAllocation.value, ...config.pickingAllocation };
      }
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
    putAwayConfig: readonly(putAwayConfig),
    pickingAllocation: readonly(pickingAllocation),
    loadFlowSteps,
  };
}
