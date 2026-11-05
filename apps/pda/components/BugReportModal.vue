<template>
  <div
    v-if="modelValue"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="bug-report-title"
    @click.self="!isBusy && onCancel()"
    @keydown.esc="!isBusy && onCancel()"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="bug-report-title">{{ $t('bugReport.title') }}</h3>
        <button type="button" class="modal__close" :aria-label="$t('bugReport.close')" :disabled="isBusy" @click="onCancel">×</button>
      </div>

      <div class="modal__body">
        <form class="form" @submit.prevent="onSubmit">
          <div class="field">
            <span>{{ $t('bugReport.category') }}</span>
            <div class="chips" role="radiogroup" :aria-label="$t('bugReport.category')">
              <button
                v-for="c in categories"
                :key="c"
                type="button"
                class="chip"
                :class="{ 'chip--active': category === c }"
                role="radio"
                :aria-checked="category === c"
                :disabled="isBusy"
                @click="category = category === c ? null : c"
              >{{ $t(`bugReport.categories.${c}`) }}</button>
            </div>
          </div>

          <label class="field">
            <span>{{ $t('bugReport.note') }}</span>
            <textarea
              v-model="note"
              rows="3"
              :placeholder="$t('bugReport.notePlaceholder')"
              :disabled="isBusy"
            />
          </label>

          <label class="field">
            <span>{{ $t('bugReport.photo') }}</span>
            <input type="file" accept="image/*" capture="environment" :disabled="isBusy" @change="onPhotoPicked" />
            <img v-if="photoPreview" class="photo-preview" :src="photoPreview" :alt="$t('bugReport.photo')" />
          </label>

          <p v-if="errorText" class="error">{{ errorText }}</p>

          <div class="actions">
            <button type="button" class="btn btn--secondary" :disabled="isBusy" @click="onCancel">{{ $t('bugReport.cancel') }}</button>
            <button type="submit" class="btn" :disabled="isBusy || note.trim() === ''">
              {{ isBusy ? $t('bugReport.sending') : $t('bugReport.send') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { categoriesForRoute } from "~/utils/bugReportCategories";
import { getTrail, getSessionId } from "~/utils/activityLog";
import { useErrorMessage } from "~/composables/errorMessage";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const route = useRoute();
const { t } = useI18n();
const { showToast } = useToast();
const getErrorMessage = useErrorMessage();
const warehouse = useWarehouse();

const categories = computed(() => categoriesForRoute(route.path));
const category = ref<string | null>(null);
const note = ref("");
const isBusy = ref(false);
const errorText = ref("");

// base64 JPEG (no data-URL prefix) + a data-URL preview, resized client-side
// so the row stays small (spec: ≤5 MB cap, ≤1280 px, q0.8).
const photo = ref<string | null>(null);
const photoMime = ref<string | null>(null);
const photoPreview = ref<string | null>(null);

function onCancel() {
  emit("update:modelValue", false);
}

function reset() {
  category.value = null;
  note.value = "";
  photo.value = null;
  photoMime.value = null;
  photoPreview.value = null;
  errorText.value = "";
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
    // Unreadable/undecodable pick — report without the photo.
    photo.value = null;
    photoPreview.value = null;
  }
}

async function onSubmit() {
  if (note.value.trim() === "" || isBusy.value) return;
  isBusy.value = true;
  errorText.value = "";
  try {
    await warehouse.reportBug({
      app: "pda",
      route: route.fullPath,
      category: category.value,
      note: note.value.trim(),
      context: { userAgent: navigator.userAgent, sessionId: getSessionId() },
      trail: getTrail(),
      photo: photo.value,
      photoMime: photoMime.value,
    });
    showToast(t("bugReport.success"));
    reset();
    emit("update:modelValue", false);
  } catch (e) {
    errorText.value = getErrorMessage(e);
  } finally {
    isBusy.value = false;
  }
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 100;
}

.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  width: 100%;
  max-width: 26.25rem;
  max-height: 90vh;
  overflow-y: auto;
}

.modal__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  border-bottom: 1px solid var(--border);
}

.modal__header h3 {
  margin: 0;
}

.modal__close {
  background: transparent;
  border: none;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  color: var(--muted);
}

.modal__body {
  padding: 1rem;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.875rem;
}

.field span {
  color: var(--muted);
}

.field textarea,
.field input {
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
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
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text);
  font-size: 0.8125rem;
  cursor: pointer;
}

.chip--active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}

.photo-preview {
  max-width: 100%;
  max-height: 8rem;
  border-radius: var(--radius);
  margin-top: 0.25rem;
}

.error {
  color: var(--danger);
  font-size: 0.875rem;
  margin: 0;
}

.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.actions .btn {
  flex: 1;
}

.btn {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--primary);
  border-radius: var(--radius);
  background: var(--primary);
  color: #fff;
  font-size: 0.9375rem;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn--secondary {
  background: var(--surface);
  color: var(--text);
  border-color: var(--border);
}
</style>
