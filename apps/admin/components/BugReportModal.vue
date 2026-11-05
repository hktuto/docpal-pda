<template>
  <div
    v-if="modelValue"
    class="overlay"
    @click.self="!busy && close()"
  >
    <div class="dialog" role="dialog" aria-modal="true" :aria-label="$t('bugReport.title')">
      <button type="button" class="dialog-close" :aria-label="$t('bugReport.close')" :disabled="busy" @click="close">×</button>
      <h2>{{ $t('bugReport.title') }}</h2>

      <div class="field">
        <label>{{ $t('bugReport.category') }}</label>
        <div class="chips" role="radiogroup" :aria-label="$t('bugReport.category')">
          <button
            v-for="c in categories"
            :key="c"
            type="button"
            class="chip"
            :class="{ 'chip--active': category === c }"
            role="radio"
            :aria-checked="category === c"
            :disabled="busy"
            @click="category = category === c ? null : c"
          >{{ $t(`bugReport.categories.${c}`) }}</button>
        </div>
      </div>

      <div class="field">
        <label for="bug-note">{{ $t('bugReport.note') }}</label>
        <textarea id="bug-note" v-model="note" rows="3" :placeholder="$t('bugReport.notePlaceholder')" :disabled="busy" />
      </div>

      <div class="field">
        <label for="bug-photo">{{ $t('bugReport.photo') }}</label>
        <input id="bug-photo" type="file" accept="image/*" :disabled="busy" @change="onPhotoPicked" />
        <img v-if="photoPreview" class="photo-preview" :src="photoPreview" :alt="$t('bugReport.photo')" />
      </div>

      <div v-if="errorText" class="error-banner">{{ errorText }}</div>
      <div v-if="sent" class="notice-banner">{{ $t('bugReport.success') }}</div>

      <div class="dialog-actions">
        <button type="button" class="btn" :disabled="busy" @click="close">{{ $t('bugReport.cancel') }}</button>
        <button type="button" class="btn btn-primary" :disabled="busy || note.trim() === ''" @click="submit">
          {{ busy ? $t('bugReport.sending') : $t('bugReport.send') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { categoriesForRoute } from "~/utils/bugReportCategories";
import { getTrail, getSessionId } from "~/utils/activityLog";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const route = useRoute();
const { t } = useI18n();

const categories = computed(() => categoriesForRoute(route.path));
const category = ref<string | null>(null);
const note = ref("");
const busy = ref(false);
const errorText = ref("");
const sent = ref(false);

const photo = ref<string | null>(null);
const photoMime = ref<string | null>(null);
const photoPreview = ref<string | null>(null);

function close() {
  emit("update:modelValue", false);
}

function reset() {
  category.value = null;
  note.value = "";
  photo.value = null;
  photoMime.value = null;
  photoPreview.value = null;
  errorText.value = "";
  sent.value = false;
}

async function onPhotoPicked(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) {
    photo.value = null;
    photoPreview.value = null;
    return;
  }
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = dataUrl;
    });
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const jpeg = canvas.toDataURL("image/jpeg", 0.8);
    photo.value = jpeg.split(",")[1] ?? null;
    photoMime.value = "image/jpeg";
    photoPreview.value = jpeg;
  } catch {
    photo.value = null;
    photoPreview.value = null;
  }
}

async function submit() {
  if (note.value.trim() === "" || busy.value) return;
  busy.value = true;
  errorText.value = "";
  try {
    await useApi().post("/bug-reports", {
      app: "admin",
      route: route.fullPath,
      category: category.value,
      note: note.value.trim(),
      context: { userAgent: navigator.userAgent, sessionId: getSessionId() },
      trail: getTrail(),
      photo: photo.value,
      photoMime: photoMime.value,
    });
    sent.value = true;
    setTimeout(() => {
      reset();
      close();
    }, 1200);
  } catch (e: any) {
    errorText.value = e?.message ?? String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 32, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 1000;
}

.dialog {
  background: #fff;
  border-radius: 0.75rem;
  box-shadow: 0 16px 48px rgba(15, 23, 32, 0.25);
  width: 100%;
  max-width: 28rem;
  max-height: 90vh;
  overflow-y: auto;
  padding: 1.25rem;
  position: relative;
}

.dialog-close {
  position: absolute;
  top: 0.5rem;
  right: 0.75rem;
  border: none;
  background: none;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  color: #64748b;
}

.dialog h2 {
  margin: 0 0 1rem;
  font-size: 1.125rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  margin-bottom: 0.875rem;
  font-size: 0.875rem;
}

.field label {
  color: #475569;
  font-weight: 600;
}

.field textarea,
.field input {
  padding: 0.5rem;
  border: 1px solid #d8e1ea;
  border-radius: 0.5rem;
  font-size: 0.9375rem;
  font-family: inherit;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

.chip {
  padding: 0.375rem 0.625rem;
  border: 1px solid #d8e1ea;
  border-radius: 999px;
  background: #fff;
  color: #334155;
  font-size: 0.8125rem;
  cursor: pointer;
}

.chip--active {
  background: var(--brand-blue, #1b8fd4);
  border-color: var(--brand-blue, #1b8fd4);
  color: #fff;
}

.photo-preview {
  max-width: 100%;
  max-height: 10rem;
  border-radius: 0.5rem;
}

.error-banner {
  padding: 0.5625rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.875rem;
  background: #fdecea;
  border: 1px solid #f5b5ae;
  color: #b3261e;
  margin-bottom: 0.75rem;
}

.notice-banner {
  padding: 0.5625rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.875rem;
  background: #e9f7ef;
  border: 1px solid #b5e2c8;
  color: #1e7a46;
  margin-bottom: 0.75rem;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.btn {
  padding: 0.4375rem 0.875rem;
  border-radius: 0.5rem;
  border: 1px solid #d8e1ea;
  background: #fff;
  color: #334155;
  font-size: 0.875rem;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--brand-blue, #1b8fd4);
  border-color: var(--brand-blue, #1b8fd4);
  color: #fff;
}
</style>
