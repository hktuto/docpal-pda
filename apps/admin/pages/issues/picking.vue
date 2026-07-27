<script setup lang="ts">
import type { PickingOrderDetail, PickingOrderRow } from "~/utils/flowApi";

const flow = useFlowApi();
const { t } = useI18n();

// List rows carry no issue_* fields, so the detail of each status=issue order
// is fetched alongside (issue orders are rare — N+1 is fine here).
interface IssueRow {
  order: PickingOrderRow;
  detail: PickingOrderDetail;
}

const rows = ref<IssueRow[]>([]);
const loading = ref(false);
const error = ref("");
const resolving = ref<Record<string, boolean>>({});

const { page, pageSize, total, paged } = usePaging(rows);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const orders = await flow.listPickingOrders("issue");
    rows.value = await Promise.all(
      orders.map(async (order) => ({ order, detail: await flow.getPickingOrder(order.id) }))
    );
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

// Resolve returns the order to pending and re-runs allocation; the underlying
// cause (stock, pack size, …) must be fixed before resolving.
async function resolve(row: IssueRow) {
  const note = window.prompt(t("admin.pages.issues.resolvePrompt"));
  if (note === null) return;
  resolving.value[row.order.id] = true;
  error.value = "";
  try {
    await flow.resolvePickingIssue(row.order.id, note);
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    delete resolving.value[row.order.id];
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.issues.pickingTitle") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
      </div>
    </div>

    <p class="muted explainer">{{ $t("admin.pages.issues.pickingExplainer") }}</p>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <div v-else class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>{{ $t("admin.pages.issues.orderNo") }}</th>
            <th>{{ $t("admin.pages.issues.customer") }}</th>
            <th>{{ $t("admin.pages.issues.reason") }}</th>
            <th>{{ $t("admin.pages.issues.qty") }}</th>
            <th>{{ $t("admin.pages.issues.packSize") }}</th>
            <th>{{ $t("admin.pages.issues.note") }}</th>
            <th>{{ $t("admin.pages.issues.reportedAt") }}</th>
            <th>{{ $t("admin.common.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in paged"
            :key="r.order.id"
            class="clickable"
            @click="navigateTo(`/picking-orders/${r.order.id}`)"
          >
            <td>{{ r.order.orderNo }}</td>
            <td>{{ r.order.customerCode ?? "—" }}</td>
            <td>{{ r.detail.issueReason ?? "—" }}</td>
            <td>{{ r.detail.issueQty ?? "—" }}</td>
            <td>{{ r.detail.issuePackSize ?? "—" }}</td>
            <td>{{ r.detail.issueNote ?? "—" }}</td>
            <td>{{ r.detail.issueReportedAt ? new Date(r.detail.issueReportedAt).toLocaleString() : "—" }}</td>
            <td class="actions">
              <button
                class="btn btn-small btn-primary"
                :disabled="resolving[r.order.id]"
                @click.stop="resolve(r)"
              >
                {{ resolving[r.order.id] ? $t("admin.common.saving") : $t("admin.pages.issues.resolve") }}
              </button>
            </td>
          </tr>
          <tr v-if="total === 0">
            <td colspan="8" class="muted">{{ $t("admin.pages.issues.noPickingIssues") }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 10px;
}
.explainer {
  margin: 0 0 12px;
}
tr.clickable {
  cursor: pointer;
}
</style>
