import { getIsoWeek } from "~/db/date";

export function getLocationBoxIdPrefix(prefix: string, locationCode: string): string {
  const now = new Date();
  const week = String(getIsoWeek(now)).padStart(2, "0");
  const year = String(now.getFullYear() % 100).padStart(2, "0");
  return `${prefix}-${locationCode}-${week}${year}`;
}

export function generateLocationBoxId(
  prefix: string,
  locationCode: string,
  existingIds: string[]
): string {
  const idPrefix = getLocationBoxIdPrefix(prefix, locationCode);

  let maxSeq = 0;
  const regex = new RegExp(`^${idPrefix.replace(/[-]/g, "\\-")}([0-9]{6})$`);
  for (const id of existingIds) {
    const match = id.match(regex);
    if (match) maxSeq = Math.max(maxSeq, parseInt(match[1], 10));
  }

  return `${idPrefix}${String(maxSeq + 1).padStart(6, "0")}`;
}
