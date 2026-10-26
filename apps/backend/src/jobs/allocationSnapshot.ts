import type { AppDb } from "../db.js";
import { captureAllocationSnapshot, restoreLatestAllocationSnapshot } from "../db/allocationSnapshot.js";

const SCHEDULE_PATTERN = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)([+-])([01]\d):?([0-5]\d)$/;

export function nextAllocationRun(at: Date, schedule: string): Date {
  const match = SCHEDULE_PATTERN.exec(schedule);
  if (!match) throw new Error(`Invalid allocation schedule "${schedule}"; expected HH:mm:ss±HHmm`);
  const [, hourText, minuteText, secondText, sign, offsetHourText, offsetMinuteText] = match;
  const offsetMinutes = (Number(offsetHourText) * 60 + Number(offsetMinuteText)) * (sign === "+" ? 1 : -1);
  const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
  let next = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    Number(hourText),
    Number(minuteText),
    Number(secondText)
  ) - offsetMinutes * 60_000;
  if (next <= at.getTime()) next += 24 * 60 * 60_000;
  return new Date(next);
}

export function startAllocationSnapshotCron(db: AppDb): void {
  if (process.env.UAT_ALLOCATION_RECOVERY !== "on") return;
  const backupSchedule = process.env.ALLOCATE_BACKUP ?? "17:45:00+0800";
  const recoverSchedule = process.env.ALLOCATE_RECOVER ?? "08:00:00+0800";

  function schedule(expression: string, run: () => Promise<void>): void {
    const next = nextAllocationRun(new Date(), expression);
    const timer = setTimeout(() => void run().finally(() => schedule(expression, run)), next.getTime() - Date.now());
    timer.unref();
  }

  schedule(backupSchedule, async () => {
    try {
      const result = await captureAllocationSnapshot(db);
      console.log(`allocation snapshot: captured ${result.allocations} allocation(s) for ${result.snapshotDate}`);
    } catch (err) {
      console.error("allocation snapshot failed", err);
    }
  });

  schedule(recoverSchedule, async () => {
    try {
      const result = await restoreLatestAllocationSnapshot(db);
      console.log(`allocation restore: ${result.restored} restored, ${result.existing} existing, ${result.skipped} skipped`);
    } catch (err) {
      console.error("allocation restore failed", err);
    }
  });
}
