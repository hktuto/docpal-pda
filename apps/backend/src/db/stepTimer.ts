/**
 * Dev diagnostic helper: accumulates wall-clock milliseconds per step label
 * inside one operation, then renders a one-line breakdown for the logs.
 * Used by the allocation recompute paths to find where the time goes
 * (labels merge cumulatively across repeated calls, e.g. per-demand queries).
 */
export class StepTimer {
  private readonly startedAt = Date.now();
  private readonly steps = new Map<string, { ms: number; count: number }>();

  /** Measure one awaited step and accumulate it under `label`. */
  async measure<T>(label: string, run: () => Promise<T>): Promise<T> {
    const s = Date.now();
    try {
      return await run();
    } finally {
      this.add(label, Date.now() - s);
    }
  }

  add(label: string, ms: number): void {
    const s = this.steps.get(label);
    if (s) {
      s.ms += ms;
      s.count += 1;
    } else {
      this.steps.set(label, { ms, count: 1 });
    }
  }

  total(): number {
    return Date.now() - this.startedAt;
  }

  /** One-line report: `title total=Xms :: label=Yms(xN) | ...` */
  report(title: string): string {
    const parts = [...this.steps.entries()].map(([label, s]) => `${label}=${s.ms}ms(x${s.count})`);
    return `[alloc-timing] ${title} total=${this.total()}ms :: ${parts.join(" | ")}`;
  }
}
