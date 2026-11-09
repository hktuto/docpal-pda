<script setup lang="ts">
// Searchable picking-order input: type to search `GET /picking-orders?search=`
// (order_no / customer / remark per the backend search), pick a suggestion to
// commit its order_no. Free text stays allowed — a replacement invoice may not
// be synced into this warehouse yet (spec 2026-11-07 cancel-invoice, confirm
// gate 2026-11-09) — so an unmatched value is never flagged as invalid.
import { useFlowApi } from "~/utils/flowApi";
import { useAnchoredPanel } from "~/composables/useAnchoredPanel";

const props = defineProps<{
  modelValue: string;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Drop this order id from the suggestions (e.g. the order being replaced). */
  excludeId?: string;
}>();
/** commit fires on pick and on blur-after-edit — the caller saves on it. */
const emit = defineEmits<{ "update:modelValue": [string]; commit: [string] }>();

const flow = useFlowApi();

interface OrderOption {
  id: string;
  orderNo: string;
  status: string;
  itemCount: number;
  totalQty: number;
}

const rootRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const open = ref(false);
const searching = ref(false);
const options = ref<OrderOption[]>([]);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;

// Panel teleports to <body> (the cancel-records table cell clips positioned
// children) and tracks the input while open.
const { panelStyle } = useAnchoredPanel(rootRef, open);

function onInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  emit("update:modelValue", value);
  scheduleSearch(value);
}

function scheduleSearch(raw: string) {
  clearTimeout(searchTimer);
  const q = raw?.trim();
  if (!q) {
    options.value = [];
    open.value = false;
    return;
  }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    searching.value = true;
    try {
      const res = await flow.listPickingOrders({ search: q, page: 1, pageSize: 15 });
      if (seq !== searchSeq) return; // a newer keystroke owns the state now
      options.value = res.rows
        .filter((r) => r.id !== props.excludeId)
        .map((r) => ({
          id: r.id,
          orderNo: r.orderNo,
          status: r.status,
          itemCount: r.itemCount,
          totalQty: r.totalQty,
        }));
      open.value = options.value.length > 0;
    } catch {
      if (seq !== searchSeq) return;
      options.value = [];
      open.value = false;
    } finally {
      if (seq === searchSeq) searching.value = false;
    }
  }, 300);
}

// Blur commits only when the value changed since the last commit (pick or
// blur) — like the CN part combobox, no watch on modelValue: v-model updates
// it on every keystroke, which would silence the blur commit.
let lastCommitted = props.modelValue;

function pick(option: OrderOption) {
  emit("update:modelValue", option.orderNo);
  open.value = false;
  lastCommitted = option.orderNo;
  emit("commit", option.orderNo);
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
  <div ref="rootRef" class="pos">
    <input
      class="pos-input"
      type="text"
      :value="modelValue"
      :aria-label="ariaLabel"
      :placeholder="placeholder"
      :disabled="disabled"
      autocomplete="off"
      @input="onInput"
      @blur="onBlur"
      @keydown.escape="open = false"
    />
    <Teleport to="body">
      <div v-if="open" ref="panelRef" :style="panelStyle" class="pos-panel">
        <div v-for="o in options" :key="o.id" class="pos-item" @mousedown.prevent="pick(o)">
          <span class="pos-no">{{ o.orderNo }}</span>
          <span class="pos-status">{{ $t(`status.picking.${o.status}`) }}</span>
          <span class="pos-meta">{{ o.itemCount }} · {{ o.totalQty }}</span>
        </div>
        <div v-if="searching" class="pos-item muted">…</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.pos {
  position: relative;
}

.pos-input {
  width: 14ch;
  font: inherit;
}

.pos-panel {
  position: fixed;
  z-index: 40;
  max-width: 26rem;
  max-height: 15rem;
  overflow-y: auto;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 6px 18px rgba(15, 23, 32, 0.14);
  padding: 0.25rem;
}

.pos-item {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.3125rem 0.5rem;
  font-size: 0.8125rem;
  white-space: nowrap;
  cursor: pointer;
  border-radius: 0.1875rem;
}

.pos-item:hover {
  background: #eef4f6;
}

.pos-no {
  font-weight: 600;
  color: var(--brand-teal-dark);
}

.pos-status,
.pos-meta {
  color: #52606d;
}

.pos-item.muted {
  color: #7d8a97;
  cursor: default;
}
</style>
