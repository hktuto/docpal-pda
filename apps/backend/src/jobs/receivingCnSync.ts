import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll } from "../db/query.js";
import {
  finalizeCnOrder,
  markCnWorkflowTerminal,
  type CnWorkflowRow,
} from "../db/receivingCn.js";
import { getProcess } from "../docpalWorkflow.js";
import { receivingCnSyncDisabled, receivingCnSyncIntervalSec } from "../config.js";

// ---------------------------------------------------------------------------
// CN receiving workflow-status cron (spec
// docs/superpowers/specs/2026-10-16-customer-receiving-upload-design.md).
// Self-rescheduling setTimeout loop modeled on jobs/goodsVerifyDayEnd.ts:
// polls DocPal for each receiving_cn_workflows row in workflow_running;
// terminal states update the tracking row (completed → finalizeCnOrder, which
// is idempotent via the put_away_tasks_cn unique index). RECEIVING_CN_SYNC=off
// disables; RECEIVING_CN_SYNC_INTERVAL_SEC sets the interval (default 120).
// Log-only failures — the cron never throws.
// ---------------------------------------------------------------------------

/** Defensive state mapping — DocPal's exact terminal vocabulary is unconfirmed. */
function mapTerminalState(stateType: string | undefined): "completed" | "failed" | "cancelled" | "unknown" {
  switch ((stateType ?? "").toLowerCase()) {
    case "completed":
    case "complete":
    case "ended":
    case "finished":
    case "success":
      return "completed";
    case "failed":
    case "failure":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
    case "terminated":
    case "aborted":
      return "cancelled";
    default:
      return "unknown";
  }
}

/** One poll pass — exported for tests. */
export async function runReceivingCnSyncOnce(db: AppDb): Promise<void> {
  const rows = await queryAll<CnWorkflowRow>(
    db,
    sql`SELECT id, phase, invoice_no AS "invoiceNo", supplier, filename,
               docpal_document_id AS "docpalDocumentId", docpal_process_id AS "docpalProcessId",
               docpal_business_key AS "docpalBusinessKey", status, payload, error,
               created_by AS "createdBy", created_date AS "createdDate", last_update_date AS "lastUpdateDate"
        FROM receiving_cn_workflows
        WHERE status = 'workflow_running' AND docpal_process_id IS NOT NULL
        ORDER BY created_date`
  );
  for (const row of rows) {
    try {
      const process = await getProcess(row.docpalProcessId!);
      // Verification log: shows the raw process payload the cron sees, so the
      // state mapping can be checked against live DocPal responses.
      console.log(`[receiving-cn] getProcess ${row.docpalProcessId}:`);
      const stateType =
        typeof process.state?.type === "string" ? process.state.type : undefined;
      const terminal = mapTerminalState(stateType);
      if (terminal === "unknown") {
        if (stateType) {
          console.warn(`receiving-cn sync: workflow ${row.id} unknown process state "${stateType}" — skipping`);
        }
        continue;
      }
      if (terminal === "completed") {
        const actorId = (await queryAll<{ id: string }>(
          db,
          sql`SELECT id FROM users WHERE username = ${row.createdBy} LIMIT 1`
        ))[0]?.id ?? null;
        // false = the upstream sync hasn't written the CN order yet — the
        // workflow stays workflow_running and we retry on the next poll.
        await finalizeCnOrder(db, row, actorId ?? null);
      } else {
        await markCnWorkflowTerminal(db, {
          id: row.id,
          status: terminal,
          error: `docpal process state: ${stateType ?? "unknown"}`,
          actorId: null,
        });
      }
    } catch (err) {
      console.error(`receiving-cn sync: workflow ${row.id} poll failed`, err);
    }
  }
}

/** Start the self-rescheduling poll loop (unref'd; log-only failures). */
export function startReceivingCnSyncCron(db: AppDb): void {
  if (receivingCnSyncDisabled()) return;

  function schedule(): void {
    const timer = setTimeout(
      () => void runReceivingCnSyncOnce(db).catch((err) => console.error("receiving-cn sync run failed", err)).finally(schedule),
      receivingCnSyncIntervalSec() * 1000
    );
    timer.unref();
  }

  schedule();
}
