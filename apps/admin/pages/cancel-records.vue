<script setup lang="ts">
import type { CancelRecordRow } from "~/utils/flowApi";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

// Cancel-invoice ingest log (spec 2026-11-07-cancel-invoice-putback-design.md):
// read-only table of what the cron did with each upstream cancel_invoice /
// cancel_invoice_tn row. Auto-refreshes on cancel_record.processed.
const flow = useFlowApi();
const { t } = useI18n();

const SOURCES = ["cancel_invoice", "cancel_invoice_tn"];
// no_match rows are never shown (hidden in the backend query) — the filter
// vocabulary only lists outcomes admins act on.
const OUTCOMES = ["cancelled", "cancelled_with_putback", "ignored", "error"];

const source = ref("");
const outcome = ref("");

const sourceOptions = computed<SearchableSelectOption[]>(() =>
  SOURCES.map((s) => ({ value: s, label: t(`cancelRecords.sources.${s}`) }))
);
const outcomeOptions = computed<SearchableSelectOption[]>(() =>
  OUTCOMES.map((o) => ({ value: o, label: t(`cancelRecords.outcomes.${o}`) }))
);

const rows = ref<CancelRecordRow[]>([]);
const loading = ref(true);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = await flow.listCancelRecords({
      source: source.value || undefined,
      outcome: outcome.value || undefined,
    });
  } catch (e: any) {
    error.value = e?.message ?? String(e);
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

// SSE reload (rows appear as the cron processes them).
useChangeNotice(["cancel_record.processed"], load);

// Filter changes reload the (server-side filtered) list immediately.
watch([source, outcome], load);

onMounted(load);

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("cancelRecords.title") }}</h1>
      <button class="btn" :disabled="loading" @click="load">
        {{ $t("admin.common.refresh") }}
      </button>
    </div>

    <p class="muted explainer">{{ $t("cancelRecords.explainer") }}</p>

    <div class="filters">
      <SearchableSelect
        v-model="source"
        :options="sourceOptions"
        :all-label="$t('admin.common.all')"
        :aria-label="$t('cancelRecords.colSource')"
        :multiple="false"
      />
      <SearchableSelect
        v-model="outcome"
        :options="outcomeOptions"
        :all-label="$t('admin.common.all')"
        :aria-label="$t('cancelRecords.colOutcome')"
        :multiple="false"
      />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <div v-else class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>{{ $t("cancelRecords.colSource") }}</th>
            <th>{{ $t("cancelRecords.colInvoice") }}</th>
            <th>{{ $t("cancelRecords.colLine") }}</th>
            <th>{{ $t("cancelRecords.colOrder") }}</th>
            <th>{{ $t("cancelRecords.colOutcome") }}</th>
            <th>{{ $t("cancelRecords.colPutBack") }}</th>
            <th>{{ $t("cancelRecords.colMessage") }}</th>
            <th>{{ $t("cancelRecords.colDate") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td>{{ $t(`cancelRecords.sources.${row.source}`) }}</td>
            <td>
              <NuxtLink v-if="row.pickingOrderId" :to="`/picking-orders/${row.pickingOrderId}`">
                {{ row.invoiceNum ?? "—" }}
              </NuxtLink>
              <span v-else>{{ row.invoiceNum ?? "—" }}</span>
            </td>
            <td>{{ row.tnLineId ?? "—" }}</td>
            <td>
              <NuxtLink v-if="row.pickingOrderId" :to="`/picking-orders/${row.pickingOrderId}`">
                {{ row.orderNo }}
              </NuxtLink>
              <span v-else>—</span>
            </td>
            <td :class="{ 'text-danger': row.status === 'error' }">
              {{ $t(`cancelRecords.outcomes.${row.outcome}`) }}
            </td>
            <td>{{ row.putBackTasks > 0 ? row.putBackTasks : "—" }}</td>
            <td class="muted">{{ row.message ?? "—" }}</td>
            <td>{{ fmt(row.createdDate) }}</td>
          </tr>
          <tr v-if="rows.length === 0">
            <td :colspan="8" class="muted">{{ $t("cancelRecords.none") }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.explainer {
  margin: 0 0 1rem;
}

.filters {
  display: flex;
  gap: 0.75rem;
  max-width: 32rem;
  margin-bottom: 1rem;
}

.text-danger {
  color: var(--danger, #dc2626);
  font-weight: 600;
}
</style>
