<script setup lang="ts">
// Hover/focus tooltip for allocation rows. The popup is teleported to <body>
// with fixed positioning because DataTable cells use overflow: hidden in
// fixed-layout mode, which would clip a cell-local absolutely positioned
// popup. Default slot = trigger content; "popup" slot = tooltip content.
// A short hide delay lets the pointer cross into the popup (e.g. to click a
// link) without it closing. The `side` prop controls placement: "auto"
// (default) opens beside the trigger (right first, flipping left), "right"/
// "left" force a side, "vertical" keeps the old below/above behavior.
const props = withDefaults(defineProps<{ side?: "auto" | "right" | "left" | "vertical" }>(), {
  side: "auto",
});
const open = ref(false);
const style = ref({ left: "0px", top: "0px" });
const popEl = ref<HTMLElement | null>(null);
const slots = useSlots();
let triggerEl: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

async function show(e: Event) {
  cancelHide();
  triggerEl = e.currentTarget as HTMLElement;
  open.value = true;
  await nextTick();
  position();
}

function position() {
  if (!triggerEl || !popEl.value) return;
  const r = triggerEl.getBoundingClientRect();
  const p = popEl.value;
  const gap = 6;
  const margin = 8;
  // Horizontal placement: right of the trigger, flipping left when it would
  // overflow the viewport; falls back to below/above when neither side fits.
  if (props.side !== "vertical") {
    const spaceRight = window.innerWidth - r.right - gap - margin;
    const spaceLeft = r.left - gap - margin;
    let left: number | null = null;
    if ((props.side === "right" || props.side === "auto") && p.offsetWidth <= spaceRight) {
      left = r.right + gap;
    } else if ((props.side === "left" || props.side === "auto") && p.offsetWidth <= spaceLeft) {
      left = r.left - p.offsetWidth - gap;
    } else if (props.side === "right" || props.side === "left") {
      // Forced side with no room: clamp to the viewport edge.
      left = Math.max(margin, Math.min(r.right + gap, window.innerWidth - p.offsetWidth - margin));
    }
    if (left !== null) {
      const top = Math.max(margin, Math.min(r.top, window.innerHeight - p.offsetHeight - margin));
      style.value = { left: `${left}px`, top: `${top}px` };
      return;
    }
  }
  // Prefer below the trigger; flip above when it would overflow the viewport.
  let top = r.bottom + gap;
  if (top + p.offsetHeight > window.innerHeight - margin) top = Math.max(margin, r.top - p.offsetHeight - gap);
  const left = Math.min(r.left, Math.max(margin, window.innerWidth - p.offsetWidth - margin));
  style.value = { left: `${left}px`, top: `${top}px` };
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => (open.value = false), 120);
}

function cancelHide() {
  clearTimeout(hideTimer);
}

// A scroll while open would leave the popup stranded away from its trigger.
function onScroll() {
  if (open.value) open.value = false;
}

onMounted(() => window.addEventListener("scroll", onScroll, true));
onBeforeUnmount(() => {
  window.removeEventListener("scroll", onScroll, true);
  clearTimeout(hideTimer);
});
</script>

<template>
  <span
    class="alloc-tip"
    tabindex="0"
    @mouseenter="show"
    @mouseleave="scheduleHide"
    @focusin="show"
    @focusout="scheduleHide"
  >
    <slot />
    <Teleport to="body">
      <div
        v-if="open && slots.popup"
        ref="popEl"
        class="alloc-tip-pop"
        :style="style"
        role="tooltip"
        @mouseenter="cancelHide"
        @mouseleave="scheduleHide"
        @focusin="cancelHide"
        @focusout="scheduleHide"
      >
        <slot name="popup" />
      </div>
    </Teleport>
  </span>
</template>
