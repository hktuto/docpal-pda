<script setup lang="ts">
// Hover/focus tooltip for allocation rows. The popup is teleported to <body>
// with fixed positioning because DataTable cells use overflow: hidden in
// fixed-layout mode, which would clip a cell-local absolutely positioned
// popup. Default slot = trigger content; "popup" slot = tooltip content.
// A short hide delay lets the pointer cross into the popup (e.g. to click a
// link) without it closing.
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
  // Prefer below the trigger; flip above when it would overflow the viewport.
  let top = r.bottom + 6;
  if (top + p.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - p.offsetHeight - 6);
  const left = Math.min(r.left, Math.max(8, window.innerWidth - p.offsetWidth - 8));
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
