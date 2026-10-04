import { registerPlugin } from '@capacitor/core';
import { I18nError } from '~/composables/i18nError';

export interface LabelScanCapture {
  imagePath: string;
  text: string;
  barcodes: string;
}

export interface RectangleDetectionPlugin {
  scanLabel(): Promise<LabelScanCapture>;
}

export const SCAN_NOT_AVAILABLE_MESSAGE = 'scan_not_available_browser';

export const RectangleDetection = registerPlugin<RectangleDetectionPlugin>(
  'RectangleDetection',
  {
    web: () =>
      Promise.resolve({
        async scanLabel(): Promise<LabelScanCapture> {
          throw new I18nError(SCAN_NOT_AVAILABLE_MESSAGE);
        },
      } as RectangleDetectionPlugin),
  },
);
