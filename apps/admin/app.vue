<script setup lang="ts">
import { entityPages } from "~/utils/entities";

const route = useRoute();
const user = ref<{ displayName?: string } | null>(null);

function refreshUser() {
  if (!import.meta.client) return;
  const raw = localStorage.getItem("admin_user");
  user.value = raw ? JSON.parse(raw) : null;
}

watch(() => route.path, refreshUser);
onMounted(refreshUser);

const isLogin = computed(() => route.path === "/login");

function logout() {
  localStorage.removeItem("admin_user");
  user.value = null;
  navigateTo("/login");
}
</script>

<template>
  <div>
    <header v-if="!isLogin" class="topnav">
      <div class="topnav-inner">
        <NuxtLink to="/" class="brand">Warehouse Admin</NuxtLink>
        <nav>
          <NuxtLink v-for="p in entityPages" :key="p.route" :to="p.route">{{ p.title }}</NuxtLink>
          <NuxtLink to="/shelf-boxes">Shelf Boxes</NuxtLink>
        </nav>
        <div class="userbox">
          <span>{{ user?.displayName }}</span>
          <button class="btn btn-small" @click="logout">Logout</button>
        </div>
      </div>
    </header>
    <main :class="isLogin ? '' : 'container'">
      <NuxtPage />
    </main>
  </div>
</template>
