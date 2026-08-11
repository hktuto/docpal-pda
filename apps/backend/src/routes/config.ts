import { Hono } from "hono";
import { FLOW_STEPS, allowDockStock, isStepEnabled, putAwayConfig, type FlowStep } from "../config.js";

export const configRoute = new Hono();

// Flow config (FLOW_CONFIG env; spec 2026-08-10-flow-config-design.md): the
// PDA fetches this once after login to hide disabled home tiles and pick the
// put-away list source; changes need a backend restart.
// pickingAllocation.allowDockStock=false = put-away is a hard gate for
// picking allocation; putAway carries the put-away task/suggestion config.
configRoute.get("/config", async (c) => {
  const flowSteps = Object.fromEntries(FLOW_STEPS.map((s) => [s, isStepEnabled(s)])) as Record<FlowStep, boolean>;
  return c.json(
    { flowSteps, pickingAllocation: { allowDockStock: allowDockStock() }, putAway: putAwayConfig() },
    200
  );
});
