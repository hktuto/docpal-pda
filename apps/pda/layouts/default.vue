<template>
  <div class="app">
    <AppHeader />
    <main :class="['container', { 'no-padding': $route?.meta?.props?.noPadding }]">
      <slot />
    </main>
    <ToastHost />
    <OutdatedWarningDialog />
  </div>
</template>

<script setup lang="ts">
import { pushLog, setLoggedRoute } from "~/utils/activityLog";

const { currentUser } = useAuth();
const events = useWarehouseEvents();
const { loadFlowSteps } = useFlowSteps();
const route = useRoute();
const router = useRouter();

// Bug-report trail wiring (spec 2026-11-05-in-app-bug-report-design.md):
// route changes + unhandled JS errors feed the ring buffer from one place.
setLoggedRoute(route.fullPath);
router.afterEach((to) => {
  setLoggedRoute(to.fullPath);
  pushLog("route", to.fullPath);
});
onMounted(() => {
  const onError = (e: ErrorEvent) => pushLog("error", `${e.message} at ${e.filename}:${e.lineno}`);
  const onRejection = (e: PromiseRejectionEvent) => pushLog("error", String(e.reason).slice(0, 200));
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  onUnmounted(() => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  });
});

// The event stream follows the session: connect when logged in (including
// after restore()), disconnect on logout. The flow-step config is also
// (re)fetched on login so env-disabled steps hide their home tiles.
watch(
  currentUser,
  (user) => {
    if (user) {
      events.connect();
      void loadFlowSteps();
    } else {
      events.disconnect();
    }
  },
  { immediate: true }
);

// Config changes (admin flow-config / display settings) reach the PDA two
// ways: the config.updated SSE event, and a refetch whenever the app returns
// to the foreground (covers a dropped event stream). Without these the config
// was only fetched at login and list pages kept rendering stale settings.
onMounted(() => {
  const unsubscribe = events.subscribe(["/config"], () => void loadFlowSteps());
  const onVisible = () => {
    if (document.visibilityState === "visible" && currentUser.value) void loadFlowSteps();
  };
  document.addEventListener("visibilitychange", onVisible);
  onUnmounted(() => {
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisible);
  });
});
</script>

<style scoped>
.container.no-padding {
  padding-top: 0;
}
</style>
