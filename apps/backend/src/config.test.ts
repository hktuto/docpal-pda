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

test("parseFlowConfig: allowedOrgIds merges over the [] default", () => {
  assert.deepEqual(parseFlowConfig(undefined).allowedOrgIds, []);
  assert.deepEqual(parseFlowConfig("{}").allowedOrgIds, []);
  assert.deepEqual(parseFlowConfig('{"allowedOrgIds":[2,3]}').allowedOrgIds, [2, 3]);
});

test("parseFlowConfig: allowedOrgIds validation", () => {
  assert.throws(() => parseFlowConfig('{"allowedOrgIds":2}'), /allowedOrgIds must be an array of integers/);
  assert.throws(() => parseFlowConfig('{"allowedOrgIds":["2"]}'), /allowedOrgIds must be an array of integers/);
  assert.throws(() => parseFlowConfig('{"allowedOrgIds":[2.5]}'), /allowedOrgIds must be an array of integers/);
  assert.throws(() => parseFlowConfig('{"allowedOrgIds":[null]}'), /allowedOrgIds must be an array of integers/);
});

test("parseFlowConfig: receivingSubInventoryRules merges over the [] default", () => {
  assert.deepEqual(parseFlowConfig(undefined).receivingSubInventoryRules, []);
  assert.deepEqual(parseFlowConfig("{}").receivingSubInventoryRules, []);
  const cfg = parseFlowConfig(
    '{"receivingSubInventoryRules":[' +
      '{"orgIds":[140,143],"patterns":[' +
        '{"poNoPattern":"319*","subInventoryCode":"SZHK2"},' +
        '{"poNoPattern":"11*W","subInventoryCode":"GZHK2"}],' +
      '"default":"STORE1"},' +
      '{"orgIds":[9],"patterns":[],"default":null}]}'
  );
  assert.deepEqual(cfg.receivingSubInventoryRules, [
    {
      orgIds: [140, 143],
      patterns: [
        { poNoPattern: "319*", subInventoryCode: "SZHK2" },
        { poNoPattern: "11*W", subInventoryCode: "GZHK2" },
      ],
      default: "STORE1",
    },
    { orgIds: [9], patterns: [], default: null },
  ]);
});

test("parseFlowConfig: legacy flat rules normalize to groups", () => {
  const cfg = parseFlowConfig(
    '{"receivingSubInventoryRules":[' +
      '{"orgIds":[140],"poNoPattern":"319*","subInventoryCode":"SZHK2"},' +
      '{"orgIds":[140],"poNoPrefix":"329","subInventoryCode":"GZHK2"},' +
      '{"orgIds":[140],"poNoPrefix":"","subInventoryCode":"STORE1"}]}'
  );
  assert.deepEqual(cfg.receivingSubInventoryRules, [
    { orgIds: [140], patterns: [{ poNoPattern: "319*", subInventoryCode: "SZHK2" }], default: null },
    { orgIds: [140], patterns: [{ poNoPattern: "329*", subInventoryCode: "GZHK2" }], default: null },
    { orgIds: [140], patterns: [{ poNoPattern: "*", subInventoryCode: "STORE1" }], default: null },
  ]);
});

test("parseFlowConfig: receivingSubInventoryRules validation", () => {
  assert.throws(() => parseFlowConfig('{"receivingSubInventoryRules":{}}'), /must be an array/);
  assert.throws(() => parseFlowConfig('{"receivingSubInventoryRules":["x"]}'), /\[0\] must be an object/);
  assert.throws(
    () => parseFlowConfig('{"receivingSubInventoryRules":[{"orgIds":[],"patterns":[],"default":null}]}'),
    /orgIds must be a non-empty array of integers/
  );
  assert.throws(
    () => parseFlowConfig('{"receivingSubInventoryRules":[{"orgIds":[1.5],"patterns":[],"default":null}]}'),
    /orgIds must be a non-empty array of integers/
  );
  assert.throws(
    () => parseFlowConfig('{"receivingSubInventoryRules":[{"orgIds":[1]}]}'),
    /needs patterns\[\]/
  );
  assert.throws(
    () => parseFlowConfig('{"receivingSubInventoryRules":[{"orgIds":[1],"patterns":["x"]}]}'),
    /patterns\[0\] must be an object/
  );
  assert.throws(
    () => parseFlowConfig('{"receivingSubInventoryRules":[{"orgIds":[1],"patterns":[{"poNoPattern":"","subInventoryCode":"A"}]}]}'),
    /poNoPattern must be a non-empty glob string/
  );
  assert.throws(
    () => parseFlowConfig('{"receivingSubInventoryRules":[{"orgIds":[1],"patterns":[{"poNoPattern":"*","subInventoryCode":""}]}]}'),
    /subInventoryCode must be a non-empty string/
  );
  assert.throws(
    () => parseFlowConfig('{"receivingSubInventoryRules":[{"orgIds":[1],"patterns":[],"default":2}]}'),
    /default must be a non-empty string or null/
  );
  assert.throws(
    () => parseFlowConfig('{"receivingSubInventoryRules":[{"orgIds":[1],"patterns":[],"default":null,"x":1}]}'),
    /unknown key "x"/
  );
});

test("parseFlowConfig: pickingFromSubinventoryOrgs merges over the [] default", () => {
  assert.deepEqual(parseFlowConfig(undefined).pickingFromSubinventoryOrgs, []);
  assert.deepEqual(parseFlowConfig("{}").pickingFromSubinventoryOrgs, []);
  const cfg = parseFlowConfig(
    '{"pickingFromSubinventoryOrgs":[' +
      '{"orgId":143,"fromSubinventories":["SZHK2","GZHK2","SHHK2","BJHK2"]},' +
      '{"orgId":220,"fromSubinventories":["THHK2"]}]}'
  );
  assert.deepEqual(cfg.pickingFromSubinventoryOrgs, [
    { orgId: 143, fromSubinventories: ["SZHK2", "GZHK2", "SHHK2", "BJHK2"] },
    { orgId: 220, fromSubinventories: ["THHK2"] },
  ]);
});

test("parseFlowConfig: pickingFromSubinventoryOrgs validation", () => {
  assert.throws(() => parseFlowConfig('{"pickingFromSubinventoryOrgs":{}}'), /must be an array/);
  assert.throws(() => parseFlowConfig('{"pickingFromSubinventoryOrgs":["x"]}'), /\[0\] must be an object/);
  assert.throws(
    () => parseFlowConfig('{"pickingFromSubinventoryOrgs":[{"orgId":"143","fromSubinventories":["A"]}]}'),
    /orgId must be an integer/
  );
  assert.throws(
    () => parseFlowConfig('{"pickingFromSubinventoryOrgs":[{"orgId":143,"fromSubinventories":[]}]}'),
    /fromSubinventories must be a non-empty array of non-empty strings/
  );
  assert.throws(
    () => parseFlowConfig('{"pickingFromSubinventoryOrgs":[{"orgId":143,"fromSubinventories":["A",""]}]}'),
    /fromSubinventories must be a non-empty array of non-empty strings/
  );
  assert.throws(
    () => parseFlowConfig('{"pickingFromSubinventoryOrgs":[{"orgId":143,"fromSubinventories":["A"],"x":1}]}'),
    /unknown key "x"/
  );
  assert.throws(
    () =>
      parseFlowConfig(
        '{"pickingFromSubinventoryOrgs":[{"orgId":143,"fromSubinventories":["A"]},{"orgId":140,"fromSubinventories":["A"]}]}'
      ),
    /duplicate from_subinventory "A"/
  );
});
