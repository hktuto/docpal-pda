<template>
  <div>
    <p class="page-hint">
      Receiving orders with stock still in the receiving area.
    </p>

    <p v-if="pending" class="empty">Loading…</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">Error: {{ error }}</p>
    <p v-else-if="rows.length === 0" class="empty">No receiving orders need put-away.</p>

    <NuxtLink
      v-for="ro in rows"
      :key="ro.id"
      :to="`/put-away/${ro.id}`"
      class="card list-card"
    >
      <div class="list-card__header">
        <span class="list-card__title">{{ ro.ref_no }}</span>
        <span class="badge" :class="badgeClass(ro.status)">{{ ro.status }}</span>
      </div>
      <p class="list-card__meta">
        {{ ro.supplier_name || "No supplier" }}
      </p>
      <div class="list-card__footer">
        <span class="list-card__date">{{ ro.available_qty }} available</span>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { getPutAwayCandidates, type PutAwayCandidate } from "~/db/putAway";

const { badgeClass } = useStatusBadge();

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

function onVisible() {
  if (document.visibilityState === "visible") {
    load();
  }
}

onMounted(() => {
  load();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("focus", onVisible);
});
</script>

<style scoped>
.page-hint {
  margin: -0.25rem 0 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}

.list-card {
  display: block;
  text-decoration: none;
}

.list-card:hover {
  text-decoration: none;
}

.list-card__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
  margin-bottom: 0.35rem;
}

.list-card__title {
  font-size: 1.0625rem;
  font-weight: 700;
  color: var(--text);
}

.list-card__meta {
  font-size: 0.875rem;
  color: var(--muted);
  margin: 0 0 0.75rem;
}

.list-card__footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.list-card__date {
  font-size: 0.8125rem;
  color: var(--muted);
}
</style>
