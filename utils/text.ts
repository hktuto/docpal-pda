export function normalizeString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === "") return null;
  return value;
}

export function rawCode(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}
