// PDA list-row display templates (spec
// docs/superpowers/specs/2026-09-21-pda-list-row-templates-design.md):
// module-level shared ref of the resolved per-list {title, meta} templates
// (same pattern as useFlowSteps), populated by applyListTemplates() from the
// GET /config fetch in useFlowSteps.loadFlowSteps. Defaults render until the
// config arrives (or when the backend predates the feature).
import {
  DEFAULT_PDA_LIST_TEMPLATES,
  PDA_LIST_KEYS,
  formatListRow,
  type PdaListKey,
  type PdaListRow,
  type PdaListTemplate,
  type PdaListTemplates,
} from "~/utils/listRowTemplate";

const templates = ref<PdaListTemplates>({ ...DEFAULT_PDA_LIST_TEMPLATES });

/** Merge the resolved listTemplates from GET /config over the defaults. */
export function applyListTemplates(resolved: Partial<Record<PdaListKey, Partial<PdaListTemplate>>> | undefined): void {
  if (!resolved) return;
  const next = { ...DEFAULT_PDA_LIST_TEMPLATES };
  for (const key of PDA_LIST_KEYS) {
    const t = resolved[key];
    if (t?.title?.trim()) next[key] = { title: t.title, meta: next[key].meta };
    if (t?.meta?.trim()) next[key] = { ...next[key], meta: t.meta };
  }
  templates.value = next;
}

export function useListTemplates() {
  function formatRow(listKey: PdaListKey, slot: keyof PdaListTemplate, row: object): string {
    return formatListRow(listKey, slot, row as PdaListRow, templates.value);
  }
  return { listTemplates: readonly(templates), formatRow };
}
