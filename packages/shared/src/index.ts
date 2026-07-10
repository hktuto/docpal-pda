// Shared cross-package types. DTOs from apps/web/services/types.ts will migrate
// here in a later spec when the frontend `api` adapter is implemented.
//
// Consumed via type-only imports (e.g. `import type { HealthResponse } from
// "@warehouse/shared"`), so this package ships its TypeScript source directly
// and requires no build step for consumers in this iteration.

export interface HealthResponse {
  ok: boolean;
  db: "ok" | "error";
}
