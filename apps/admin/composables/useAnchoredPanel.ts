import { nextTick, onScopeDispose, ref, watch, type Ref } from "vue";

/**
 * Positioning for dropdown panels that must escape an overflow-clipped
 * ancestor (DataTable cells clip absolutely-positioned children via
 * `td { overflow: hidden }`). Teleport the panel to <body>, give it
 * `position: fixed` with the returned style, and it tracks the anchor's
 * viewport position while open (any scroll — capture phase catches inner
 * scroll containers — and window resize).
 *
 * Prefers below the anchor; flips above when the viewport has more room
 * there (e.g. Pager page-size at the table footer).
 *
 * Usage:
 *   const { panelStyle } = useAnchoredPanel(rootRef, open, panelRef);
 *   <Teleport to="body"><div v-if="open" ref="panelRef" :style="panelStyle" class="...">
 */
export function useAnchoredPanel(
  anchorRef: Ref<HTMLElement | null>,
  visible: Ref<boolean>,
  panelRef?: Ref<HTMLElement | null>
) {
  const panelStyle = ref<{
    top: string;
    bottom: string;
    left: string;
    minWidth: string;
  } | null>(null);

  // Used before the panel mounts (flush:'pre'); remasured after nextTick.
  const FALLBACK_H = 280;

  function update() {
    const anchor = anchorRef.value;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const gap = 3;
    const panelH = panelRef?.value?.offsetHeight || FALLBACK_H;
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openUp = spaceBelow < panelH && spaceAbove > spaceBelow;

    panelStyle.value = openUp
      ? {
          top: "auto",
          bottom: `${Math.round(window.innerHeight - rect.top + gap)}px`,
          left: `${Math.round(rect.left)}px`,
          minWidth: `${Math.round(rect.width)}px`,
        }
      : {
          top: `${Math.round(rect.bottom + gap)}px`,
          bottom: "auto",
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
      // Remasure with the real panel height once it is in the DOM.
      if (panelRef) nextTick(update);
    },
    { flush: "pre" }
  );
  onScopeDispose(() => detach?.());

  return { panelStyle };
}
