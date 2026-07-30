<script setup lang="ts">
import type { TransactionLogRow } from "~/utils/flowApi";

// Shared audit-log table for the receiving / picking order detail pages.
// States render through the shared logStates.* labels with a raw fallback.

defineProps<{ logs: TransactionLogRow[] }>();

const { t, te } = useI18n();

function stateLabel(code: string | null): string {
  if (!code) return t("logStates.none");
  return te(`logStates.${code}`) ? t(`logStates.${code}`) : code;
}

// Known metadata keys rendered compactly; field/from/to get a dedicated
// "field: from → to" rendering; anything else (incl. {}) renders nothing.
const META_KEYS = [
  "reason",
  "mismatchQty",
  "wrongPartNo",
  "note",
  "resolutionNote",
  "qty",
  "packSize",
  "partNo",
  "poNo",
  "poLine",
];

function metadataText(log: TransactionLogRow): string {
  const m = log.metadata ?? {};
  const parts: string[] = [];
  if (m.field) parts.push(`${m.field}: ${m.from ?? "—"} → ${m.to ?? "—"}`);
  for (const k of META_KEYS) {
    const v = m[k];
    if (v === null || v === undefined || v === "") continue;
    parts.push(`${k}: ${k === "reason" ? stateLabel(String(v)) : v}`);
  }
  return parts.join(" · ");
}
</script>

<template>
  <h2 class="section-title">{{ t("admin.pages.auditLog.title") }}</h2>
  <div class="table-wrap">
    <table class="data">
      <thead>
        <tr>
          <th>{{ t("admin.pages.auditLog.time") }}</th>
          <th>{{ t("admin.pages.auditLog.actor") }}</th>
          <th>{{ t("admin.pages.auditLog.transition") }}</th>
          <th>{{ t("admin.pages.auditLog.details") }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="log in logs" :key="log.id">
          <td>{{ new Date(log.createdDate).toLocaleString() }}</td>
          <td>{{ log.actorName ?? log.actorId ?? "—" }}</td>
          <td>{{ stateLabel(log.fromState) }} → {{ stateLabel(log.toState) }}</td>
          <td>{{ metadataText(log) }}</td>
        </tr>
        <tr v-if="logs.length === 0">
          <td colspan="4" class="muted">{{ t("admin.pages.auditLog.empty") }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.section-title {
  font-size: 15px;
  margin: 18px 0 8px;
  color: #52606d;
}
</style>
