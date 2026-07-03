import { registerPlugin } from '@capacitor/core';

export interface LabelScanCapture {
  imagePath: string;
  text: string;
  barcodes: string;
}

export interface RectangleDetectionPlugin {
  scanLabel(): Promise<LabelScanCapture>;
}

export const SCAN_NOT_AVAILABLE_MESSAGE = 'RectangleDetection label scan is not available in the browser.';

export const RectangleDetection = registerPlugin<RectangleDetectionPlugin>(
  'RectangleDetection',
  {
    web: () =>
      Promise.resolve({
        async scanLabel(): Promise<LabelScanCapture> {
          throw new Error(SCAN_NOT_AVAILABLE_MESSAGE);
        },
      } as RectangleDetectionPlugin),
  },
);
