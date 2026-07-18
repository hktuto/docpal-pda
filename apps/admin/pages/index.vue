<script setup lang="ts">
import { entityPages } from "~/utils/entities";
</script>

<template>
  <div>
    <div class="page-head">
      <h1>Master data</h1>
    </div>
    <div class="cards">
      <NuxtLink v-for="p in entityPages" :key="p.route" :to="p.route" class="card">
        <div class="card-title">{{ p.title }}</div>
        <div class="card-sub">/admin/{{ p.key }}</div>
      </NuxtLink>
      <NuxtLink to="/shelf-boxes" class="card">
        <div class="card-title">Shelf Boxes</div>
        <div class="card-sub">/admin/shelf-boxes</div>
      </NuxtLink>
    </div>
  </div>
</template>
