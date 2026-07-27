<script setup lang="ts">
import type { MismatchListRow } from "~/utils/flowApi";

const flow = useFlowApi();
const rows = ref<MismatchListRow[]>([]);
const loading = ref(false);
const error = ref("");

// Per-row action in flight: itemId -> "confirm" | "cancel".
const acting = ref<Record<string, string>>({});

const { page, pageSize, total, paged } = usePaging(rows);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = await flow.listReceivingMismatches();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

// Confirm acknowledges the report (flag stays, audit log written); Cancel
// clears the mismatch, so the row disappears from this list.
async function act(row: MismatchListRow, action: "confirm" | "cancel") {
  acting.value[row.itemId] = action;
  error.value = "";
  try {
    if (action === "confirm") await flow.confirmReceivingMismatch(row.itemId);
    else await flow.cancelReceivingMismatch(row.itemId);
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    delete acting.value[row.itemId];
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.issues.receivingTitle") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
      </div>
    </div>

    <p class="muted explainer">{{ $t("admin.pages.issues.receivingExplainer") }}</p>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <div v-else class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>{{ $t("admin.pages.issues.batchNo") }}</th>
            <th>{{ $t("admin.pages.issues.invoiceNo") }}</th>
            <th>{{ $t("admin.pages.issues.partNo") }}</th>
            <th>{{ $t("admin.pages.issues.supplier") }}</th>
            <th>{{ $t("admin.pages.issues.reason") }}</th>
            <th>{{ $t("admin.pages.issues.qty") }}</th>
            <th>{{ $t("admin.pages.issues.wrongPartNo") }}</th>
            <th>{{ $t("admin.pages.issues.note") }}</th>
            <th>{{ $t("admin.common.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in paged"
            :key="r.itemId"
            class="clickable"
            @click="navigateTo(`/receiving/${r.receivingOrderId}`)"
          >
            <td>{{ r.batchNo }}</td>
            <td>{{ r.invoiceNo }}</td>
            <td>{{ r.partNo }}</td>
            <td>{{ r.supplierCode ?? "—" }}</td>
            <td>{{ r.reason ?? "—" }}</td>
            <td>{{ r.mismatchQty ?? "—" }}</td>
            <td>{{ r.wrongPartNo ?? "—" }}</td>
            <td>{{ r.note ?? "—" }}</td>
            <td class="actions">
              <button
                class="btn btn-small btn-primary"
                :disabled="!!acting[r.itemId]"
                @click.stop="act(r, 'confirm')"
              >
                {{ acting[r.itemId] === "confirm" ? $t("admin.common.saving") : $t("admin.pages.issues.confirm") }}
              </button>
              <button
                class="btn btn-small"
                :disabled="!!acting[r.itemId]"
                @click.stop="act(r, 'cancel')"
              >
                {{ acting[r.itemId] === "cancel" ? $t("admin.common.saving") : $t("admin.common.cancel") }}
              </button>
            </td>
          </tr>
          <tr v-if="total === 0">
            <td colspan="9" class="muted">{{ $t("admin.pages.issues.noReceivingIssues") }}</td>
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
td.actions {
  white-space: nowrap;
}
td.actions .btn + .btn {
  margin-left: 6px;
}
</style>
