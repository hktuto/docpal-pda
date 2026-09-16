/** Table-cell display formatting shared by the CRUD and shelf-box views. */
import { formatDate } from "./datePreferences";

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  if (
    (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) ||
    (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
  ) {
    return formatDate(value);
  }
  return String(value);
}
