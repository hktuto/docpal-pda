<template>
  <div>
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>
    <EmptyState v-else-if="!taskId" error>{{ $t('errors.verify_task_not_found') }}</EmptyState>

    <template v-else>
      <MeasureBox
        :box-id="boxId"
        :load-detail="loadDetail"
        :order-nos="orderNos"
        :reload-token="reloadToken"
        mode="verify"
      />

      <div class="verify-actions">
        <button
          v-if="canReopen"
          class="btn btn--ghost"
          :disabled="reopening"
          @click="reopen"
        >
          {{ reopening ? $t('verify.detail.reopening') : $t('actions.reopenBox') }}
        </button>
        <button
          v-if="canComplete"
          class="btn"
          :disabled="completing"
          @click="complete"
        >
          {{ completing ? $t('verify.detail.completing') : $t('verify.detail.completeVerify') }}
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import MeasureBox from "~/components/MeasureBox.vue";
import EmptyState from "~/components/EmptyState.vue";
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { useToast } from "~/composables/useToast";
import type { VerifyTaskDetail } from "~/services/types";

definePageMeta({ title: "meta.measureBox", props: { noPadding: true } });

const { t } = useI18n();
useHead({ title: t('measuring.measureBox.title') });

const route = useRoute();
const router = useRouter();
const boxId = route.params.boxId as string;

const warehouse = useWarehouse();
const errorMessage = useErrorMessage();
const { showToast } = useToast();

const pending = ref(true);
const error = ref<string | null>(null);
const taskId = ref<string | null>(null);
const orderNos = ref<string[]>([]);
const detail = ref<VerifyTaskDetail | null>(null);
const reloadToken = ref(0);
const reopening = ref(false);
const completing = ref(false);

// The verify reads are task-keyed while the route is box-keyed: find the
// box's pending verify task in the list first (POC scale — the list is the
// work queue anyway).
async function findTask() {
  try {
    const tasks = await warehouse.getVerifyTasks("pending");
    const row = tasks.find((task) => task.shippingBoxId === boxId) ?? null;
    taskId.value = row?.taskId ?? null;
    orderNos.value = row?.orderNos ?? [];
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

onMounted(findTask);

const loadDetail = async () => {
  const d = await warehouse.getVerifyTask(taskId.value!);
  detail.value = d;
  return { box: d.box, packages: d.packages };
};

// Mirrors the backend guard: the box closed AND every package re-scanned
// (verify_verified) before the verify pass can complete.
const canComplete = computed(() => {
  const d = detail.value;
  if (!d || d.task.status !== "pending") return false;
  if (d.box.status !== "closed" || !d.packages.length) return false;
  return d.packages.every((p) => p.verifyVerified);
});

// Reopen a closed box so the worker can re-measure it during this verify
// task (backend: box → open, packages un-verified, task stays pending).
const canReopen = computed(
  () => detail.value?.task.status === "pending" && detail.value.box.status === "closed"
);

async function reopen() {
  reopening.value = true;
  try {
    await warehouse.reopenShippingBox(boxId);
    reloadToken.value += 1;
  } catch (e: unknown) {
    showToast(errorMessage(e));
  } finally {
    reopening.value = false;
  }
}

async function complete() {
  if (!taskId.value) return;
  completing.value = true;
  try {
    await warehouse.completeVerifyTask(taskId.value);
    router.push("/verify");
  } catch (e: unknown) {
    showToast(errorMessage(e));
  } finally {
    completing.value = false;
  }
}
</script>

<style scoped>
.verify-actions {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}
</style>
