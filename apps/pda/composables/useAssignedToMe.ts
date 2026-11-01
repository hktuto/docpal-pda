// "Assigned to me" badge text for task list rows (spec 2026-11-01 task
// assignee): the backend hides tasks assigned to other users, so the PDA only
// flags which visible rows name the current user.
export function useAssignedToMe() {
  const { t } = useI18n();
  const { currentUser } = useAuth();

  /** The badge label when the row is assigned to the current user, else
   *  undefined (AppListRow hides the badge). */
  function mineText(row: { assignee?: string | null }): string | undefined {
    if (!row.assignee) return undefined;
    return row.assignee === currentUser.value?.username
      ? t("common.assignedToMe")
      : undefined;
  }

  return { mineText };
}
