import { createWarehouseService, type WarehouseService } from "~/services/warehouse";

export function useWarehouse(): WarehouseService {
  const config = useRuntimeConfig();

  return createWarehouseService({
    apiBaseUrl: config.public.apiBaseUrl as string | undefined,
  });
}
