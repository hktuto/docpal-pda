<template>
  <header class="app-header">
    <button
      v-if="showBack"
      class="app-header__back"
      aria-label="Go back"
      @click="goBack"
    >
      ←
    </button>
    <div v-else class="app-header__spacer" />

    <h1 class="app-header__title">{{ title }}</h1>

    <div class="app-header__menu">
      <button
        class="app-header__menu-btn"
        aria-label="Menu"
        @click="menuOpen = !menuOpen"
      >
        ⋮
      </button>
      <div v-if="menuOpen" class="app-header__dropdown">
        <button @click="resetDb">Reset local DB</button>
        <button @click="logout">Logout</button>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { injectPGlite } from "@electric-sql/pglite-vue";

const route = useRoute();
const router = useRouter();
const { logout: authLogout } = useAuth();
const pg = injectPGlite();

const title = computed(() => (route.meta.title as string) || "Warehouse");
const showBack = computed(() => route.path !== "/home" && route.path !== "/");
const menuOpen = ref(false);

function goBack() {
  if (window.history.length > 1) {
    router.back();
  } else {
    navigateTo("/home");
  }
}

function logout() {
  authLogout();
  menuOpen.value = false;
  navigateTo("/");
}

async function resetDb() {
  if (!confirm("Reset all local data? This cannot be undone.")) return;
  menuOpen.value = false;

  if (pg) {
    await pg.close();
  }

  const dbName = "/pglite/warehouse-demo-pglite";
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });

  localStorage.clear();
  window.location.reload();
}
</script>
