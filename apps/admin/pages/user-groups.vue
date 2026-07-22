<script setup lang="ts">
import { entities } from "~/utils/entities";
</script>

<template>
  <CrudTable :config="entities['user-groups']" />
</template>
