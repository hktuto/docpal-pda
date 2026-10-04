import { createApiClient } from "~/services/apiClient";
import { getApiBaseUrl } from "~/utils/serverHost";
import type { FlowConfig } from "~/services/types";

/**
 * GET /config — the warehouse flow config (flow steps, put-away/picking
 * sections, PDA list templates). Called by useFlowSteps on login. Until the
 * WarehouseService adapter is ported (later phase) this is the app's only
 * typed backend read besides auth.
 */
export function fetchFlowConfig(): Promise<FlowConfig> {
  return createApiClient({ baseUrl: getApiBaseUrl() }).get<FlowConfig>("/config");
}
