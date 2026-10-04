import { test } from "node:test";
import assert from "node:assert/strict";
import { FLOW_STEPS, parseFlowConfig, mergeFlowConfigJson, applyFlowConfig, pdaViewConfig, _resetFlowConfigForTests } from "./config.js";

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

test("parseFlowConfig: dateCodeDisplayTemplate merges over the default", () => {
  assert.equal(parseFlowConfig(undefined).dateCodeDisplayTemplate, "[date_code][coo]");
  assert.equal(parseFlowConfig("{}").dateCodeDisplayTemplate, "[date_code][coo]");
  assert.equal(parseFlowConfig('{"dateCodeDisplayTemplate":"[date_code]"}').dateCodeDisplayTemplate, "[date_code]");
  assert.equal(
    parseFlowConfig('{"dateCodeDisplayTemplate":"DC:[date_code]-[coo]/[lot_code]"}').dateCodeDisplayTemplate,
    "DC:[date_code]-[coo]/[lot_code]"
  );
});

test("parseFlowConfig: dateCodeDisplayTemplate validation", () => {
  assert.throws(() => parseFlowConfig('{"dateCodeDisplayTemplate":1}'), /dateCodeDisplayTemplate must be a non-empty string/);
  assert.throws(() => parseFlowConfig('{"dateCodeDisplayTemplate":""}'), /dateCodeDisplayTemplate must be a non-empty string/);
  assert.throws(() => parseFlowConfig('{"dateCodeDisplayTemplate":"   "}'), /dateCodeDisplayTemplate must be a non-empty string/);
});

test("parseFlowConfig: receivingOrderNameTemplate merges over the default", () => {
  assert.equal(parseFlowConfig(undefined).receivingOrderNameTemplate, "[batch_no]");
  assert.equal(parseFlowConfig("{}").receivingOrderNameTemplate, "[batch_no]");
  assert.equal(parseFlowConfig('{"receivingOrderNameTemplate":"[batch_no]"}').receivingOrderNameTemplate, "[batch_no]");
  assert.equal(
    parseFlowConfig('{"receivingOrderNameTemplate":"[invoice_no] [batch_no]"}').receivingOrderNameTemplate,
    "[invoice_no] [batch_no]"
  );
});

test("parseFlowConfig: receivingOrderNameTemplate validation", () => {
  assert.throws(() => parseFlowConfig('{"receivingOrderNameTemplate":1}'), /receivingOrderNameTemplate must be a non-empty string/);
  assert.throws(() => parseFlowConfig('{"receivingOrderNameTemplate":""}'), /receivingOrderNameTemplate must be a non-empty string/);
  assert.throws(() => parseFlowConfig('{"receivingOrderNameTemplate":"   "}'), /receivingOrderNameTemplate must be a non-empty string/);
});

test("parseFlowConfig: pdaListTemplates defaults", () => {
  for (const raw of [undefined, "{}"]) {
    const cfg = parseFlowConfig(raw);
    assert.equal(cfg.pdaListTemplates.receiving.title, "[name]");
    assert.equal(cfg.pdaListTemplates.receiving.meta, "[supplier_name] · [delivery_date]");
    assert.equal(cfg.pdaListTemplates.picking.title, "[order_no]");
    assert.equal(cfg.pdaListTemplates["put-away"].meta, "[supplier_name]");
    assert.equal(cfg.pdaListTemplates["goods-verify"].title, "[wcl_item_no]");
    assert.equal(cfg.pdaListTemplates.verify.title, "[shipping_box_id]");
    assert.equal(cfg.pdaListTemplates.measuring.meta, "[order_nos]");
  }
});

test("parseFlowConfig: pdaListTemplates merges per list/field over the defaults", () => {
  const cfg = parseFlowConfig(
    '{"pdaListTemplates":{"receiving":{"meta":"[invoice_no]"},"verify":{"title":"[shipping_box_id] ([destination_country])","meta":"[order_nos]"}}}'
  );
  // overridden field
  assert.equal(cfg.pdaListTemplates.receiving.meta, "[invoice_no]");
  // untouched field of a touched list keeps the default
  assert.equal(cfg.pdaListTemplates.receiving.title, "[name]");
  // fully replaced list
  assert.equal(cfg.pdaListTemplates.verify.title, "[shipping_box_id] ([destination_country])");
  // untouched list keeps the default
  assert.equal(cfg.pdaListTemplates.picking.meta, "[customer_code] · [po_no]");
});

test("parseFlowConfig: pdaListTemplates validation", () => {
  assert.throws(() => parseFlowConfig('{"pdaListTemplates":1}'), /pdaListTemplates must be an object/);
  assert.throws(() => parseFlowConfig('{"pdaListTemplates":[]}'), /pdaListTemplates must be an object/);
  assert.throws(() => parseFlowConfig('{"pdaListTemplates":{"stock-search":{"title":"x"}}}'), /unknown list key "stock-search"/);
  assert.throws(() => parseFlowConfig('{"pdaListTemplates":{"receiving":"x"}}'), /receiving must be an object/);
  assert.throws(() => parseFlowConfig('{"pdaListTemplates":{"receiving":{"header":"x"}}}'), /unknown key "header"/);
  assert.throws(() => parseFlowConfig('{"pdaListTemplates":{"receiving":{"title":""}}}'), /receiving.title must be a non-empty string/);
  assert.throws(() => parseFlowConfig('{"pdaListTemplates":{"receiving":{"meta":"  "}}}'), /receiving.meta must be a non-empty string/);
});

test("parseFlowConfig: pdaViewConfig defaults", () => {
  for (const raw of [undefined, "{}"]) {
    const cfg = parseFlowConfig(raw);
    assert.deepEqual(cfg.pdaViewConfig, {});
  }
});

test("parseFlowConfig: pdaViewConfig stores a validated partial", () => {
  const cfg = parseFlowConfig(
    '{"pdaViewConfig":{"lists":{"receiving":{"meta":["[invoice_no]","[supplier_name]"],"chip":"remaining_items"},"stock-search":{"title":"[part_no]"}},"receivingDetail":{"defaultGrouping":"carton","itemFields":["wcl_item_no","box_id"]},"pickingDetail":{"expandedFields":["qty"]}}}'
  );
  assert.deepEqual(cfg.pdaViewConfig.lists?.receiving, { meta: ["[invoice_no]", "[supplier_name]"], chip: "remaining_items" });
  assert.deepEqual(cfg.pdaViewConfig.lists?.["stock-search"], { title: "[part_no]" });
  assert.deepEqual(cfg.pdaViewConfig.receivingDetail, { defaultGrouping: "carton", itemFields: ["wcl_item_no", "box_id"] });
  assert.deepEqual(cfg.pdaViewConfig.pickingDetail, { expandedFields: ["qty"] });
  assert.equal(cfg.pdaViewConfig.putAwayDetail, undefined);
});

test("parseFlowConfig: pdaViewConfig validation", () => {
  assert.throws(() => parseFlowConfig('{"pdaViewConfig":1}'), /pdaViewConfig must be an object/);
  assert.throws(() => parseFlowConfig('{"pdaViewConfig":{"bogus":{}}}'), /pdaViewConfig: unknown key "bogus"/);
  assert.throws(() => parseFlowConfig('{"pdaViewConfig":{"lists":{"bogus-list":{"title":"x"}}}}'), /pdaViewConfig.lists: unknown list key "bogus-list"/);
  assert.throws(() => parseFlowConfig('{"pdaViewConfig":{"lists":{"receiving":{"chip":"working_by_name"}}}}'), /receiving.chip must be one of/);
  assert.throws(() => parseFlowConfig('{"pdaViewConfig":{"lists":{"stock-search":{"chip":"status"}}}}'), /stock-search.chip must be one of/);
  assert.throws(() => parseFlowConfig('{"pdaViewConfig":{"lists":{"receiving":{"meta":[]}}}}'), /receiving.meta must be an array of 1-2/);
  assert.throws(() => parseFlowConfig('{"pdaViewConfig":{"lists":{"receiving":{"meta":["a","b","c"]}}}}'), /receiving.meta must be an array of 1-2/);
  assert.throws(() => parseFlowConfig('{"pdaViewConfig":{"lists":{"receiving":{"meta":["a","  "]}}}}'), /receiving.meta must be an array of 1-2/);
  assert.throws(() => parseFlowConfig('{"pdaViewConfig":{"lists":{"receiving":{"meta":"[invoice_no]"}}}}'), /receiving.meta must be an array of 1-2/);
  assert.throws(() => parseFlowConfig('{"pdaViewConfig":{"lists":{"receiving":{"header":"x"}}}}'), /receiving: unknown key "header"/);
  assert.throws(() => parseFlowConfig('{"pdaViewConfig":{"pickingDetail":{"defaultGrouping":"invoice"}}}'), /pickingDetail: unknown key "defaultGrouping"/);
  assert.throws(() => parseFlowConfig('{"pdaViewConfig":{"receivingDetail":{"defaultGrouping":"bogus"}}}'), /receivingDetail.defaultGrouping must be one of/);
  assert.throws(() => parseFlowConfig('{"pdaViewConfig":{"receivingDetail":{"itemFields":["bogus"]}}}'), /receivingDetail.itemFields: unknown field "bogus"/);
  assert.throws(() => parseFlowConfig('{"pdaViewConfig":{"pickingDetail":{"expandedFields":[]}}}'), /pickingDetail.expandedFields must be a non-empty array/);
  assert.throws(() => parseFlowConfig('{"pdaViewConfig":{"putAwayDetail":{"itemFields":["expected_qty","shelf"]}}}'), /putAwayDetail.itemFields: unknown field "shelf"/);
});

test("pdaViewConfig accessor: resolution defaults", () => {
  try {
    applyFlowConfig(mergeFlowConfigJson({}));
    const view = pdaViewConfig();
    assert.deepEqual(view.lists.receiving, {
      title: "[name]",
      meta: ["[supplier_name] · [delivery_date]"],
      chip: "status",
    });
    assert.deepEqual(view.lists.verify, {
      title: "[shipping_box_id]",
      meta: ["[order_nos] · [destination_country]"],
      chip: "box_status",
    });
    assert.deepEqual(view.lists["stock-search"], { title: "[wcl_item_no]", meta: ["[part_no]"], chip: "none" });
    assert.equal(view.receivingDetail.defaultGrouping, "invoice");
    assert.deepEqual(view.pickingDetail.itemFields, ["wcl_item_no", "qty", "picked_qty"]);
    assert.deepEqual(view.putAwayDetail.itemFields, ["wcl_item_no", "expected_qty", "remaining_qty"]);
  } finally {
    _resetFlowConfigForTests();
  }
});

test("pdaViewConfig accessor: pdaViewConfig.lists override wins", () => {
  try {
    applyFlowConfig(mergeFlowConfigJson({
      pdaViewConfig: { lists: { receiving: { meta: ["[invoice_no]"], chip: "none" } } },
    }));
    const view = pdaViewConfig();
    assert.deepEqual(view.lists.receiving, { title: "[name]", meta: ["[invoice_no]"], chip: "none" });
  } finally {
    _resetFlowConfigForTests();
  }
});

test("pdaViewConfig accessor: legacy pdaListTemplates customization migrates", () => {
  try {
    applyFlowConfig(mergeFlowConfigJson({
      pdaListTemplates: { receiving: { meta: "[invoice_no]" } },
    }));
    const view = pdaViewConfig();
    assert.deepEqual(view.lists.receiving, {
      title: "[name]",
      meta: ["[invoice_no]"],
      chip: "status",
    });
    // untouched lists stay default
    assert.equal(view.lists.picking.meta[0], "[customer_code] · [po_no]");
  } finally {
    _resetFlowConfigForTests();
  }
});

test("pdaViewConfig accessor: pdaViewConfig.lists entry ignores the legacy key for that list", () => {
  try {
    applyFlowConfig(mergeFlowConfigJson({
      pdaListTemplates: { receiving: { meta: "[invoice_no]" } },
      pdaViewConfig: { lists: { receiving: { chip: "remaining_items" } } },
    }));
    const view = pdaViewConfig();
    // partial new-key override: title/meta come from the defaults, not the legacy key
    assert.deepEqual(view.lists.receiving, {
      title: "[name]",
      meta: ["[supplier_name] · [delivery_date]"],
      chip: "remaining_items",
    });
  } finally {
    _resetFlowConfigForTests();
  }
});

test("pdaViewConfig accessor: detail overrides merge over defaults", () => {
  try {
    applyFlowConfig(mergeFlowConfigJson({
      pdaViewConfig: {
        receivingDetail: { defaultGrouping: "part-no" },
        putAwayDetail: { itemFields: ["wcl_item_no", "suggested_shelf"] },
      },
    }));
    const view = pdaViewConfig();
    assert.equal(view.receivingDetail.defaultGrouping, "part-no");
    assert.deepEqual(view.receivingDetail.itemFields, ["wcl_item_no", "expected_qty", "po_no", "po_line"]);
    assert.deepEqual(view.putAwayDetail.itemFields, ["wcl_item_no", "suggested_shelf"]);
    assert.deepEqual(view.pickingDetail.itemFields, ["wcl_item_no", "qty", "picked_qty"]);
  } finally {
    _resetFlowConfigForTests();
  }
});
