export function logMetadataText(metadata: string | null): string | number | undefined {
  if (!metadata) return undefined;
  try {
    const parsed = JSON.parse(metadata);
    return parsed.qty ?? parsed.note;
  } catch {
    return undefined;
  }
}
