<script setup lang="ts">
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

// "Override status" modal — shared by the picking order detail page (one
// order) and the picking order list batch action (many). Dumb dialog: emits
// `apply` with the chosen status + reason; the parent performs the API call(s)
// and closes the modal on success. Shows a warning when the override would
// reopen a finished/shipped order (it re-enters allocation demand).
const props = defineProps<{
  open: boolean;
  /** Order numbers — one for the detail page, many for the batch action. */
  orderNos: string[];
  /** Current statuses of the affected orders (drives the reopen warning). */
  currentStatuses: string[];
}>();

const emit = defineEmits<{
  close: [];
  apply: [{ status: string; reason: string }];
}>();

const { t } = useI18n();

const STATUSES = ["pending", "allocated", "skip", "picking", "finished", "issue", "shipped"];
const OPEN_STATUSES = new Set(["pending", "picking", "allocated"]);

const statusOptions = computed<SearchableSelectOption[]>(() =>
  STATUSES.map((s) => ({ value: s, label: t(`status.picking.${s}`) }))
);

const status = ref("");
const reason = ref("");
const dismiss = useOverlayDismiss(() => emit("close"));

// Reopen = any affected order currently finished/shipped moving back to open.
const reopenWarning = computed(
  () =>
    OPEN_STATUSES.has(status.value) &&
    props.currentStatuses.some((s) => s === "finished" || s === "shipped")
);

watch(
  () => props.open,
  (open) => {
    if (open) {
      status.value = "";
      reason.value = "";
    }
  }
);

function apply() {
  if (!status.value) return;
  emit("apply", { status: status.value, reason: reason.value.trim() });
}
</script>

<template>
  <div v-if="open" class="overlay" @mousedown="dismiss.onMousedown" @click="dismiss.onClick">
    <div class="dialog status-dialog">
      <h2>
        {{
          orderNos.length === 1
            ? $t("admin.pages.pickingOrders.overrideModalTitleSingle", { orderNo: orderNos[0] })
            : $t("admin.pages.pickingOrders.overrideModalTitleBatch", { n: orderNos.length })
        }}
      </h2>
      <div class="override-form">
        <label class="override-field">
          <span>{{ $t("admin.pages.pickingOrders.overrideTarget") }}</span>
          <SearchableSelect
            v-model="status"
            :options="statusOptions"
            :all-label="$t('admin.pages.pickingOrders.overrideTargetPlaceholder')"
            :aria-label="$t('admin.pages.pickingOrders.overrideTarget')"
            :multiple="false"
          />
        </label>
        <label class="override-field">
          <span>{{ $t("admin.pages.pickingOrders.overrideReason") }}</span>
          <input v-model="reason" :placeholder="$t('admin.pages.pickingOrders.overrideReasonPlaceholder')" />
        </label>
        <div v-if="reopenWarning" class="override-warning">
          {{ $t("admin.pages.pickingOrders.overrideReopenWarning") }}
        </div>
      </div>
      <div class="dialog-actions">
        <button class="btn" @click="emit('close')">{{ $t("admin.common.cancel") }}</button>
        <button class="btn btn-primary" :disabled="!status" @click="apply">
          {{ $t("admin.common.save") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.status-dialog {
  width: 30rem;
}
.override-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin: 0.875rem 0;
}
.override-field {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  font-size: 0.875rem;
}
.override-warning {
  padding: 0.5625rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  background: #fdf3e7;
  border: 1px solid #f0c48c;
  color: #9a5b00;
}
</style>
