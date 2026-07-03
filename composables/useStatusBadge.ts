export function useStatusBadge() {
  function badgeClass(status: string | null | undefined): string {
    const s = (status ?? "").toLowerCase().replace(/_/g, "-");
    if (s === "pending" || s === "open") return "badge--pending";
    if (s === "in-hand" || s === "picking") return "badge--in-hand";
    if (["finished", "completed", "verified", "closed", "clear", "done"].includes(s)) {
      return "badge--finished";
    }
    if (s === "issue" || s === "danger") return "badge--danger";
    return "";
  }

  return { badgeClass };
}
