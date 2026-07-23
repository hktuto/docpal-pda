<script setup lang="ts">
import { navSections } from "~/utils/entities";
</script>

<template>
  <div>
    <div class="page-head">
      <h1>Warehouse Admin</h1>
    </div>
    <template v-for="s in navSections" :key="s.title">
      <h2 class="section-title">{{ s.title }}</h2>
      <div class="cards">
        <NuxtLink v-for="l in s.links" :key="l.route" :to="l.route" class="card">
          <div class="card-title">{{ l.title }}</div>
        </NuxtLink>
      </div>
    </template>
  </div>
</template>

<style scoped>
.section-title {
  font-size: 15px;
  margin: 18px 0 4px;
  color: #52606d;
}
</style>
