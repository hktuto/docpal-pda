<template>
  <MeasureBox :task-id="taskId" :box-id="boxId" :load-detail="loadDetail" mode="verify" />
</template>

<script setup lang="ts">
import MeasureBox from "~/components/MeasureBox.vue";
import { useWarehouse } from "~/composables/useWarehouse";

definePageMeta({ title: "meta.measureBox", props: { noPadding: true } });

const { t } = useI18n();
useHead({ title: t('measuring.measureBox.title') });

const route = useRoute();
const taskId = route.params.taskId as string;
const boxId = route.params.boxId as string;

const warehouse = useWarehouse();
const loadDetail = (id: string) => warehouse.getVerifyTask(id);
</script>
