<template>
  <div>
    <input
      v-model="search"
      class="search"
      type="text"
      placeholder="Search by ref or supplier…"
    />

    <p v-if="loading" class="empty">Loading…</p>
    <p v-else-if="loadError" class="empty" style="color: var(--danger);">Error: {{ loadError }}</p>
    <p v-else-if="rows.length === 0" class="empty">No picking orders found.</p>

    <NuxtLink
      v-for="po in rows"
      :key="po.id"
      :to="`/picking/${po.id}`"
      class="card list-card"
    >
      <div class="list-card__header">
        <span class="list-card__title">{{ po.ref_no }}</span>
        <span class="badge" :class="badgeClass(po.status)">{{ po.status }}</span>
      </div>
      <p class="list-card__meta">
        {{ po.supplier_name || "No supplier" }}
      </p>
      <div class="list-card__footer">
        <span class="list-card__date">
          {{ po.delivery_date ? new Date(po.delivery_date).toLocaleDateString() : "No date" }}
        </span>
        <span class="list-card__ship">Ship to: {{ po.ship_to || "—" }}</span>
      </div>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ title: "Picking" });

interface PickingOrderRow {
  id: string;
  ref_no: string;
  status: string;
  delivery_date: string | null;
  supplier_name: string | null;
  ship_to: string | null;
}

const db = await useDb();

const search = ref("");
const rawRows = ref<PickingOrderRow[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    const result = await db.execute<PickingOrderRow>(
      `SELECT po.id, po.ref_no, po.status, po.delivery_date, po.ship_to, s.name AS supplier_name
       FROM picking_orders po
       LEFT JOIN suppliers s ON po.supplier_id = s.id
       ORDER BY CASE WHEN po.status = 'finished' THEN 1 ELSE 0 END, po.delivery_date;`
    );
    rawRows.value = result.rows ?? [];
  } catch (e: any) {
    loadError.value = e?.message ?? String(e);
    rawRows.value = [];
  } finally {
    loading.value = false;
  }
}

const rows = computed(() => {
  const term = search.value.trim().toLowerCase();
  if (!term) return rawRows.value;
  return rawRows.value.filter(
    (r) =>
      r.ref_no.toLowerCase().includes(term) ||
      (r.supplier_name?.toLowerCase().includes(term) ?? false)
  );
});

onMounted(() => {
  load();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("focus", onVisible);
});

function onVisible() {
  if (document.visibilityState === "visible") {
    load();
  }
}

function badgeClass(status: string) {
  if (status === "finished") return "badge--finished";
  if (status === "pending") return "badge--pending";
  return "";
}
</script>

<style scoped>
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

.list-card__date,
.list-card__ship {
  font-size: 0.8125rem;
  color: var(--muted);
}

.list-card__ship {
  margin-left: auto;
}
</style>
