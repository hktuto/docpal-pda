<template>
  <div>
    <p class="card__meta" style="margin-bottom: 1rem;">
      Receiving orders with stock still in the receiving area.
    </p>

    <p v-if="pending" class="empty">Loading…</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">Error: {{ error }}</p>
    <p v-else-if="rows.length === 0" class="empty">No receiving orders need put-away.</p>

    <NuxtLink
      v-for="ro in rows"
      :key="ro.id"
      :to="`/put-away/${ro.id}`"
      class="card"
    >
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;">
        <div>
          <p class="card__title">{{ ro.ref_no }}</p>
          <p class="card__meta">
            {{ ro.supplier_name || "No supplier" }}
          </p>
        </div>
        <div style="text-align: right;">
          <span class="badge">{{ ro.status }}</span>
          <p class="card__meta" style="margin-top: 0.25rem;">
            {{ ro.available_qty }} available
          </p>
        </div>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { getPutAwayCandidates, type PutAwayCandidate } from "~/db/putAway";

definePageMeta({ title: "Put-away" });

const db = await useDb();

const pending = ref(true);
const error = ref<string | null>(null);
const rows = ref<PutAwayCandidate[]>([]);

async function load() {
  try {
    rows.value = await getPutAwayCandidates(db);
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    pending.value = false;
  }
}

onMounted(load);
</script>
