import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { registerRenderer, resetRenderersForTest, resolveRenderer } from "./registry.js";
import type { Renderer } from "./types.js";

function dummyRenderer(name: string): Renderer<unknown> {
  return { render: () => ({ fileName: `${name}.xlsx`, buffer: Buffer.from(name) }) };
}

describe("export renderer registry", () => {
  beforeEach(() => resetRenderersForTest());

  it("throws when no default renderer is registered", () => {
    registerRenderer("shipper", dummyRenderer("scoped"), { supplierCode: "XYZ" });
    assert.throws(() => resolveRenderer("shipper", {}), /no default renderer/);
  });

  it("falls back to the unscoped default renderer", () => {
    const dflt = dummyRenderer("default");
    registerRenderer("shipper", dflt);
    assert.equal(resolveRenderer("shipper", { supplierCode: "ANY" }), dflt);
  });

  it("scoped registration beats the unscoped default when all scope keys match", () => {
    const dflt = dummyRenderer("default");
    const scoped = dummyRenderer("scoped");
    registerRenderer("shipper", dflt);
    registerRenderer("shipper", scoped, { supplierCode: "XYZ" });
    assert.equal(resolveRenderer("shipper", { supplierCode: "XYZ" }), scoped);
    assert.equal(resolveRenderer("shipper", { supplierCode: "OTHER" }), dflt);
  });

  it("skips a scoped registration whose declared keys do not all match the context", () => {
    const dflt = dummyRenderer("default");
    const scoped = dummyRenderer("scoped");
    registerRenderer("picking-list", dflt);
    registerRenderer("picking-list", scoped, { customerCode: "C1", warehouse: "HK" });
    // customerCode matches but warehouse does not → not a match
    assert.equal(resolveRenderer("picking-list", { customerCode: "C1" }), dflt);
    assert.equal(resolveRenderer("picking-list", { customerCode: "C1", warehouse: "SZ" }), dflt);
    assert.equal(resolveRenderer("picking-list", { customerCode: "C1", warehouse: "HK" }), scoped);
  });

  it("warehouse-scoped registration matches on the warehouse context key", () => {
    const dflt = dummyRenderer("default");
    const wh = dummyRenderer("warehouse");
    registerRenderer("picking-list", dflt);
    registerRenderer("picking-list", wh, { warehouse: "HK" });
    assert.equal(resolveRenderer("picking-list", { warehouse: "HK" }), wh);
    assert.equal(resolveRenderer("picking-list", {}), dflt);
  });

  it("first matching scoped registration wins (insertion order)", () => {
    const first = dummyRenderer("first");
    const second = dummyRenderer("second");
    registerRenderer("shipper", dummyRenderer("default"));
    registerRenderer("shipper", first, { supplierCode: "XYZ" });
    registerRenderer("shipper", second, { supplierCode: "XYZ" });
    assert.equal(resolveRenderer("shipper", { supplierCode: "XYZ" }), first);
  });
});
