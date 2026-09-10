import { onBeforeUnmount, onMounted, type Ref } from "vue";

/**
 * Horizontal-scroll sync between elements sharing a key — for pages showing
 * the same table repeatedly (e.g. receiving detail's per-group tables), so
 * scrolling one table sideways scrolls its siblings. Module-level registry;
 * the admin app is SPA-only, so there is no cross-request leakage.
 */
const scrollGroups = new Map<string, Set<HTMLElement>>();
// Re-entrancy guard: assigning scrollLeft fires scroll events on the
// targets; ignore events we caused ourselves until the next frame.
let applying = false;

export function useSyncedScroll(key: string | undefined, el: Ref<HTMLElement | null>) {
  const onScroll = (event: Event) => {
    if (applying || !key) return;
    const source = event.currentTarget as HTMLElement;
    applying = true;
    for (const other of scrollGroups.get(key) ?? []) {
      if (other !== source && other.scrollLeft !== source.scrollLeft) {
        other.scrollLeft = source.scrollLeft;
      }
    }
    requestAnimationFrame(() => {
      applying = false;
    });
  };

  onMounted(() => {
    const element = el.value;
    if (!element || !key) return;
    let group = scrollGroups.get(key);
    if (!group) scrollGroups.set(key, (group = new Set()));
    // Align late-mounted members (e.g. tables rendered after the user has
    // already scrolled a sibling) with the group's current position.
    const existing = [...group][0];
    if (existing) element.scrollLeft = existing.scrollLeft;
    group.add(element);
    element.addEventListener("scroll", onScroll, { passive: true });
  });

  onBeforeUnmount(() => {
    const element = el.value;
    if (!element || !key) return;
    element.removeEventListener("scroll", onScroll);
    const group = scrollGroups.get(key);
    group?.delete(element);
    if (group?.size === 0) scrollGroups.delete(key);
  });
}
