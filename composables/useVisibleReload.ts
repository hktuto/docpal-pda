export function useVisibleReload(load: () => void | Promise<void>) {
  async function onVisible() {
    if (document.visibilityState === "visible") {
      await load();
    }
  }

  onMounted(() => {
    load();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
  });

  onUnmounted(() => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
  });
}
