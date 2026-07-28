import { Hono } from "hono";
import { FLOW_STEPS, isStepEnabled, type FlowStep } from "../config.js";

export const configRoute = new Hono();

// Flow-step config (FLOW_STEPS_DISABLED env): the PDA fetches this once after
// login to hide disabled home tiles; changes need a backend restart.
configRoute.get("/config", async (c) => {
  const flowSteps = Object.fromEntries(FLOW_STEPS.map((s) => [s, isStepEnabled(s)])) as Record<FlowStep, boolean>;
  return c.json({ flowSteps }, 200);
});
