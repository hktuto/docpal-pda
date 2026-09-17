<template>
  <div>
    <div class="card">
      <h2 class="card__title">{{ t("settings.textSize") }}</h2>
      <p class="card__meta">{{ t("settings.textSizeHint") }}</p>
      <div class="size-control">
        <button
          type="button"
          class="btn btn--ghost size-control__btn"
          :aria-label="t('settings.smaller')"
          :disabled="fontSize <= FONT_SIZE_MIN"
          @click="setFontSize(fontSize - 1)"
        >
          A−
        </button>
        <input
          type="range"
          class="size-control__slider"
          :min="FONT_SIZE_MIN"
          :max="FONT_SIZE_MAX"
          step="1"
          :value="fontSize"
          :aria-label="t('settings.textSize')"
          @input="onSliderInput"
        />
        <button
          type="button"
          class="btn size-control__btn"
          :aria-label="t('settings.larger')"
          :disabled="fontSize >= FONT_SIZE_MAX"
          @click="setFontSize(fontSize + 1)"
        >
          A+
        </button>
      </div>
      <p class="size-value">{{ t("settings.currentValue", { px: fontSize }) }}</p>
    </div>

    <div class="card">
      <h2 class="card__title">{{ t("settings.preview") }}</h2>
      <div class="detail-row">
        <span class="detail-label">{{ t("settings.previewLabel") }}</span>
        <span>IC-LM358DR — 2,500 pcs</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">{{ t("settings.previewLabel") }}</span>
        <span>A-01-01 · BOX-000123</span>
      </div>
      <span class="badge badge--pending">{{ t("common.pending") }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ title: "meta.settings" });

const { t } = useI18n();
useHead({ title: t("meta.settings") });

const { fontSize, setFontSize } = useFontSize();

function onSliderInput(event: Event) {
  setFontSize((event.target as HTMLInputElement).valueAsNumber);
}
</script>

<style scoped>
.size-control {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.75rem;
}

.size-control__slider {
  flex: 1;
  accent-color: var(--primary);
}

.size-control__btn {
  min-width: 3rem;
  font-size: 1rem;
}

.size-value {
  margin: 0.5rem 0 0;
  text-align: center;
  color: var(--muted);
  font-size: 0.875rem;
}
</style>
