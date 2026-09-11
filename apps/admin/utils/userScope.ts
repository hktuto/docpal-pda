/** One (orgId, subInventoryCode) pair of a per-user sub-inventory scope. */
export interface SubInventoryScope {
  orgId: number;
  code: string;
}

/**
 * Compact table summary of a scope: codes grouped per org
 * ("2: STORE1, STORE2; 3: MAIN"). Empty string when unrestricted —
 * callers render "—" for that.
 */
export function formatScopeSummary(scopes: SubInventoryScope[] | null | undefined): string {
  if (!scopes || scopes.length === 0) return "";
  const byOrg = new Map<number, string[]>();
  for (const s of scopes) {
    const list = byOrg.get(s.orgId) ?? [];
    list.push(s.code);
    byOrg.set(s.orgId, list);
  }
  return [...byOrg.entries()]
    .sort(([a], [b]) => a - b)
    .map(([orgId, codes]) => `${orgId}: ${codes.sort((a, b) => a.localeCompare(b)).join(", ")}`)
    .join("; ");
}
