<script setup lang="ts">
import type { CnReceivingItem } from "~/utils/cnReceivingExcel";

// Single CN receiving item editor — all 9 payload fields are free-text
// inputs (the payload is string-typed end to end, qty/cartonNo/dateCode
// stringified, poNo kept as a string even for big numbers).
const props = defineProps<{ item: CnReceivingItem; saving: boolean }>();
const emit = defineEmits<{
  close: [];
  save: [item: CnReceivingItem];
}>();

const { t } = useI18n();
const dismiss = useOverlayDismiss(() => emit("close"));

const draft = ref<CnReceivingItem>({ ...props.item });

watch(
  () => props.item,
  (item) => {
    draft.value = { ...item };
  }
);

function submit() {
  const item: CnReceivingItem = { ...draft.value };
  for (const key of Object.keys(item) as (keyof CnReceivingItem)[]) {
    item[key] = item[key].trim();
  }
  emit("save", item);
}
</script>

<template>
  <div class="overlay" @mousedown="dismiss.onMousedown" @click="dismiss.onClick">
    <div class="dialog">
      <button type="button" class="dialog-close" @click="emit('close')" aria-label="Close">&times;</button>
      <h2>{{ $t("admin.pages.receivingCn.editItemTitle", { orderNo: item.orderNo || "—" }) }}</h2>

      <form @submit.prevent="submit">
        <div class="form-grid">
          <div class="form-row">
            <label for="cn-orderNo">{{ $t("admin.pages.receivingCn.fields.orderNo") }}</label>
            <input id="cn-orderNo" v-model="draft.orderNo" type="text" />
          </div>
          <div class="form-row">
            <label for="cn-cartonNo">{{ $t("admin.pages.receivingCn.fields.cartonNo") }}</label>
            <input id="cn-cartonNo" v-model="draft.cartonNo" type="text" />
          </div>
          <div class="form-row">
            <label for="cn-partNo">{{ $t("admin.pages.receivingCn.fields.partNo") }}</label>
            <input id="cn-partNo" v-model="draft.partNo" type="text" />
          </div>
          <div class="form-row">
            <label for="cn-dateCode">{{ $t("admin.pages.receivingCn.fields.dateCode") }}</label>
            <input id="cn-dateCode" v-model="draft.dateCode" type="text" />
          </div>
          <div class="form-row">
            <label for="cn-qty">{{ $t("admin.pages.receivingCn.fields.qty") }}</label>
            <input id="cn-qty" v-model="draft.qty" type="text" />
          </div>
          <div class="form-row">
            <label for="cn-weight">{{ $t("admin.pages.receivingCn.fields.weight") }}</label>
            <input id="cn-weight" v-model="draft.weight" type="text" />
          </div>
          <div class="form-row">
            <label for="cn-office">{{ $t("admin.pages.receivingCn.fields.office") }}</label>
            <input id="cn-office" v-model="draft.office" type="text" />
          </div>
          <div class="form-row">
            <label for="cn-poNo">{{ $t("admin.pages.receivingCn.fields.poNo") }}</label>
            <input id="cn-poNo" v-model="draft.poNo" type="text" />
          </div>
          <div class="form-row form-row-wide">
            <label for="cn-remark">{{ $t("admin.pages.receivingCn.fields.remark") }}</label>
            <input id="cn-remark" v-model="draft.remark" type="text" />
          </div>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="emit('close')">{{ $t("admin.common.cancel") }}</button>
          <button type="submit" class="btn btn-primary" :disabled="saving">
            {{ saving ? $t("admin.common.saving") : $t("admin.common.save") }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem 1rem;
}
.form-row-wide {
  grid-column: 1 / -1;
}
</style>
