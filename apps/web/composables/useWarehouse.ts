import { createWarehouseService, type WarehouseService } from "~/services/warehouse";

export function useWarehouse(): WarehouseService {
  const config = useRuntimeConfig();
  const { currentUser } = useAuth();

  return createWarehouseService({
    apiBaseUrl: config.public.apiBaseUrl as string | undefined,
    getActorId: () => currentUser.value?.id,
  });
}
