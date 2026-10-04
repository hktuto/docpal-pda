export function badgeClass(status: string | null | undefined): string {
  const s = (status ?? "").toLowerCase().replace(/_/g, "-");
  if (s === "pending" || s === "open") return "badge--pending";
  if (s === "in-hand" || s === "picking" || s === "provisional-received") return "badge--in-hand";
  if (["finished", "completed", "verified", "closed", "clear", "done", "shipped", "allocated"].includes(s)) {
    return "badge--finished";
  }
  if (s === "partial") return "badge--in-hand";
  if (s === "unallocated") return "badge--pending";
  if (s === "issue" || s === "danger") return "badge--danger";
  return "";
}
