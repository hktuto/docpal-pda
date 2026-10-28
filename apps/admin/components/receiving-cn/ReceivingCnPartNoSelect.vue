<script setup lang="ts">
// Inline part-no combobox for the CN receiving wizard's verify table.
// Typing searches the parts table (wcl_item_no / partNo / description via
// GET /admin/parts) and picking a result replaces the value with that part's
// wcl_item_no. Free text stays allowed, but a value with no exact match in
// the parts master flags the input as unknown (red + hint) so the user can
// fix it before confirming.
import { useFlowApi } from "~/utils/flowApi";
import { useAnchoredPanel } from "~/composables/useAnchoredPanel";

const props = defineProps<{
  modelValue: string;
  ariaLabel?: string;
}>();
// commit = the value is final (a suggestion was picked, or the input blurred
// after edits) — the detail page's inline edit saves on it instead of on
// every keystroke. pick carries the full option so the caller can also apply
// the matched part_no alongside the wcl_item_no.
const emit = defineEmits<{
  "update:modelValue": [string];
  commit: [string];
  pick: [PartOption];
}>();
const { t } = useI18n();
const flow = useFlowApi();

interface PartOption {
  wclItemNo: string;
  partNo: string;
  description: string | null;
}

// Module-level query cache: the verify table mounts one instance per row and
// many rows share identical part nos — dedupe so the initial validation sweep
// over a whole sheet hits the API once per distinct value.
const resultCache = new Map<string, PartOption[]>();
const CACHE_CAP = 500;

async function searchParts(q: string): Promise<PartOption[]> {
  const key = q.toLowerCase();
  const hit = resultCache.get(key);
  if (hit) return hit;
  const res = await flow.searchParts({ q, pageSize: 20 });
  const rows = res.rows.map((r) => ({ wclItemNo: r.wclItemNo, partNo: r.partNo, description: r.description }));
  if (resultCache.size >= CACHE_CAP) resultCache.delete(resultCache.keys().next().value!);
  resultCache.set(key, rows);
  return rows;
}

const rootRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const errorRef = ref<HTMLElement | null>(null);
const open = ref(false);
const searching = ref(false);
/** The current value has no exact wcl_item_no / part_no match in the master. */
const unknown = ref(false);
const options = ref<PartOption[]>([]);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;

// The panel teleports to <body> (table cells clip absolutely-positioned
// children) and tracks the input's viewport position while anything anchored
// is visible — the suggestions panel or the not-found hint.
const { panelStyle } = useAnchoredPanel(rootRef, computed(() => open.value || unknown.value));

function onInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  emit("update:modelValue", value);
  scheduleSearch(value, true);
}

function scheduleSearch(raw: string, showPanel: boolean) {
  clearTimeout(searchTimer);

  const q = raw?.trim();
  if (!q) {
    options.value = [];
    unknown.value = false;
    open.value = false;
    return;
  }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    searching.value = true;
    try {
      const rows = await searchParts(q);
      // Ignore stale responses — a newer keystroke owns the state now.
      if (seq !== searchSeq) return;
      options.value = rows;
      open.value = showPanel && rows.length > 0;
      const needle = q.toLowerCase();
      unknown.value = !rows.some(
        (o) => o.wclItemNo.trim().toLowerCase() === needle || o.partNo.trim().toLowerCase() === needle
      );
    } catch {
      if (seq !== searchSeq) return;
      options.value = [];
      open.value = false;
      // Search failed — don't flag the value as unknown on a network error.
    } finally {
      if (seq === searchSeq) searching.value = false;
    }
  }, 300);
}

// Validate prefilled values (excel decode / added rows) without popping panels.
onMounted(() => scheduleSearch(props.modelValue, false));

// The last value this instance committed (pick or blur) — blur only commits
// when the value changed since. (Panel picks use mousedown.prevent, so the
// input keeps focus and pick() owns the commit there.)
let lastCommitted = props.modelValue;

function pick(option: PartOption) {
  emit("update:modelValue", option.wclItemNo);
  unknown.value = false;
  open.value = false;
  lastCommitted = option.wclItemNo;
  emit("pick", option);
  emit("commit", option.wclItemNo);
}

function close() {
  open.value = false;
}

function onBlur() {
  open.value = false;
  if (props.modelValue !== lastCommitted) {
    lastCommitted = props.modelValue;
    emit("commit", props.modelValue);
  }
}

function onDocumentClick(event: MouseEvent) {
  const target = event.target as Node;
  // The panel is teleported to <body> — a click inside it is outside rootRef.
  if (rootRef.value?.contains(target) || panelRef.value?.contains(target)) return;
  open.value = false;
}
watch(open, (v) => {
  if (v) document.addEventListener("click", onDocumentClick);
  else document.removeEventListener("click", onDocumentClick);
});
onBeforeUnmount(() => {
  clearTimeout(searchTimer);
  document.removeEventListener("click", onDocumentClick);
});
</script>

<template>
  <div ref="rootRef" class="pns">
    <input
      ref="inputRef"
      class="cell-input"
      :class="{ 'pns-invalid': unknown }"
      type="text"
      :value="modelValue"
      :aria-label="ariaLabel"
      :aria-invalid="unknown || undefined"
      autocomplete="off"
      @input="onInput"
      @blur="onBlur"
      @keydown.escape="close"
    />
    <Teleport to="body">
      <div v-if="unknown && !open" ref="errorRef" :style="panelStyle" class="pns-error">{{ t("admin.pages.receivingCn.partNotFound") }}</div>
      <div v-if="open" ref="panelRef" :style="panelStyle" class="pns-panel">
      <div
        v-for="o in options"
        :key="o.wclItemNo"
        class="pns-item"
        @mousedown.prevent="pick(o)"
      >
        <span class="pns-wcl">{{ o.wclItemNo }}</span>
        <span class="pns-part">{{ o.partNo }}</span>
        <span v-if="o.description" class="pns-desc">{{ o.description }}</span>
      </div>
      <div v-if="searching" class="pns-item muted">…</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.cell-input{
  width: 100%;
}
.pns {
  position: relative;
}
.pns-invalid {
  border-color: #cf1124 !important;
  background: #fff5f5;
}
.pns-error {
  position: fixed;
  z-index: 35;
  font-size: 0.6875rem;
  color: #cf1124;
  white-space: nowrap;
  pointer-events: none;
}
.pns-panel {
  position: fixed;
  z-index: 40;
  width: max-content;
  max-width: 24rem;
  max-height: 15rem;
  overflow-y: auto;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 6px 18px rgba(15, 23, 32, 0.14);
  padding: 0.25rem;
}
.pns-item {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.3125rem 0.5rem;
  font-size: 0.8125rem;
  white-space: nowrap;
  cursor: pointer;
  border-radius: 0.1875rem;
}
.pns-item:hover {
  background: #eef4f6;
}
.pns-wcl {
  font-weight: 600;
  color: var(--brand-teal-dark);
}
.pns-part,
.pns-desc {
  color: #52606d;
}
.pns-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 12rem;
}
.pns-item.muted {
  color: #7d8a97;
  cursor: default;
}
</style>
