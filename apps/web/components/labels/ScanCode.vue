<script setup lang="ts">
// Scannable code for printed labels: QR (bwip-js) or Code128 (JsBarcode),
// rendered client-side whenever the value changes.
import { ref, watch, onMounted } from "vue";
import bwipjs from "bwip-js";
import JsBarcode from "jsbarcode";

const props = withDefaults(
  defineProps<{ value: string; kind: "qr" | "code128"; height?: number }>(),
  { height: 0 }
);

const canvas = ref<HTMLCanvasElement | null>(null);
const svg = ref<SVGElement | null>(null);

function render() {
  if (!props.value) return;
  if (props.kind === "qr" && canvas.value) {
    try {
      bwipjs.toCanvas(canvas.value, {
        bcid: "qrcode",
        text: props.value,
        scale: 3,
        eclevel: "M",
      });
    } catch {
      // leave blank — a bad value must not break the whole sheet
    }
  } else if (props.kind === "code128" && svg.value) {
    try {
      JsBarcode(svg.value, props.value, {
        format: "CODE128",
        width: 1.6,
        height: props.height || 32,
        displayValue: false,
        margin: 0,
        background: "transparent",
      });
    } catch {
      // same
    }
  }
}

onMounted(render);
watch(() => props.value, render);
</script>

<template>
  <canvas v-if="kind === 'qr'" ref="canvas" class="scan-code scan-code--qr" aria-hidden="true"></canvas>
  <svg v-else ref="svg" class="scan-code scan-code--bar" aria-hidden="true"></svg>
</template>

<style scoped>
.scan-code {
  display: block;
  max-width: 100%;
}
.scan-code--qr {
  width: 100%;
  height: auto;
  aspect-ratio: 1;
}
.scan-code--bar {
  width: 100%;
}
</style>
