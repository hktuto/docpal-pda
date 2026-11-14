import type { AdminUserRow, PickingOrderDetail, TaskAssignmentFlow } from "~/utils/flowApi";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

// Per-step assignee pickers shared by the picking-order detail views
// (spec 2026-11-01 + CR-048): the order's picking / labeling / label-printing
// steps and the per-box measuring / verify steps. All save through the
// generic PATCH /admin/task-assignment (optimistic, rolled back on error);
// state is keyed `${flow}:${taskId}`, value = username ("" = unassigned).
export function useStepAssignees(orderId: string) {
  const flow = useFlowApi();
  const { t } = useI18n();

  const assigneeUsers = ref<AdminUserRow[]>([]);
  const assigneeOptions = computed<SearchableSelectOption[]>(() =>
    assigneeUsers.value.map((u) => ({ value: u.username, label: `${u.displayName} (${u.username})` }))
  );
  const assigneeInputs = ref<Record<string, string>>({});
  const assigneeSaving = ref<Record<string, boolean>>({});

  function assigneeValue(taskFlow: TaskAssignmentFlow, id: string) {
    return assigneeInputs.value[`${taskFlow}:${id}`] ?? "";
  }

  async function saveStepAssignee(taskFlow: TaskAssignmentFlow, id: string, value: string[] | string, onError: (msg: string) => void, onSaved: () => Promise<void>) {
    const key = `${taskFlow}:${id}`;
    const next = typeof value === "string" ? value : "";
    const prev = assigneeInputs.value[key] ?? "";
    if (next === prev || assigneeSaving.value[key]) return;
    assigneeInputs.value = { ...assigneeInputs.value, [key]: next };
    assigneeSaving.value = { ...assigneeSaving.value, [key]: true };
    try {
      await flow.setTaskAssignment(taskFlow, id, next || null);
      await onSaved();
    } catch (e: any) {
      assigneeInputs.value = { ...assigneeInputs.value, [key]: prev };
      onError(`${t("taskAssignments.saveFailed")}: ${e?.message ?? String(e)}`);
    } finally {
      assigneeSaving.value = { ...assigneeSaving.value, [key]: false };
    }
  }

  /** Seed every picker from the loaded order (re-run on each reload). */
  function initFromOrder(o: PickingOrderDetail) {
    const inputs: Record<string, string> = {
      [`picking:${orderId}`]: o.assignee ?? "",
      [`labeling:${orderId}`]: o.labelingAssignee ?? "",
      [`label-printing:${orderId}`]: o.labelPrintingAssignee ?? "",
    };
    for (const b of o.boxes) {
      inputs[`measuring:${b.id}`] = b.assignee ?? "";
      if (b.verifyTaskId) inputs[`verify:${b.verifyTaskId}`] = b.verifyAssignee ?? "";
    }
    assigneeInputs.value = inputs;
  }

  function loadUsers() {
    flow
      .listAdminUsers()
      .then((rows) => (assigneeUsers.value = rows))
      .catch(() => {}); // picker options stay empty; the order still loads
  }

  return { assigneeUsers, assigneeOptions, assigneeInputs, assigneeSaving, assigneeValue, saveStepAssignee, initFromOrder, loadUsers };
}
