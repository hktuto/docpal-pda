<template>
  <div>
    <NuxtLink to="/receiving" class="card">
      <p class="card__title">Receiving</p>
      <p class="card__meta">Confirm arrivals, report mismatches, and create receiving-area inventory.</p>
    </NuxtLink>

    <NuxtLink to="/picking" class="card">
      <p class="card__title">Picking</p>
      <p class="card__meta">Scan items, confirm allocations, and finish picking orders.</p>
    </NuxtLink>

    <NuxtLink to="/picking-by-receiving" class="card">
      <p class="card__title">Picking by receiving</p>
      <p class="card__meta">Choose an in-hand receiving order and see which picking orders use its stock.</p>
    </NuxtLink>

    <NuxtLink to="/put-away" class="card">
      <p class="card__title">Put-away</p>
      <p class="card__meta">Move unallocated receiving stock into shelf boxes.</p>
    </NuxtLink>

    <NuxtLink to="/goods-verify" class="card">
      <p class="card__title">Goods Verify</p>
      <p class="card__meta">Verify shelf box contents against system records.</p>
    </NuxtLink>

    <NuxtLink to="/measuring" class="card">
      <p class="card__title">Measuring</p>
      <p class="card__meta">Weigh and pack shipping boxes.</p>
    </NuxtLink>

    <NuxtLink to="/ocr-demo" class="card">
      <p class="card__title">Camera OCR demo</p>
      <p class="card__meta">Take a photo and run on-device text recognition.</p>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ title: "Warehouse" });
</script>
