// Auth configuration (spec: docs/superpowers/specs/2026-07-21-real-login-design.md).

import { eq } from "drizzle-orm";
import type { AppDb } from "./db.js";
import { warehouseConfig } from "./db/schema/config.js";

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
// DocPal identity provider (spec: docs/superpowers/specs/2026-08-13-docpal-auth-design.md).
// When DOCPAL_URL is set, /auth/login delegates credential verification to the
// DocPal API and auto-provisions the local users row; when unset, the local
// scrypt login stays (dev/test/demo). Read at call time so tests can toggle it.
// ---------------------------------------------------------------------------

export function docpalBaseUrl(): string | undefined {
  return process.env.DOCPAL_URL?.replace(/\/+$/, "") || undefined;
}

/** Timeout for each DocPal API call during login. */
export const docpalFetchTimeoutMs = 10_000;

// DocPal groupId → local group codes. DocPal has 1 group = 1 role and the
// role carries the permissions (UAT credentials sheet): the API only returns
// groups, so permissions are enforced through this mapping:
//   Administrators Group → full control                    → admin + operator
//   WMS Admin Group (HK) → WMS Admin: Full Access + PDA    → admin + operator
//   WMS PDA Group (HK)   → PDA: Full Access                → operator
// Dashboard / email-notification groups (WMS Dashboard, MCI MCE, HK TH) map
// to nothing; a user with no mapped group is rejected at login (403).
export const docpalGroupMapping: Record<string, string[]> = {
  administrators: ["admin", "operator"],
  "WMS_Admin_Group_(HK)": ["admin", "operator"],
  "WMS_PDA_Group_(HK)": ["operator"],
};

// ---------------------------------------------------------------------------
// Flow config (spec: docs/superpowers/specs/2026-08-10-flow-config-design.md).
// Per-warehouse flow settings, merged over the defaults below:
//
//   { "steps": { "picking": { "allocation": { "allowDockStock": false } } } }
//
// Resolution order (loadFlowConfig, called once at boot from db.ts):
//   1. FLOW_CONFIG env var (JSON) — always wins when set (tests, Vercel)
//   2. warehouse_config row key "flow" (seeded per warehouse; a missing row
//      is created with {} = defaults)
// Unset everywhere = defaults (every step enabled, dock stock allocatable =
// current cross-dock behavior). Changes need a backend restart (the PDA
// fetches GET /config once after login). `measuring`/`verify` change the
// picking finish chain, `goods-verify` gates the day-end job,
// picking.allocation.allowDockStock=false makes put-away a hard gate for
// allocation; the rest only hide PDA home tiles.
//
// Legacy fallback: when FLOW_CONFIG is unset, FLOW_STEPS_DISABLED
// (comma-separated step keys, e.g. "measuring,verify") still disables those
// steps on top of the DB row (deprecated — a startup warning says to move the
// flags into the row). Both FLOW_CONFIG and FLOW_STEPS_DISABLED set →
// FLOW_CONFIG wins with a warning.
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

export interface PickingAllocationConfig {
  /** false = received stock must be put away (inventory_lots) before it can allocate. */
  allowDockStock: boolean;
}

export type PutAwaySuggestShelf = "existing-stock" | "off";

export interface PutAwayConfig {
  /** true = confirming a receiving arrival auto-creates a put_away_tasks row. */
  autoCreateTasks: boolean;
  /** Per-item shelf suggestion strategy in task responses ("off" = no hint). */
  suggestShelf: PutAwaySuggestShelf;
}

export interface FlowConfig {
  steps: Record<FlowStep, { enabled: boolean }>;
  pickingAllocation: PickingAllocationConfig;
  putAway: PutAwayConfig;
}

function defaultFlowConfig(): FlowConfig {
  return {
    steps: Object.fromEntries(FLOW_STEPS.map((s) => [s, { enabled: true }])) as FlowConfig["steps"],
    pickingAllocation: { allowDockStock: true },
    putAway: { autoCreateTasks: false, suggestShelf: "existing-stock" },
  };
}

function parseFlowStepsDisabled(raw: string | undefined): FlowStep[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is FlowStep => (FLOW_STEPS as readonly string[]).includes(s));
}

/** Parse + validate FLOW_CONFIG JSON over the defaults (exported for tests). */
export function parseFlowConfig(raw: string | undefined): FlowConfig {
  if (!raw) {
    const cfg = defaultFlowConfig();
    for (const step of parseFlowStepsDisabled(process.env.FLOW_STEPS_DISABLED)) {
      cfg.steps[step].enabled = false;
    }
    return cfg;
  }
  if (process.env.FLOW_STEPS_DISABLED) {
    console.warn("[config] both FLOW_CONFIG and FLOW_STEPS_DISABLED are set — FLOW_CONFIG wins, FLOW_STEPS_DISABLED is ignored.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("[config] FLOW_CONFIG is not valid JSON");
  }
  return mergeFlowConfigJson(parsed);
}

/** Validate a partial flow-config JSON object and merge it over the defaults.
 *  Shared by the FLOW_CONFIG env path and the warehouse_config DB row. */
export function mergeFlowConfigJson(parsed: unknown): FlowConfig {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("[config] flow config must be a JSON object");
  }

  const cfg = defaultFlowConfig();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key !== "steps") throw new Error(`[config] flow config: unknown key "${key}"`);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("[config] flow config.steps must be an object");
    }
    for (const [step, stepCfg] of Object.entries(value as Record<string, unknown>)) {
      if (!(FLOW_STEPS as readonly string[]).includes(step)) {
        throw new Error(`[config] flow config.steps: unknown step "${step}"`);
      }
      if (typeof stepCfg !== "object" || stepCfg === null || Array.isArray(stepCfg)) {
        throw new Error(`[config] flow config.steps["${step}"] must be an object`);
      }
      for (const [stepKey, stepValue] of Object.entries(stepCfg as Record<string, unknown>)) {
        if (stepKey === "enabled") {
          if (typeof stepValue !== "boolean") {
            throw new Error(`[config] flow config.steps["${step}"].enabled must be a boolean`);
          }
          cfg.steps[step as FlowStep].enabled = stepValue;
        } else if (stepKey === "allocation" && step === "picking") {
          if (typeof stepValue !== "object" || stepValue === null || Array.isArray(stepValue)) {
            throw new Error('[config] flow config.steps.picking.allocation must be an object');
          }
          for (const [allocKey, allocValue] of Object.entries(stepValue as Record<string, unknown>)) {
            if (allocKey !== "allowDockStock") {
              throw new Error(`[config] flow config.steps.picking.allocation: unknown key "${allocKey}"`);
            }
            if (typeof allocValue !== "boolean") {
              throw new Error("[config] flow config.steps.picking.allocation.allowDockStock must be a boolean");
            }
            cfg.pickingAllocation.allowDockStock = allocValue;
          }
        } else if (stepKey === "autoCreateTasks" && step === "put-away") {
          if (typeof stepValue !== "boolean") {
            throw new Error('[config] flow config.steps["put-away"].autoCreateTasks must be a boolean');
          }
          cfg.putAway.autoCreateTasks = stepValue;
        } else if (stepKey === "suggestShelf" && step === "put-away") {
          if (stepValue !== "existing-stock" && stepValue !== "off") {
            throw new Error('[config] flow config.steps["put-away"].suggestShelf must be "existing-stock" or "off"');
          }
          cfg.putAway.suggestShelf = stepValue;
        } else {
          throw new Error(`[config] flow config.steps["${step}"]: unknown key "${stepKey}"`);
        }
      }
    }
  }

  if (!cfg.steps["put-away"].enabled && !cfg.pickingAllocation.allowDockStock) {
    throw new Error(
      "[config] flow config conflict: put-away disabled + picking.allocation.allowDockStock=false — stock could never become allocatable",
    );
  }
  if (!cfg.steps.picking.enabled && !cfg.pickingAllocation.allowDockStock) {
    console.warn("[config] flow config: picking is disabled — picking.allocation has no effect.");
  }
  if (!cfg.steps["put-away"].enabled && cfg.putAway.autoCreateTasks) {
    console.warn('[config] flow config: put-away is disabled — put-away.autoCreateTasks has no effect.');
  }
  return cfg;
}

let flowConfig = parseFlowConfig(process.env.FLOW_CONFIG);

/** warehouse_config key holding the flow-config JSON. */
export const FLOW_CONFIG_KEY = "flow";

/**
 * Resolve the active flow config (called once at boot from db.ts):
 * FLOW_CONFIG env wins when set; otherwise the warehouse_config "flow" row
 * (seeded per warehouse — a missing row is created with {} = defaults).
 * An invalid DB value throws here, i.e. fails boot, never mid-transaction.
 */
export async function loadFlowConfig(db: AppDb): Promise<FlowConfig> {
  if (process.env.FLOW_CONFIG) {
    flowConfig = parseFlowConfig(process.env.FLOW_CONFIG);
    return flowConfig;
  }
  const rows = await db
    .select()
    .from(warehouseConfig)
    .where(eq(warehouseConfig.key, FLOW_CONFIG_KEY));
  const value = rows[0]?.value;
  if (value === undefined) {
    await db.insert(warehouseConfig).values({ key: FLOW_CONFIG_KEY, value: {} }).onConflictDoNothing();
  }
  const cfg = mergeFlowConfigJson(value ?? {});
  // Legacy FLOW_STEPS_DISABLED still disables steps on top of the DB row when
  // FLOW_CONFIG is unset — deprecated, move the flags into the row.
  const legacy = parseFlowStepsDisabled(process.env.FLOW_STEPS_DISABLED);
  if (legacy.length > 0) {
    console.warn("[config] FLOW_STEPS_DISABLED is deprecated — set steps.<step>.enabled=false in the warehouse_config 'flow' row instead.");
    for (const step of legacy) cfg.steps[step].enabled = false;
  }
  flowConfig = cfg;
  return flowConfig;
}

export function isStepEnabled(step: FlowStep): boolean {
  return flowConfig.steps[step].enabled;
}

/** Picking allocation policy (spec §schema). */
export function allowDockStock(): boolean {
  return flowConfig.pickingAllocation.allowDockStock;
}

/** Put-away config (spec 2026-08-10-put-away-tasks-design.md). */
export function putAwayConfig(): PutAwayConfig {
  return flowConfig.putAway;
}

/** Test-only override (env is read once at import time). Pass [] to reset. */
export function _setFlowStepsDisabledForTests(disabled: FlowStep[]): void {
  flowConfig = defaultFlowConfig();
  for (const step of disabled) flowConfig.steps[step].enabled = false;
}

/** Test-only override for the picking allocation policy. */
export function _setPickingAllocationForTests(allocation: Partial<PickingAllocationConfig>): void {
  flowConfig.pickingAllocation = { ...flowConfig.pickingAllocation, ...allocation };
}

/** Test-only override for the put-away config. */
export function _setPutAwayConfigForTests(putAway: Partial<PutAwayConfig>): void {
  flowConfig.putAway = { ...flowConfig.putAway, ...putAway };
}

/** Test-only full reset to the built-in defaults (e.g. after loadFlowConfig tests). */
export function _resetFlowConfigForTests(): void {
  flowConfig = defaultFlowConfig();
}
