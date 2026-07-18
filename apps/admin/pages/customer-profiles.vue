<script setup lang="ts">
import { entities } from "~/utils/entities";
</script>

<template>
  <CrudTable :config="entities['customer-profiles']" />
</template>
