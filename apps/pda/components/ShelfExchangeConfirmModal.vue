<template>
  <Teleport to="body">
    <div
      v-if="preview"
      class="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shelf-exchange-confirm-title"
    >
      <div class="modal">
        <div class="modal__header">
          <h3 id="shelf-exchange-confirm-title">{{ $t("shelfExchange.confirm.title") }}</h3>
        </div>
        <div class="modal__body">
          <p class="shelf-exchange__route">
            {{ preview.sourceShelfCode }} → {{ preview.targetShelfCode }}
          </p>
          <dl class="shelf-exchange__fields">
            <div class="shelf-exchange__field">
              <dt>{{ $t("shelfExchange.confirm.partNo") }}</dt>
              <dd>{{ preview.partNo }}</dd>
            </div>
            <div v-if="preview.wclItemNo" class="shelf-exchange__field">
              <dt>{{ $t("shelfExchange.confirm.wclItemNo") }}</dt>
              <dd>{{ preview.wclItemNo }}</dd>
            </div>
            <div v-if="preview.dateCode" class="shelf-exchange__field">
              <dt>{{ $t("shelfExchange.confirm.dateCode") }}</dt>
              <dd>{{ preview.dateCode }}</dd>
            </div>
            <div v-if="preview.lotCode" class="shelf-exchange__field">
              <dt>{{ $t("shelfExchange.confirm.lotCode") }}</dt>
              <dd>{{ preview.lotCode }}</dd>
            </div>
            <div v-if="preview.coo" class="shelf-exchange__field">
              <dt>{{ $t("shelfExchange.confirm.coo") }}</dt>
              <dd>{{ preview.coo }}</dd>
            </div>
            <div v-if="preview.cow" class="shelf-exchange__field">
              <dt>{{ $t("shelfExchange.confirm.cow") }}</dt>
              <dd>{{ preview.cow }}</dd>
            </div>
            <div class="shelf-exchange__field">
              <dt>{{ $t("shelfExchange.confirm.qty") }}</dt>
              <dd>{{ preview.qty }}</dd>
            </div>
          </dl>
          <div class="actions">
            <button type="button" class="btn" :disabled="committing" @click="emit('cancel')">
              {{ $t("actions.cancel") }}
            </button>
            <button
              type="button"
              class="btn btn--primary"
              :disabled="committing"
              autofocus
              @click="emit('confirm')"
            >
              {{
                committing
                  ? $t("shelfExchange.confirm.committing")
                  : $t("shelfExchange.confirm.confirm")
              }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import type { ShelfExchangePreview } from "~/services/types";

// Confirm dialog for a shelf exchange (spec 2026-10-12-shelf-exchange-design.md):
// shows the resolved lot + qty and the source → target route before the move
// is committed. The page owns the commit; this component only renders + emits.
defineProps<{
  preview: (ShelfExchangePreview & { sourceShelfCode: string; targetShelfCode: string }) | null;
  committing: boolean;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
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
  /* Above the toast host (z-index 1000). */
  z-index: 1100;
}

.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  width: 100%;
  max-width: calc(100vw - 2rem);
  max-height: 90vh;
  overflow-y: auto;
}

.modal__header {
  padding: 1rem;
  border-bottom: 1px solid var(--border);
}

.modal__header h3 {
  margin: 0;
  font-size: 1rem;
}

.modal__body {
  padding: 1rem;
}

.shelf-exchange__route {
  margin: 0 0 0.75rem;
  font-size: 1.05rem;
  font-weight: 600;
}

.shelf-exchange__fields {
  margin: 0;
  display: grid;
  gap: 0.35rem;
}

.shelf-exchange__field {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}

.shelf-exchange__field dt {
  color: var(--text-muted);
}

.shelf-exchange__field dd {
  margin: 0;
  font-weight: 600;
}

.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}

.actions .btn {
  flex: 1;
}
</style>
