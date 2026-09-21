// Renderer registry (spec
// docs/superpowers/specs/2026-09-21-admin-excel-export-renderer-separation-design.md):
// renderers register per document type, optionally scoped (warehouse /
// supplier / customer). Resolution: first scoped registration whose declared
// scope keys ALL equal the context values, else the one unscoped (default)
// registration. The default is always registered at module load (each doc
// type's render/default.ts), so resolution can never fail in practice — a
// missing default is a programmer error and throws.

import type { ExportDocType, RenderContext, Renderer, RendererScope } from "./types.js";

interface Registration {
  renderer: Renderer<unknown>;
  scope?: RendererScope;
}

const registrations = new Map<ExportDocType, Registration[]>();

export function registerRenderer<Doc>(
  docType: ExportDocType,
  renderer: Renderer<Doc>,
  scope?: RendererScope
): void {
  const list = registrations.get(docType) ?? [];
  list.push({ renderer: renderer as Renderer<unknown>, scope });
  registrations.set(docType, list);
}

export function resolveRenderer<Doc = unknown>(docType: ExportDocType, ctx: RenderContext): Renderer<Doc> {
  const list = registrations.get(docType) ?? [];
  for (const reg of list) {
    if (!reg.scope) continue;
    const keys = Object.keys(reg.scope) as (keyof RendererScope)[];
    if (keys.every((k) => reg.scope![k] === ctx[k])) {
      return reg.renderer as Renderer<Doc>;
    }
  }
  const fallback = list.find((reg) => !reg.scope);
  if (!fallback) throw new Error(`no default renderer registered for "${docType}"`);
  return fallback.renderer as Renderer<Doc>;
}

// Test-only: wipe registrations so unit tests can assert resolution in
// isolation (module-level self-registration otherwise persists per process).
export function resetRenderersForTest(): void {
  registrations.clear();
}
