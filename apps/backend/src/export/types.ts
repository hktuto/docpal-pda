// Renderer registry types for admin Excel exports (spec
// docs/superpowers/specs/2026-09-21-admin-excel-export-renderer-separation-design.md).
// Data assembly (src/export/<doc>/data.ts) builds a plain document model; a
// renderer turns the model into an xlsx buffer. Routes stay HTTP-only.

export type ExportDocType = "shipper" | "picking-list";

export interface RenderContext {
  // Wired: the instance's warehouse from WAREHOUSE_CODE (default "hk"),
  // see warehouse.ts. A renderer registered with { warehouse: "sz" } wins
  // over the unscoped default on the SZ instance; HK and any other
  // warehouse fall through to the default renderer.
  warehouse?: string;
  supplierCode?: string | null; // shipper scope
  customerCode?: string | null; // picking-list scope
}

export interface Renderer<Doc> {
  render(doc: Doc): Promise<{ fileName: string; buffer: Buffer }>;
}

export interface RendererScope {
  warehouse?: string;
  supplierCode?: string | null;
  customerCode?: string | null;
}
