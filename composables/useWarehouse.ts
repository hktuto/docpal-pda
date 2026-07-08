import { createWarehouseService, type WarehouseService } from "~/services/warehouse";

export function useWarehouse(): WarehouseService {
  const config = useRuntimeConfig();
  const { currentUser } = useAuth();

  return createWarehouseService({
    adapter: config.public.warehouseAdapter as "pglite" | "api",
    apiBaseUrl: config.public.apiBaseUrl as string | undefined,
    getActorId: () => currentUser.value?.id,
  });
}
