import { createWarehouseService, type WarehouseService } from "~/services/warehouse";
import { getApiBaseUrl } from "~/utils/serverHost";

export function useWarehouse(): WarehouseService {
  return createWarehouseService({
    apiBaseUrl: getApiBaseUrl(),
  });
}
