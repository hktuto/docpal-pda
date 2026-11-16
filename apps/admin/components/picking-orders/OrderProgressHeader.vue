<script setup lang="ts">
// Progress header for the picking-order detail page: a horizontal pipeline
// bar showing the order's stage, filtered by the warehouse flow config
// (label-printing / labeling / measuring+verify steps may be disabled — the
// corresponding stages are hidden). Issue/cancelled/skip orders show the bar
// dimmed with an alert badge instead of a highlighted stage.
const props = defineProps<{
  status: string;
  labelPrintingEnabled?: boolean;
  labelingEnabled?: boolean;
  /** measuring or verify step enabled (either gates the verify stage). */
  verifyEnabled?: boolean;
  /** packaging step enabled (spec 2026-11-10 packaging/shipping steps). */
  packagingEnabled?: boolean;
  labelPrintingDone?: boolean;
  labelingDone?: boolean;
  /** packaged_at IS the packaged truth — the order status stays
   *  measuring_finished until shipped; done = !!packagedAt. */
  packaged?: boolean;
}>();
const { t } = useI18n();

type StageKey = "allocate" | "picking" | "labelPrinting" | "labeling" | "verify" | "packaging" | "ship";

const stages = computed<{ key: StageKey; label: string }[]>(() => {
  const list: StageKey[] = ["allocate", "picking"];
  if (props.labelPrintingEnabled) list.push("labelPrinting");
  if (props.labelingEnabled) list.push("labeling");
  if (props.verifyEnabled) list.push("verify");
  if (props.packagingEnabled) list.push("packaging");
  list.push("ship");
  return list.map((key) => ({ key, label: t(`admin.pages.pickingOrders.progress.${key}`) }));
});

// Index of the currently active stage; stages.length = everything done;
// -1 = no active stage (issue / cancelled / skip).
const currentIndex = computed(() => {
  const s = props.status;
  if (s === "pending") return 0;
  if (s === "allocated" || s === "picking") return 1;
  if (s === "picking_finished") {
    if (props.labelPrintingEnabled && !props.labelPrintingDone) return stages.value.findIndex((x) => x.key === "labelPrinting");
    if (props.labelingEnabled && !props.labelingDone) return stages.value.findIndex((x) => x.key === "labeling");
    if (props.verifyEnabled) return stages.value.findIndex((x) => x.key === "verify");
    if (props.packagingEnabled && !props.packaged) return stages.value.findIndex((x) => x.key === "packaging");
    return stages.value.findIndex((x) => x.key === "ship");
  }
  if (s === "measuring_finished") {
    if (props.packagingEnabled && !props.packaged) return stages.value.findIndex((x) => x.key === "packaging");
    return stages.value.findIndex((x) => x.key === "ship");
  }
  if (s === "shipped") return stages.value.length;
  return -1;
});

const isAlert = computed(() => currentIndex.value < 0);
const alertLabel = computed(() =>
  props.status === "issue" ? t("status.picking.issue") : t(`status.picking.${props.status}`)
);
</script>

<template>
  <div class="progress-header" :class="{ alert: isAlert }">
    <div class="progress-stages">
      <template v-for="(stage, i) in stages" :key="stage.key">
        <div v-if="i > 0" class="stage-connector" :class="{ done: i < currentIndex }" />
        <div class="stage" :class="{ done: i < currentIndex, current: i === currentIndex, future: i > currentIndex }">
          <span class="stage-dot">
            <template v-if="i < currentIndex">✓</template>
            <template v-else>{{ i + 1 }}</template>
          </span>
          <span class="stage-label">{{ stage.label }}</span>
        </div>
      </template>
    </div>
    <span v-if="isAlert" class="alert-badge">⚠ {{ alertLabel }}</span>
  </div>
</template>

<style scoped>
.progress-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.875rem;
  padding: 0.625rem 0.875rem;
  border: 1px solid #d3dde5;
  border-radius: 0.375rem;
  background: #f7fafc;
}
.progress-stages {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
  row-gap: 0.375rem;
}
.stage {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  white-space: nowrap;
}
.stage-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.375rem;
  height: 1.375rem;
  border-radius: 50%;
  font-size: 0.75rem;
  border: 1px solid #b6c2cd;
  background: #fff;
  color: #52606d;
  flex-shrink: 0;
}
.stage-label {
  font-size: 0.8125rem;
  color: #52606d;
}
.stage.done .stage-dot {
  background: #1e7a46;
  border-color: #1e7a46;
  color: #fff;
}
.stage.done .stage-label {
  color: #1e7a46;
}
.stage.current .stage-dot {
  background: #0b5cab;
  border-color: #0b5cab;
  color: #fff;
  font-weight: 600;
}
.stage.current .stage-label {
  color: #0b5cab;
  font-weight: 600;
}
.stage.future {
  opacity: 0.65;
}
.stage-connector {
  flex: 1;
  min-width: 1.25rem;
  height: 1px;
  background: #b6c2cd;
  margin: 0 0.5rem;
}
.stage-connector.done {
  background: #1e7a46;
}
.alert-badge {
  padding: 0.1875rem 0.5625rem;
  border-radius: 0.25rem;
  font-size: 0.8125rem;
  background: #fdecea;
  border: 1px solid #f5c6c2;
  color: #b3261e;
  white-space: nowrap;
}
.progress-header.alert {
  background: #fff8f7;
  border-color: #f5c6c2;
}
.progress-header.alert .stage,
.progress-header.alert .stage-connector {
  opacity: 0.55;
}
</style>
