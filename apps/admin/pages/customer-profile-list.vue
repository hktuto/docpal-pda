<script setup lang="ts">
import { entities } from "~/utils/entities";
</script>

<template>
  <CrudTable :config="entities.customerProfiles">
    <template #head-actions>
      <NuxtLink to="/customer-profiles" class="btn">
        {{ $t("admin.pages.customerProfiles.title") }}
      </NuxtLink>
    </template>
  </CrudTable>
</template>
