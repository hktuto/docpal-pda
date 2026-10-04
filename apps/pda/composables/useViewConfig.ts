// PDA view config (spec 2026-10-04-pda-app-rewrite-design.md): module-level
// shared ref of the resolved pdaViewConfig from GET /config (same pattern as
// useFlowSteps/useListTemplates). When the backend predates the feature the
// legacy listTemplates are mapped into the lists section instead and
// viewConfigLoaded stays false — list pages then keep their pre-viewConfig
// extra meta line and status chips.
import { badgeClass } from "~/composables/useStatusBadge";
import {
  DEFAULT_PDA_VIEW_CONFIG,
  PDA_VIEW_LIST_KEYS,
  defaultPdaViewConfig,
  type ListChipSpec,
  type PdaDetailGrouping,
  type PdaViewConfig,
} from "~/utils/viewConfig";
import type { PdaListKey, PdaListTemplate, PdaViewListKey } from "~/utils/listRowTemplate";
import type { PdaViewConfigDto } from "~/services/types";

const viewConfig = ref<PdaViewConfig>(defaultPdaViewConfig());
const loaded = ref(false);

function sanitizeMeta(meta: unknown, fallback: string[]): string[] {
  if (!Array.isArray(meta)) return fallback;
  const lines = meta.filter((l): l is string => typeof l === "string" && l.trim() !== "").slice(0, 2);
  return lines.length > 0 ? lines : fallback;
}

/** Merge the resolved viewConfig from GET /config over the defaults. */
export function applyViewConfig(resolved: PdaViewConfigDto | undefined): void {
  if (!resolved) return;
  const next = defaultPdaViewConfig();
  for (const key of PDA_VIEW_LIST_KEYS) {
    const l = resolved.lists?.[key];
    if (!l) continue;
    if (typeof l.title === "string" && l.title.trim()) next.lists[key].title = l.title;
    next.lists[key].meta = sanitizeMeta(l.meta, next.lists[key].meta);
    if (typeof l.chip === "string" && l.chip.trim()) next.lists[key].chip = l.chip;
  }
  const detail = (
    section: { itemFields?: string[]; expandedFields?: string[] } | undefined,
    target: { itemFields: string[]; expandedFields: string[] }
  ) => {
    if (!section) return;
    if (Array.isArray(section.itemFields) && section.itemFields.length > 0) target.itemFields = section.itemFields;
    if (Array.isArray(section.expandedFields) && section.expandedFields.length > 0) target.expandedFields = section.expandedFields;
  };
  if (resolved.receivingDetail?.defaultGrouping) {
    next.receivingDetail.defaultGrouping = resolved.receivingDetail.defaultGrouping as PdaDetailGrouping;
  }
  detail(resolved.receivingDetail, next.receivingDetail);
  detail(resolved.pickingDetail, next.pickingDetail);
  detail(resolved.putAwayDetail, next.putAwayDetail);
  viewConfig.value = next;
  loaded.value = true;
}

/** Old backend (no viewConfig key): map the legacy listTemplates into the
 *  lists section so list pages render one way; loaded stays false so pages
 *  keep their pre-viewConfig extras (second meta line, fixed status chip). */
export function applyLegacyListTemplates(
  templates: Partial<Record<PdaListKey, Partial<PdaListTemplate>>> | undefined
): void {
  const next = defaultPdaViewConfig();
  for (const key of Object.keys(DEFAULT_PDA_VIEW_CONFIG.lists) as PdaViewListKey[]) {
    if (key === "stock-search") continue;
    const t = templates?.[key as PdaListKey];
    if (t?.title?.trim()) next.lists[key].title = t.title;
    if (t?.meta?.trim()) next.lists[key].meta = [t.meta];
  }
  viewConfig.value = next;
  loaded.value = false;
}

/** Test-only reset. */
export function _resetViewConfigForTests(): void {
  viewConfig.value = defaultPdaViewConfig();
  loaded.value = false;
}

export function useViewConfig() {
  const { t } = useI18n();
  const statusLabel = useStatusLabel();

  /** Render a chip spec to {text, cls} for AppListRow (null = hide). */
  function renderChip(spec: ListChipSpec): { text: string; cls?: string } | null {
    if (!spec) return null;
    if (spec.kind === "status") {
      return { text: statusLabel[spec.labelFn](spec.status), cls: badgeClass(spec.status) };
    }
    return { text: t(spec.labelKey, spec.params ?? {}), cls: spec.cls };
  }

  return {
    viewConfig: readonly(viewConfig),
    /** True once a backend with the viewConfig key answered GET /config. */
    viewConfigLoaded: readonly(loaded),
    renderChip,
  };
}
