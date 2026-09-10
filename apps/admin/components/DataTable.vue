<script setup lang="ts">
import { VueDraggable } from "vue-draggable-plus";
import { orderedLeafColumns, type AdminTable } from "~/composables/useAdminTable";

// Feature-inferred instance types (plain `Header<any, any, any>` loses the
// registered-feature methods and fails assignability against our table).
type AnyAdminTable = AdminTable<any>;
type AnyHeader = ReturnType<AnyAdminTable["getHeaderGroups"]>[number]["headers"][number];
type AnyColumn = ReturnType<AnyAdminTable["getAllLeafColumns"]>[number];

const props = defineProps<{
  table: AdminTable<any>;
  /** Show a leading checkbox column; pair with v-model:selected. */
  selectable?: boolean;
  /** Resolve a row's identity for selection (falls back to the table row id). */
  rowId?: (row: any) => string;
  loading?: boolean;
  emptyText?: string;
  /** Provided by useAdminTable consumers; enables the "Reset columns" button. */
  onResetColumns?: () => void;
}>();
const emit = defineEmits<{ (e: "row-click", row: any): void }>();
const slots = useSlots();

// v-model Set<string> of selected row ids (replicates CrudTable's selection).
const selected = defineModel<Set<string>>("selected", { default: () => new Set<string>() });

const instance = getCurrentInstance();
const hasRowClick = computed(() => !!instance?.vnode.props?.onRowClick);

// Column widths stay auto until a column is resized (entry in columnSizing).
const sizing = computed(() => props.table.atoms.columnSizing?.get() ?? {});
// Once any column has an explicit width, switch to fixed layout so columns
// can shrink below their longest content (cells ellipsize instead).
const hasSizing = computed(() => Object.keys(sizing.value).length > 0);
function columnStyle(column: AnyColumn) {
  // User resize (persisted) wins; otherwise the def's initial `size`.
  const width = sizing.value[column.id] ?? column.columnDef.size;
  return width === undefined ? undefined : { width: `${width}px`, minWidth: `${width}px` };
}

const rootRef = ref<HTMLElement | null>(null);

// Fixed layout makes every unsized column share space equally — before the
// first resize/fit, seed all columns from their rendered widths so the table
// keeps its current look.
function seedAllSizes() {
  const root = rootRef.value;
  if (!root) return;
  const next = { ...sizing.value };
  root.querySelectorAll("th[data-col]").forEach((th) => {
    const id = th.getAttribute("data-col")!;
    if (next[id] === undefined) next[id] = (th as HTMLElement).offsetWidth;
  });
  props.table.setColumnSizing(next);
}

// Auto-fit a column to its longest visible content (header + current page's
// cells). scrollWidth reports the full content width even when ellipsized.
function fitColumn(columnId: string) {
  seedAllSizes();
  const root = rootRef.value;
  if (!root) return;
  let max = 0;
  root.querySelectorAll(`[data-col="${CSS.escape(columnId)}"]`).forEach((el) => {
    max = Math.max(max, (el as HTMLElement).scrollWidth);
  });
  if (max > 0) {
    // Small buffer for the sort arrow and resize handle in the header.
    props.table.setColumnSizing({ ...sizing.value, [columnId]: Math.ceil(max) + 14 });
  }
}

function headerLabel(header: AnyHeader): string {
  const label = header.column.columnDef.header;
  return typeof label === "string" ? label : header.column.id;
}

function columnLabel(column: { id: string; columnDef: { header?: unknown } }): string {
  const label = column.columnDef.header;
  return typeof label === "string" ? label : column.id;
}

function onHeaderClick(event: MouseEvent, header: AnyHeader) {
  if (!header.column.getCanSort()) return;
  header.column.getToggleSortingHandler()?.(event);
}

function startResize(event: MouseEvent | TouchEvent, header: AnyHeader) {
  // Don't let the browser start a text selection or other default gesture.
  event.preventDefault();
  seedAllSizes();
  header.getResizeHandler()(event);
}

// Column visibility + reorder dropdown ("Columns" button above the table).
// Reorder lives here rather than as header drag-and-drop: header dragging
// conflicts with the resize handles on the same th.
const columnMenuOpen = ref(false);
const columnMenuRef = ref<HTMLElement | null>(null);
const menuColumns = computed(() => orderedLeafColumns(props.table));
// Local mutable copy for the drag list (vue-draggable-plus reorders it
// in place); committed back to the table's columnOrder on drag end.
const menuList = ref<AnyColumn[]>([]);
watch(
  menuColumns,
  (cols) => {
    menuList.value = [...cols];
  },
  { immediate: true }
);

function onMenuDragEnd() {
  props.table.setColumnOrder(menuList.value.map((c) => c.id));
}

function moveColumnToTop(index: number) {
  const ids = menuColumns.value.map((c) => c.id);
  const [id] = ids.splice(index, 1);
  if (id) props.table.setColumnOrder([id, ...ids]);
}

function onDocumentClick(event: MouseEvent) {
  if (columnMenuRef.value && !columnMenuRef.value.contains(event.target as Node)) {
    columnMenuOpen.value = false;
  }
}
watch(columnMenuOpen, (open) => {
  if (open) document.addEventListener("click", onDocumentClick);
  else document.removeEventListener("click", onDocumentClick);
});
onBeforeUnmount(() => document.removeEventListener("click", onDocumentClick));

// Selection: header checkbox toggles the current page's rows.
function rowKey(row: { id: string; original: any }): string {
  return props.rowId ? props.rowId(row.original) : row.id;
}

const allPageSelected = computed(() => {
  const rows = props.table.getRowModel().rows;
  return rows.length > 0 && rows.every((r) => selected.value.has(rowKey(r)));
});

function toggleRowSelected(row: { id: string; original: any }) {
  const next = new Set(selected.value);
  const key = rowKey(row);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  selected.value = next;
}

function togglePageSelected() {
  const next = new Set(selected.value);
  for (const row of props.table.getRowModel().rows) {
    const key = rowKey(row);
    if (allPageSelected.value) next.delete(key);
    else next.add(key);
  }
  selected.value = next;
}

const emptyColspan = computed(
  () => props.table.getVisibleLeafColumns().length + (props.selectable ? 1 : 0) + (slots.actions ? 1 : 0)
);
</script>

<template>
  <div ref="rootRef">
    <div class="table-toolbar">
      <div ref="columnMenuRef" class="column-menu-wrap">
        <button type="button" class="btn btn-small" @click="columnMenuOpen = !columnMenuOpen">
          {{ $t("admin.common.columns") }} ▾
        </button>
        <div v-if="columnMenuOpen" class="column-menu">
          <VueDraggable
            v-model="menuList"
            class="column-menu-list"
            handle=".col-grip"
            :animation="150"
            @end="onMenuDragEnd"
          >
            <div v-for="(col, i) in menuList" :key="col.id" class="column-menu-item">
              <span class="col-grip">⋮⋮</span>
              <label class="column-menu-label">
                <input type="checkbox" :checked="col.getIsVisible()" @change="col.toggleVisibility()" />
                {{ columnLabel(col) }}
              </label>
              <button
                type="button"
                class="col-move"
                :title="$t('admin.common.fitToContent')"
                @click="fitColumn(col.id)"
              >⇥</button>
              <button
                type="button"
                class="col-move"
                :disabled="i === 0"
                :title="$t('admin.common.moveToTop')"
                @click="moveColumnToTop(i)"
              >⤒</button>
            </div>
          </VueDraggable>
          <button
            v-if="onResetColumns"
            type="button"
            class="btn-link column-menu-reset"
            @click="onResetColumns"
          >
            {{ $t("admin.common.resetColumns") }}
          </button>
        </div>
      </div>
    </div>
    <div class="table-wrap" :class="{ 'is-loading': loading }">
      <table class="data" :class="{ 'table-fixed': hasSizing }">
        <thead>
          <tr v-for="headerGroup in table.getHeaderGroups()" :key="headerGroup.id">
            <th v-if="selectable" class="select-col">
              <input type="checkbox" :checked="allPageSelected" @change="togglePageSelected" />
            </th>
            <th
              v-for="header in headerGroup.headers"
              :key="header.id"
              :class="{ sorted: !!header.column.getIsSorted() }"
              :style="columnStyle(header.column)"
              :data-col="header.column.id"
            >
              <span
                class="th-title"
                :class="{ sortable: header.column.getCanSort() }"
                @click="onHeaderClick($event, header)"
              >
                {{ headerLabel(header) }}
                <span v-if="header.column.getIsSorted()" class="sort-arrow">
                  {{ header.column.getIsSorted() === "asc" ? "▲" : "▼" }}
                </span>
              </span>
              <div
                v-if="header.column.getCanResize()"
                class="col-resizer"
                :class="{ 'is-resizing': header.column.getIsResizing() }"
                :title="$t('admin.common.fitToContent')"
                @mousedown="startResize($event, header)"
                @touchstart="startResize($event, header)"
                @click.stop
                @dblclick.stop="fitColumn(header.column.id)"
              />
            </th>
            <th v-if="slots.actions">{{ $t("admin.common.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in table.getRowModel().rows"
            :key="row.id"
            :class="{ clickable: hasRowClick }"
            @click="emit('row-click', row.original)"
          >
            <td v-if="selectable" class="select-col" @click.stop>
              <input
                type="checkbox"
                :checked="selected.has(rowKey(row))"
                @change="toggleRowSelected(row)"
              />
            </td>
            <td
              v-for="cell in row.getVisibleCells()"
              :key="cell.id"
              :style="columnStyle(cell.column)"
              :data-col="cell.column.id"
            >
              <slot :name="`cell-${cell.column.id}`" :row="row.original" :value="cell.getValue()">
                {{ formatCell(cell.getValue()) }}
              </slot>
            </td>
            <td v-if="slots.actions" class="actions" @click.stop>
              <slot name="actions" :row="row.original" />
            </td>
          </tr>
          <tr v-if="table.getRowModel().rows.length === 0">
            <td :colspan="emptyColspan" class="muted">{{ emptyText ?? $t("admin.common.noRecords") }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 6px;
}
.column-menu-wrap {
  position: relative;
}
.column-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 6px 18px rgba(15, 23, 32, 0.14);
  padding: 8px 10px;
  min-width: 180px;
}
.column-menu-list {
  max-height: 320px;
  overflow-y: auto;
}
.column-menu-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 2px;
  background: #fff;
}
.column-menu-item.sortable-ghost {
  opacity: 0.4;
}
.col-grip {
  cursor: grab;
  color: #9aa5b1;
  font-size: 10px;
  letter-spacing: -2px;
  user-select: none;
}
.column-menu-label {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
}
.col-move {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 9px;
  padding: 2px 4px;
  color: #52606d;
}
.col-move:hover:not(:disabled) {
  color: var(--brand-teal-dark);
}
.col-move:disabled {
  opacity: 0.3;
  cursor: default;
}
.column-menu-reset {
  display: block;
  margin-top: 6px;
  padding: 4px 2px 0;
  border-top: 1px solid #e6ebf0;
  width: 100%;
  text-align: left;
  font-size: 13px;
}
.select-col {
  width: 32px;
  text-align: center;
}
th {
  position: relative;
}
.table-fixed {
  table-layout: fixed;
}
.table-fixed th,
.table-fixed td {
  overflow: hidden;
  text-overflow: ellipsis;
}
.th-title.sortable {
  cursor: pointer;
  user-select: none;
}
.th-title.sortable:hover {
  color: var(--brand-teal-dark);
}
.sort-arrow {
  font-size: 9px;
  margin-left: 3px;
}
.col-resizer {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  width: 7px;
  cursor: col-resize;
  touch-action: none;
  opacity: 0;
  border-right: 2px solid var(--brand-teal);
}
th:hover .col-resizer,
.col-resizer.is-resizing {
  opacity: 1;
}
tr.clickable {
  cursor: pointer;
}
.table-wrap.is-loading {
  opacity: 0.5;
  pointer-events: none;
}
</style>
