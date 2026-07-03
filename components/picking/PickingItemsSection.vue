<template>
  <h2 class="section-title">Items</h2>
  <div
    v-for="item in items"
    :key="item.id"
    class="card"
    :class="{ 'card--done': item.pickedQty >= item.qty }"
    style="margin-bottom: 1.5rem;"
  >
    <DetailRow label="Part">
      <span class="card__title">{{ item.part?.partNo || "—" }}</span>
    </DetailRow>
    <DetailRow label="Required qty" :value="item.qty" />
    <DetailRow label="Scanned qty" :value="scannedQty(item)" />
    <DetailRow label="Boxed qty" :value="item.pickedQty" />
    <DetailRow label="Required date code" :value="item.requiredDateCode || '—'" />
    <DetailRow label="Status">
      <StatusBadge :status="item.pickedQty >= item.qty ? 'finished' : 'picking'">
        {{ item.pickedQty >= item.qty ? "Finished" : "Picking" }}
      </StatusBadge>
    </DetailRow>

    <div v-if="item.allocations?.filter((a: any) => a.qty > 0).length && order.status !== 'finished' && order.status !== 'issue' && item.pickedQty < item.qty" style="margin-top: 0.75rem;">
      <h3 class="subsection-title">Allocations</h3>
      <div
        v-for="allocation in item.allocations.filter((a: any) => a.qty > 0)"
        :key="allocation.id"
        class="lot"
      >
        <template v-if="allocation.inventoryLot">
          <DetailRow label="Location">
            <span v-if="allocation.inventoryLot.shelfCode && allocation.inventoryLot.boxId">
              {{ allocation.inventoryLot.shelfCode }} / {{ allocation.inventoryLot.boxId }}
            </span>
            <span v-else-if="allocation.inventoryLot.shelfCode">{{ allocation.inventoryLot.shelfCode }}</span>
            <span v-else-if="allocation.inventoryLot.boxId">{{ allocation.inventoryLot.boxId }}</span>
            <span v-else>Receiving area</span>
          </DetailRow>
          <DetailRow label="Date / Lot / COO / COW">
            {{ allocation.inventoryLot.dateCode || "—" }} /
            {{ allocation.inventoryLot.lotCode || "—" }} /
            {{ allocation.inventoryLot.coo || "—" }} /
            {{ allocation.inventoryLot.cow || "—" }}
          </DetailRow>
          <DetailRow label="Allocated qty" :value="allocation.qty" />
          <div style="margin-top: 0.5rem;">
            <button class="btn btn--small" :disabled="scanning" @click="emit('scan', allocation)">Scan</button>
          </div>
        </template>

        <template v-else-if="allocation.receivingInvoiceItem">
          <DetailRow label="Source">
            Receiving area
            <span v-if="allocation.receivingInvoiceItem.invoice?.receivingOrder?.refNo">
              ({{ allocation.receivingInvoiceItem.invoice.receivingOrder.refNo }})
            </span>
          </DetailRow>
          <DetailRow label="Allocated qty" :value="allocation.qty" />
          <div style="margin-top: 0.5rem;">
            <button class="btn btn--small" :disabled="scanning" @click="emit('scan', allocation)">Scan</button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="unboxedPackages(item).length && order.status !== 'finished' && order.status !== 'issue'" style="margin-top: 0.75rem;">
      <h3 class="subsection-title">Unboxed packages</h3>
      <div
        v-for="pkg in unboxedPackages(item)"
        :key="pkg.id"
        class="lot"
        style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; justify-content: space-between;"
      >
        <span style="font-size: 0.875rem;">
          {{ pkg.qty }} pcs · {{ pkg.dateCode || "—" }} / {{ pkg.lotCode || "—" }} / {{ pkg.coo || "—" }} / {{ pkg.cow || "—" }}
        </span>
        <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
          <select :value="boxSelections[pkg.id]" :disabled="adding[pkg.id]" style="min-width: 8rem;" @change="updateBoxSelection(pkg.id, ($event.target as HTMLSelectElement).value)">
            <option value="">Select box</option>
            <option v-for="box in openBoxes" :key="box.id" :value="box.id">{{ box.id }}</option>
          </select>
          <button
            class="btn btn--small"
            :disabled="adding[pkg.id] || !boxSelections[pkg.id]"
            @click="emit('add-to-box', pkg.id)"
          >
            {{ adding[pkg.id] ? "Adding…" : "Add to box" }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="boxedPackages(item).length && order.status !== 'finished' && order.status !== 'issue'" style="margin-top: 0.75rem;">
      <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">Boxed packages</h3>
      <div
        v-for="pkg in boxedPackages(item)"
        :key="pkg.id"
        class="lot"
        style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; justify-content: space-between;"
      >
        <span style="font-size: 0.875rem;">
          {{ pkg.qty }} pcs · {{ pkg.shippingBoxId }}
        </span>
        <button
          v-if="boxById[pkg.shippingBoxId!]?.status === 'open'"
          class="btn btn--small"
          :disabled="removing[pkg.id]"
          @click="emit('remove-from-box', pkg.id)"
        >
          {{ removing[pkg.id] ? "Removing…" : "Remove" }}
        </button>
      </div>
    </div>

    <div style="margin-top: 0.75rem;">
      <button class="btn btn--small btn--ghost" @click="toggleExpand(item.id)">
        {{ expandedItems.has(item.id) ? "Hide picking logs" : "Show picking logs" }}
        ({{ (transitionLogs[item.id] || []).length }})
      </button>

      <div v-if="expandedItems.has(item.id)" style="margin-top: 0.5rem;">
        <p v-if="!(transitionLogs[item.id] || []).length" class="card__meta">No picking logs.</p>
        <ul v-else style="margin: 0; padding-left: 1.25rem; font-size: 0.875rem; color: var(--muted);">
          <li v-for="log in transitionLogs[item.id]" :key="log.id" style="margin-bottom: 0.35rem;">
            {{ new Date(log.createdAt).toLocaleString() }}
            · {{ log.actorName || "System" }}
            · {{ log.fromState || "—" }} → {{ log.toState }}
            <span v-if="log.metadata">
              · {{ JSON.parse(log.metadata).qty ?? JSON.parse(log.metadata).note }}
            </span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  items: any[];
  order: any;
  transitionLogs: Record<string, any[]>;
  expandedItems: Set<string>;
  boxSelections: Record<string, string>;
  adding: Record<string, boolean>;
  removing: Record<string, boolean>;
  scanning: boolean;
  openBoxes: any[];
}>();

const emit = defineEmits<{
  "update:expandedItems": [value: Set<string>];
  "update:boxSelections": [value: Record<string, string>];
  scan: [allocation: any];
  "add-to-box": [packageId: string];
  "remove-from-box": [packageId: string];
}>();

const boxById = computed(() => {
  const map: Record<string, any> = {};
  for (const box of props.order?.shippingBoxes ?? []) {
    map[box.id] = box;
  }
  return map;
});

function scannedQty(item: any) {
  return (item.packages ?? []).reduce((sum: number, p: any) => sum + p.qty, 0);
}

function unboxedPackages(item: any) {
  return (item.packages ?? []).filter((p: any) => !p.shippingBoxId);
}

function boxedPackages(item: any) {
  return (item.packages ?? []).filter((p: any) => p.shippingBoxId);
}

function toggleExpand(itemId: string) {
  const next = new Set(props.expandedItems);
  if (next.has(itemId)) next.delete(itemId);
  else next.add(itemId);
  emit("update:expandedItems", next);
}

function updateBoxSelection(packageId: string, value: string) {
  emit("update:boxSelections", { ...props.boxSelections, [packageId]: value });
}

function issueReasonLabel(reason: any) {
  if (reason === "insufficient_stock") return "Insufficient stock";
  if (reason === "cannot_divide") return "Cannot divide quantity";
  if (reason === "merge") return "Merge orders";
  if (reason === "other") return "Other";
  return "—";
}
</script>
