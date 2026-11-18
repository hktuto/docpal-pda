import { registerPlugin } from '@capacitor/core';
import { I18nError } from '~/composables/i18nError';

export interface LabelScanCapture {
  imagePath: string;
  text: string;
  barcodes: string;
}

export interface ScanLabelOptions {
  /**
   * Streaming auto-capture (spec 2026-11-18-streaming-label-scan-design):
   * the native camera decodes frames continuously while aiming and captures
   * by itself once a candidate is stable — no tap/shutter. Old native builds
   * ignore the flag and run the manual camera.
   */
  stream?: boolean;
}

export interface RectangleDetectionPlugin {
  scanLabel(options?: ScanLabelOptions): Promise<LabelScanCapture>;
}

export const SCAN_NOT_AVAILABLE_MESSAGE = 'scan_not_available_browser';

export const RectangleDetection = registerPlugin<RectangleDetectionPlugin>(
  'RectangleDetection',
  {
    web: () =>
      Promise.resolve({
        async scanLabel(_options?: ScanLabelOptions): Promise<LabelScanCapture> {
          throw new I18nError(SCAN_NOT_AVAILABLE_MESSAGE);
        },
      } as RectangleDetectionPlugin),
  },
);
