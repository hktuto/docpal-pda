import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db.js";
import { warehouseConfig } from "../../db/schema/config.js";
import { FLOW_CONFIG_KEY, mergeFlowConfigJson, applyFlowConfig } from "../../config.js";
import { now } from "../../db/now.js";

// Flow config editing (spec 2026-08-12-admin-flow-config-design.md): the
// warehouse_config row "flow" becomes admin-editable; a successful save
// applies at runtime — no backend restart — unless the FLOW_CONFIG env
// override is active (then the row is stored but not in force).

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

export const adminFlowConfigRoute = new Hono();

adminFlowConfigRoute.get("/", async (c) => {
  const rows = await db.select().from(warehouseConfig).where(eq(warehouseConfig.key, FLOW_CONFIG_KEY));
  // config = the stored row merged over defaults — what the form edits. When
  // the FLOW_CONFIG env override is active this differs from the runtime
  // config (env wins there); the banner tells the user.
  return c.json({
    config: mergeFlowConfigJson(rows[0]?.value ?? {}),
    stored: rows[0]?.value ?? {},
    envOverride: Boolean(process.env.FLOW_CONFIG),
  });
});

adminFlowConfigRoute.put("/", async (c) => {
  const body = await readJson(c);
  let cfg;
  try {
    cfg = mergeFlowConfigJson(body);
  } catch (e) {
    throw new HTTPException(400, { message: (e as Error).message });
  }
  await db
    .insert(warehouseConfig)
    .values({ key: FLOW_CONFIG_KEY, value: body as Record<string, unknown> })
    .onConflictDoUpdate({
      target: warehouseConfig.key,
      set: { value: body as Record<string, unknown>, lastUpdateDate: now() },
    });
  const envOverride = Boolean(process.env.FLOW_CONFIG);
  if (!envOverride) applyFlowConfig(cfg);
  // Return the saved config (not the runtime one) so the form keeps what the
  // user just saved even when the env override blocked the runtime apply.
  return c.json({ config: cfg, stored: body, envOverride, applied: !envOverride });
});
