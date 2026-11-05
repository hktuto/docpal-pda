import { createWarehouseService, type WarehouseService } from "~/services/warehouse";
import { getApiBaseUrl } from "~/utils/serverHost";

// One service per backend host: the adapter's in-memory session caches
// (shelves, ad-hoc lists) only work when instances are shared — a fresh
// instance per call re-fetched those lists on every page/dialog mount
// (audit 2026-11-06 #6). Re-created when the /server picker changes the host.
let service: WarehouseService | null = null;
let serviceBaseUrl = "";

export function useWarehouse(): WarehouseService {
  const apiBaseUrl = getApiBaseUrl();
  if (!service || serviceBaseUrl !== apiBaseUrl) {
    service = createWarehouseService({ apiBaseUrl });
    serviceBaseUrl = apiBaseUrl;
  }
  return service;
}
