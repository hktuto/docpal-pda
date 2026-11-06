<template>
  <div>
    <div class="card">
      <p class="card__meta">{{ t("latencyTest.description", { count: TOTAL_CALLS, seconds: INTERVAL_MS / 1000 }) }}</p>
      <div class="actions">
        <button type="button" class="btn" :disabled="running" @click="start">
          {{ running ? t("latencyTest.running", { done: samples.length + failures, total: TOTAL_CALLS }) : t("latencyTest.start") }}
        </button>
        <button v-if="running" type="button" class="btn" @click="stop">
          {{ t("latencyTest.stop") }}
        </button>
      </div>
    </div>

    <div v-if="stats" class="card">
      <div class="detail-row">
        <span class="detail-label">{{ t("latencyTest.successful") }}</span>
        <span>{{ stats.count }} / {{ TOTAL_CALLS }}</span>
      </div>
      <div v-if="failures" class="detail-row">
        <span class="detail-label">{{ t("latencyTest.failed") }}</span>
        <span class="text--danger">{{ failures }}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">{{ t("latencyTest.avg") }}</span>
        <span class="stat--avg">{{ Math.round(stats.avg) }} ms</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">{{ t("latencyTest.min") }}</span>
        <span>{{ stats.min }} ms</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">{{ t("latencyTest.max") }}</span>
        <span>{{ stats.max }} ms</span>
      </div>

      <div class="samples">
        <span
          v-for="(ms, i) in samples"
          :key="i"
          class="sample-chip"
          :title="`#${i + 1}: ${ms} ms`"
        >{{ ms }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Network latency probe: fires GET /latency-ping at the backend once per
// second for 30 s and reports the averaged client-measured round trip.
// Useful for diagnosing slow remote deployments from the device itself.

definePageMeta({ title: "meta.latencyTest" });

const { t } = useI18n();
useHead({ title: t("meta.latencyTest") });

const TOTAL_CALLS = 30;
const INTERVAL_MS = 1000;

const running = ref(false);
const samples = ref<number[]>([]);
const failures = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
let fired = 0;

const stats = computed(() => {
  const s = samples.value;
  if (!s.length) return null;
  return {
    count: s.length,
    avg: s.reduce((a, b) => a + b, 0) / s.length,
    min: Math.min(...s),
    max: Math.max(...s),
  };
});

async function fireOnce() {
  const started = performance.now();
  // AbortController + manual timer instead of AbortSignal.timeout, which is
  // only available from Chrome 103 — the T23X fleet WebView is Chrome 101.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    // Tokenless endpoint — no auth header needed, measures pure round trip.
    await fetch(`${getApiBaseUrl()}/latency-ping`, {
      cache: "no-store",
      signal: controller.signal,
    });
    samples.value.push(Math.round(performance.now() - started));
  } catch {
    failures.value++;
  } finally {
    clearTimeout(timeout);
  }
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  running.value = false;
}

function start() {
  stop();
  samples.value = [];
  failures.value = 0;
  fired = 0;
  running.value = true;
  fireOnce();
  fired++;
  timer = setInterval(() => {
    if (fired >= TOTAL_CALLS) {
      stop();
      return;
    }
    fireOnce();
    fired++;
  }, INTERVAL_MS);
}

onBeforeUnmount(stop);
</script>

<style scoped>
.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.stat--avg {
  font-weight: 700;
}

.samples {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.5rem;
}

.sample-chip {
  padding: 0.125rem 0.375rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

.text--danger {
  color: var(--danger);
}
</style>
