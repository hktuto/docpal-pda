import type { AppDb } from "../db.js";
import { fetchCancelRows, processCancelSourceRow, recordCancelError, CANCEL_SOURCES } from "../db/cancelInvoice.js";
import { cancelInvoiceSyncDisabled, cancelInvoiceSyncIntervalSec } from "../config.js";

// ---------------------------------------------------------------------------
// Cancel-invoice ingest cron (spec
// docs/superpowers/specs/2026-11-07-cancel-invoice-putback-design.md).
// Watches the externally-managed public.cancel_invoice / cancel_invoice_tn
// tables for new or re-updated rows (dedupe + watermark live in our
// cancel_records) and applies each cancellation: cancel the picking order/line,
// release allocations, create put-back tasks for picked stock.
// Self-rescheduling setTimeout loop modeled on jobs/receivingCnSync.ts.
// CANCEL_INVOICE_SYNC=off disables; CANCEL_INVOICE_SYNC_INTERVAL_SEC sets the
// interval (default 120). Log-only failures — the cron never throws; a missing
// upstream table is tolerated like wcl_part_drawno (warn once, skip source).
// ---------------------------------------------------------------------------

const isMissingTable = (err: unknown): boolean => {
  for (let e = err as { code?: string; cause?: unknown } | null; e; e = (e.cause as typeof e) ?? null) {
    if (e.code === "42P01") return true;
  }
  return false;
};

let missingTableWarned = false;

/** One poll pass — exported for tests. Returns the number of rows processed. */
export async function runCancelInvoiceSyncOnce(db: AppDb): Promise<number> {
  let processed = 0;
  for (const source of CANCEL_SOURCES) {
    let rows;
    try {
      rows = await fetchCancelRows(db, source);
    } catch (err) {
      if (isMissingTable(err)) {
        if (!missingTableWarned) {
          missingTableWarned = true;
          console.warn("cancel_invoice tables are missing — cancel-ingest cron is idle until the upstream sync creates them");
        }
        continue;
      }
      throw err;
    }
    for (const row of rows) {
      try {
        await processCancelSourceRow(db, source, row);
      } catch (err) {
        console.error(`cancel-invoice: row ${source}/${row.id} failed`, err);
        try {
          await recordCancelError(db, source, row, err instanceof Error ? err.message : String(err));
        } catch (recErr) {
          console.error("cancel-invoice: recording the error failed", recErr);
        }
      }
      processed++;
    }
  }
  return processed;
}

export function startCancelInvoiceSyncCron(db: AppDb): void {
  if (cancelInvoiceSyncDisabled()) return;
  function schedule(): void {
    const timer = setTimeout(
      () =>
        void runCancelInvoiceSyncOnce(db)
          .catch((err) => console.error("cancel-invoice sync run failed", err))
          .finally(schedule),
      cancelInvoiceSyncIntervalSec() * 1000
    );
    timer.unref();
  }
  schedule();
}
