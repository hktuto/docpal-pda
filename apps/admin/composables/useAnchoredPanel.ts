import { onScopeDispose, ref, watch, type Ref } from "vue";

/**
 * Positioning for dropdown panels that must escape an overflow-clipped
 * ancestor (DataTable cells clip absolutely-positioned children via
 * `td { overflow: hidden }`). Teleport the panel to <body>, give it
 * `position: fixed` with the returned style, and it tracks the anchor's
 * viewport position while open (any scroll — capture phase catches inner
 * scroll containers — and window resize).
 *
 * Usage:
 *   const { panelStyle } = useAnchoredPanel(rootRef, open);
 *   <Teleport to="body"><div v-if="open" :style="panelStyle" class="...">
 */
export function useAnchoredPanel(anchorRef: Ref<HTMLElement | null>, visible: Ref<boolean>) {
  const panelStyle = ref<{ top: string; left: string; minWidth: string } | null>(null);

  function update() {
    const anchor = anchorRef.value;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    panelStyle.value = {
      top: `${Math.round(rect.bottom + 3)}px`,
      left: `${Math.round(rect.left)}px`,
      minWidth: `${Math.round(rect.width)}px`,
    };
  }

  let detach: (() => void) | null = null;
  function attach() {
    const onChange = () => update();
    window.addEventListener("resize", onChange);
    // Scroll events don't bubble — capture phase on window catches scrolls
    // in any nested scroll container (the table wrap).
    window.addEventListener("scroll", onChange, true);
    detach = () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
    };
  }

  watch(
    visible,
    (v) => {
      detach?.();
      detach = null;
      if (!v) return;
      // The anchor is long-mounted (the input itself), so no nextTick needed
      // — flush:'pre' runs this before the panel's first render.
      update();
      attach();
    },
    { flush: "pre" }
  );
  onScopeDispose(() => detach?.());

  return { panelStyle };
}
