import { test } from "node:test";
import assert from "node:assert/strict";
import { FLOW_STEPS, parseFlowConfig } from "./config.js";

// FLOW_CONFIG parsing/validation (spec 2026-08-10-flow-config-design.md).
// Pure unit tests — no database.

test("parseFlowConfig: unset → defaults (all steps enabled, dock stock allowed)", () => {
  const cfg = parseFlowConfig(undefined);
  for (const step of FLOW_STEPS) assert.equal(cfg.steps[step].enabled, true, step);
  assert.equal(cfg.pickingAllocation.allowDockStock, true);
});

test("parseFlowConfig: empty object → defaults", () => {
  const cfg = parseFlowConfig("{}");
  assert.equal(cfg.steps.picking.enabled, true);
  assert.equal(cfg.pickingAllocation.allowDockStock, true);
});

test("parseFlowConfig: partial JSON merges over defaults", () => {
  const cfg = parseFlowConfig(
    '{"steps":{"measuring":{"enabled":false},"picking":{"allocation":{"allowDockStock":false}}}}'
  );
  assert.equal(cfg.steps.measuring.enabled, false);
  assert.equal(cfg.steps.receiving.enabled, true);
  assert.equal(cfg.steps.picking.enabled, true);
  assert.equal(cfg.pickingAllocation.allowDockStock, false);
});

test("parseFlowConfig: invalid JSON → throw", () => {
  assert.throws(() => parseFlowConfig("{nope"), /not valid JSON/);
  assert.throws(() => parseFlowConfig("[]"), /must be a JSON object/);
  assert.throws(() => parseFlowConfig('"x"'), /must be a JSON object/);
});

test("parseFlowConfig: unknown keys → throw", () => {
  assert.throws(() => parseFlowConfig('{"holds":{}}'), /unknown key "holds"/);
  assert.throws(() => parseFlowConfig('{"steps":{"receving":{"enabled":false}}}'), /unknown step "receving"/);
  assert.throws(() => parseFlowConfig('{"steps":{"picking":{"enabled":true,"foo":1}}}'), /unknown key "foo"/);
  assert.throws(
    () => parseFlowConfig('{"steps":{"picking":{"allocation":{"dock":false}}}}'),
    /unknown key "dock"/
  );
  // allocation is only meaningful on picking
  assert.throws(() => parseFlowConfig('{"steps":{"receiving":{"allocation":{}}}}'), /unknown key "allocation"/);
});

test("parseFlowConfig: wrong value types → throw", () => {
  assert.throws(() => parseFlowConfig('{"steps":[]}'), /steps must be an object/);
  assert.throws(() => parseFlowConfig('{"steps":{"picking":{"enabled":"no"}}}'), /enabled must be a boolean/);
  assert.throws(
    () => parseFlowConfig('{"steps":{"picking":{"allocation":{"allowDockStock":"no"}}}}'),
    /allowDockStock must be a boolean/
  );
});

test("parseFlowConfig: put-away disabled + dock stock disallowed → deadlock, throw", () => {
  assert.throws(
    () =>
      parseFlowConfig(
        '{"steps":{"put-away":{"enabled":false},"picking":{"allocation":{"allowDockStock":false}}}}'
      ),
    /never become allocatable/
  );
});

test("parseFlowConfig: put-away task keys merge over defaults", () => {
  const cfg = parseFlowConfig('{"steps":{"put-away":{"autoCreateTasks":true,"suggestShelf":"off"}}}');
  assert.equal(cfg.putAway.autoCreateTasks, true);
  assert.equal(cfg.putAway.suggestShelf, "off");
  assert.equal(cfg.steps["put-away"].enabled, true);
  // defaults when unset
  const def = parseFlowConfig(undefined);
  assert.equal(def.putAway.autoCreateTasks, false);
  assert.equal(def.putAway.suggestShelf, "existing-stock");
});

test("parseFlowConfig: put-away task key validation", () => {
  assert.throws(() => parseFlowConfig('{"steps":{"put-away":{"autoCreateTasks":"yes"}}}'), /autoCreateTasks must be a boolean/);
  assert.throws(() => parseFlowConfig('{"steps":{"put-away":{"suggestShelf":"magic"}}}'), /suggestShelf must be "existing-stock" or "off"/);
  // the keys only exist on put-away
  assert.throws(() => parseFlowConfig('{"steps":{"picking":{"autoCreateTasks":true}}}'), /unknown key "autoCreateTasks"/);
  assert.throws(() => parseFlowConfig('{"steps":{"receiving":{"suggestShelf":"off"}}}'), /unknown key "suggestShelf"/);
});
