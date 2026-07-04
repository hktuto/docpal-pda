import type { LabelScanCapture } from '~/composables/useRectangleDetection';

export function parseBrowserScanPromptJson(raw: string): LabelScanCapture | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.text !== 'string') return null;

  const barcodes = Array.isArray(obj.barcodes) ? obj.barcodes : [];
  const valid = barcodes.every(
    (b): b is { value: string; format: string } =>
      typeof b === 'object' &&
      b !== null &&
      typeof (b as Record<string, unknown>).value === 'string' &&
      typeof (b as Record<string, unknown>).format === 'string'
  );

  if (!valid) return null;

  return {
    imagePath: '',
    text: obj.text,
    barcodes: JSON.stringify(barcodes),
  };
}
