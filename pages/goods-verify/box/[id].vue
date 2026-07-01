<template>
  <div>
    <p v-if="pending" class="empty">Loading…</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">Error: {{ error }}</p>

    <template v-else-if="box">
      <div class="card" style="margin-bottom: 1.5rem;">
        <div class="detail-row">
          <span class="detail-label">Box</span>
          <span class="card__title">{{ box.id }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Shelf</span>
          <span>{{ box.shelfCode || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Status</span>
          <span class="badge">{{ box.status }}</span>
        </div>
      </div>

      <template v-if="box.status !== 'verified'">
        <div class="card" style="margin-bottom: 1.5rem;">
          <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
            <input
              v-model="scanPartNo"
              type="text"
              placeholder="Scan part number"
              style="flex: 1; min-width: 10rem;"
              :disabled="verifying"
              @keydown.enter="verifyScan"
            />
            <button
              class="btn"
              :disabled="verifying || !scanPartNo.trim()"
              @click="verifyScan"
            >
              {{ verifying ? "Verifying…" : "Verify" }}
            </button>
          </div>
        </div>

        <div
          v-if="allVerified"
          style="margin-bottom: 1.5rem;"
        >
          <button
            class="btn"
            :disabled="marking"
            @click="markVerified"
          >
            {{ marking ? "Marking…" : "Mark box verified" }}
          </button>
        </div>
      </template>

      <h2 style="margin-top: 0; margin-bottom: 1rem; font-size: 1rem;">Expected items</h2>
      <p v-if="box.items.length === 0" class="empty" style="padding: 0;">No items in this box.</p>

      <div
        v-for="item in box.items"
        :key="item.id"
        class="card"
        :class="{ 'card--done': item.verified }"
      >
        <div class="detail-row">
          <span class="detail-label">Part</span>
          <span class="card__title">{{ item.part?.partNo || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Qty</span>
          <span>{{ item.qty }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Verified</span>
          <span>{{ item.verified ? "Yes" : "No" }}</span>
        </div>
      </div>
    </template>

    <p v-else class="empty">Box not found.</p>
  </div>
</template>

<script setup lang="ts">
import {
  getShelfBoxDetail,
  verifyShelfBoxItem,
  markShelfBoxVerified,
  type ShelfBoxDetail,
} from "~/db/goodsVerify";

definePageMeta({ title: "Verify Box" });

const route = useRoute();
const boxId = route.params.id as string;

const db = useDb();
const currentUser = await useCurrentUser();

const pending = ref(true);
const error = ref<string | null>(null);
const box = ref<ShelfBoxDetail | null>(null);
const scanPartNo = ref("");
const verifying = ref(false);
const marking = ref(false);

const allVerified = computed(() =>
  box.value ? box.value.items.every((item) => item.verified) : false
);

async function load() {
  pending.value = true;
  error.value = null;
  try {
    box.value = await getShelfBoxDetail(db, boxId);
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    pending.value = false;
  }
}

async function verifyScan() {
  if (!box.value) return;
  const partNo = scanPartNo.value.trim();
  if (!partNo) return;

  const item = box.value.items.find(
    (i) => !i.verified && i.part?.partNo === partNo
  );

  if (!item) {
    error.value = "No unverified item matches that part number";
    return;
  }

  error.value = null;
  verifying.value = true;
  try {
    await verifyShelfBoxItem(db, item.id);
    scanPartNo.value = "";
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    verifying.value = false;
  }
}

async function markVerified() {
  if (!box.value) return;
  if (!currentUser) {
    error.value = "No operator user found";
    return;
  }

  error.value = null;
  marking.value = true;
  try {
    await markShelfBoxVerified(db, box.value.id, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    marking.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.card--done {
  border-left: 4px solid #22c55e;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--border);
}

.detail-row:last-child {
  border-bottom: none;
}

.detail-label {
  font-size: 0.8125rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
</style>
