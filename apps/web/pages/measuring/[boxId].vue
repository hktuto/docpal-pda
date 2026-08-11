<template>
  <MeasureBox
    :box-id="boxId"
    :load-detail="loadDetail"
    :order-nos="orderNos"
    mode="measuring"
    @finished="router.push('/measuring')"
  />
</template>

<script setup lang="ts">
import MeasureBox from "~/components/MeasureBox.vue";
import { useWarehouse } from "~/composables/useWarehouse";

definePageMeta({ title: "meta.measureBox", props: { noPadding: true } });

const { t } = useI18n();
useHead({ title: t('measuring.measureBox.title') });

const route = useRoute();
const router = useRouter();
const boxId = route.params.boxId as string;

const warehouse = useWarehouse();

const loadDetail = async () => {
  const d = await warehouse.getMeasuringBox(boxId);
  return {
    box: {
      id: d.boxId,
      pickingOrderId: d.pickingOrderId,
      status: d.status,
      boxSize: d.boxSize,
      grossWeight: d.grossWeight,
      netWeight: d.netWeight,
      suggestedNetWeightKg: d.suggestedNetWeightKg,
      destinationCountry: d.destinationCountry,
    },
    packages: d.packages,
  };
};

// The involved order numbers live only on the list rows — a best-effort
// side fetch for the header (the box detail itself carries none).
const orderNos = ref<string[]>([]);
onMounted(async () => {
  try {
    const boxes = await warehouse.getMeasuringBoxes();
    orderNos.value = boxes.find((b) => b.boxId === boxId)?.orderNos ?? [];
  } catch {
    // Header hint only — the box detail still loads.
  }
});
</script>
