// Renderer registry types for admin Excel exports (spec
// docs/superpowers/specs/2026-09-21-admin-excel-export-renderer-separation-design.md).
// Data assembly (src/export/<doc>/data.ts) builds a plain document model; a
// renderer turns the model into an xlsx buffer. Routes stay HTTP-only.

export type ExportDocType = "shipper" | "picking-list";

export interface RenderContext {
  // Reserved but UNWIRED in this phase: warehouse_config has no warehouse
  // identifier today. Add one (config row or env) when the first
  // warehouse-scoped renderer variant lands.
  warehouse?: string;
  supplierCode?: string | null; // shipper scope
  customerCode?: string | null; // picking-list scope
}

export interface Renderer<Doc> {
  render(doc: Doc): { fileName: string; buffer: Buffer };
}

export interface RendererScope {
  warehouse?: string;
  supplierCode?: string | null;
  customerCode?: string | null;
}
