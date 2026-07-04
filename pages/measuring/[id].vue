<template>
  <div>
    <p v-if="pending" class="empty">Loading…</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">Error: {{ error }}</p>

    <template v-else-if="task">
      <DetailHeader
        v-model="headerExpanded"
        :title="task.pickingOrder?.refNo || '—'"
        :status="task.status"
        :flush-top="route.meta.props?.noPadding"
        style="margin-bottom: 1.5rem;"
      >
        <template #actions>
          <NuxtLink
            v-if="task.pickingOrder?.status === 'finished'"
            :to="`/picking/${task.pickingOrderId}`"
            class="btn btn--small"
          >
            View picking order
          </NuxtLink>
        </template>

        <div class="detail-row">
          <span class="detail-label">Supplier</span>
          <span>{{ task.pickingOrder?.supplier?.name || "—" }}</span>
        </div>
      </DetailHeader>

      <h2 class="section-title">Boxes</h2>
      <p v-if="!task.shippingBoxes.length" class="empty">No shipping boxes yet.</p>

      <div
        v-for="box in task.shippingBoxes"
        :key="box.id"
        class="card"
        style="margin-bottom: 1.5rem;"
      >
        <div class="detail-row">
          <span class="detail-label">Box</span>
          <span class="card__title">{{ box.id }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Status</span>
          <span class="badge">{{ box.status }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Packages</span>
          <span>{{ verifiedCount(box) }} / {{ box.packages.length }} verified</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Measurements</span>
          <span style="text-align: right; font-size: 0.8125rem;">
            {{ box.boxSize || "—" }}
            · {{ box.grossWeight ?? "—" }} / {{ box.netWeight ?? "—" }} kg
            · {{ box.destinationCountry || "—" }}
          </span>
        </div>

        <div style="margin-top: 0.75rem;">
          <NuxtLink
            :to="`/measuring/${task.id}/box/${box.id}`"
            class="btn"
            :class="{ 'btn--small': box.status === 'closed' }"
          >
            {{ box.status === 'closed' ? "View box" : "Open box" }}
          </NuxtLink>
        </div>
      </div>

      <div v-if="canComplete" style="margin-top: 1.5rem;">
        <button class="btn" @click="complete" :disabled="completing">
          {{ completing ? "Completing…" : "Complete measuring" }}
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { getMeasuringTaskDetail, completeMeasuringTask, type MeasuringTaskDetail } from "~/db/measuring";
import { useErrorMessage } from "~/composables/errorMessage";

definePageMeta({ title: "Measuring Detail", props: { noPadding: true } });

const errorMessage = useErrorMessage();

const route = useRoute();
const taskId = route.params.id as string;

const db = await useDb();
const { currentUser } = useAuth();

const pending = ref(true);
const error = ref<string | null>(null);
const task = ref<MeasuringTaskDetail | null>(null);
const headerExpanded = ref(false);
const completing = ref(false);

async function load() {
  try {
    const data = await getMeasuringTaskDetail(db, taskId);
    task.value = data ?? null;
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

function verifiedCount(box: MeasuringTaskDetail["shippingBoxes"][number]) {
  return box.packages.filter((p) => p.verified).length;
}

const canComplete = computed(() => {
  if (!task.value || task.value.status !== "pending") return false;
  return task.value.shippingBoxes.length > 0 && task.value.shippingBoxes.every((box) => box.status === "closed");
});

async function complete() {
  completing.value = true;
  try {
    if (!currentUser.value) throw new Error("No operator user found");
    await completeMeasuringTask(db, taskId, currentUser.value.id);
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    completing.value = false;
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
