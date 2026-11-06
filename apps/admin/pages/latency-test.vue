<script setup lang="ts">
// Network latency probe: fires GET /latency-ping at the backend once per
// second for 30 s and reports the averaged client-measured round trip.
// Useful for diagnosing slow remote deployments.

const api = useApi();
const { t } = useI18n();

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
  try {
    await api.get("/latency-ping");
    samples.value.push(Math.round(performance.now() - started));
  } catch {
    failures.value++;
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

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.latencyTest.title") }}</h1>
    </div>

    <div class="card form-card">
      <p class="hint-text">
        {{ $t("admin.pages.latencyTest.description", { count: TOTAL_CALLS, seconds: INTERVAL_MS / 1000 }) }}
      </p>
      <div class="actions-row">
        <button class="btn btn-primary" :disabled="running" @click="start">
          {{ running ? $t("admin.pages.latencyTest.running", { done: samples.length + failures, total: TOTAL_CALLS }) : $t("admin.pages.latencyTest.start") }}
        </button>
        <button v-if="running" class="btn" @click="stop">
          {{ $t("admin.pages.latencyTest.stop") }}
        </button>
      </div>
    </div>

    <div v-if="stats" class="card">
      <table class="stats-table">
        <tbody>
          <tr>
            <td>{{ $t("admin.pages.latencyTest.successful") }}</td>
            <td>{{ stats.count }} / {{ TOTAL_CALLS }}</td>
          </tr>
          <tr v-if="failures">
            <td>{{ $t("admin.pages.latencyTest.failed") }}</td>
            <td class="error-text">{{ failures }}</td>
          </tr>
          <tr>
            <td>{{ $t("admin.pages.latencyTest.avg") }}</td>
            <td><strong>{{ Math.round(stats.avg) }} ms</strong></td>
          </tr>
          <tr>
            <td>{{ $t("admin.pages.latencyTest.min") }}</td>
            <td>{{ stats.min }} ms</td>
          </tr>
          <tr>
            <td>{{ $t("admin.pages.latencyTest.max") }}</td>
            <td>{{ stats.max }} ms</td>
          </tr>
        </tbody>
      </table>

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

<style scoped>
.form-card {
  margin-bottom: 1rem;
}

.hint-text {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  color: var(--muted, #666);
}

.actions-row {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.stats-table td {
  padding: 0.25rem 1rem 0.25rem 0;
}

.samples {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.75rem;
}

.sample-chip {
  padding: 0.125rem 0.375rem;
  border: 1px solid #dde4ea;
  border-radius: 0.25rem;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

.error-text {
  color: var(--danger, #c62828);
}
</style>
