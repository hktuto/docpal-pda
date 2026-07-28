// Auth configuration (spec: docs/superpowers/specs/2026-07-21-real-login-design.md).

// Secret used to sign/verify HS256 JWTs. Set AUTH_SECRET in any real
// deployment; the built-in default keeps local dev zero-config.
const DEV_AUTH_SECRET = "warehouse-dev-only-insecure-auth-secret";

export const authSecret = process.env.AUTH_SECRET ?? DEV_AUTH_SECRET;

if (!process.env.AUTH_SECRET) {
  console.warn("[auth] AUTH_SECRET is not set — using the built-in dev secret. Do not use in production.");
}

// Token TTL in seconds; default 43200 = 12 h (one warehouse shift).
export const authTokenTtlSeconds = Number(process.env.AUTH_TOKEN_TTL_SECONDS ?? 43200);

// ---------------------------------------------------------------------------
// Flow-step config (spec: docs/superpowers/specs/2026-07-28-verify-step-and-
// flow-step-config-design.md). FLOW_STEPS_DISABLED is a comma-separated list
// of step keys to turn off, e.g. FLOW_STEPS_DISABLED=measuring,verify. Unset
// or empty = every step enabled. Changes need a backend restart (the PDA
// fetches GET /config once after login). `measuring`/`verify` change the
// picking finish chain, `goods-verify` gates the day-end job; the rest only
// hide PDA home tiles.
// ---------------------------------------------------------------------------

export const FLOW_STEPS = [
  "receiving",
  "put-away",
  "picking",
  "goods-verify",
  "measuring",
  "verify",
  "stock-search",
] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

let flowStepsDisabled = new Set<FlowStep>(parseFlowStepsDisabled(process.env.FLOW_STEPS_DISABLED));

function parseFlowStepsDisabled(raw: string | undefined): FlowStep[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is FlowStep => (FLOW_STEPS as readonly string[]).includes(s));
}

export function isStepEnabled(step: FlowStep): boolean {
  return !flowStepsDisabled.has(step);
}

/** Test-only override (env is read once at import time). Pass [] to reset. */
export function _setFlowStepsDisabledForTests(disabled: FlowStep[]): void {
  flowStepsDisabled = new Set(disabled);
}
