import { registerPlugin } from '@capacitor/core';
import { I18nError } from '~/composables/i18nError';

export interface LabelScanCapture {
  imagePath: string;
  text: string;
  barcodes: string;
  /** Name of the all-of rule that confirmed this capture, when fired by one. */
  matchedRule?: string;
}

/** A named all-of keyword group; one label layout per rule. */
export interface ScanRule {
  name: string;
  keywords: string[];
}

export interface ScanLabelOptions {
  /**
   * Streaming auto-capture (spec 2026-11-18-streaming-label-scan-design):
   * the native camera decodes frames continuously while aiming and captures
   * by itself once a candidate is stable — no tap/shutter. Old native builds
   * ignore the flag and run the manual camera.
   */
  stream?: boolean;
  /**
   * Rule confirm: a decoded value (barcode or OCR text) containing ALL of a
   * rule's keywords fires immediately — the streak and centre checks are
   * waived, only a minimum-area gate stays. Any rule can confirm (one brand
   * may print several label layouts).
   */
  rules?: ScanRule[];
  /**
   * Analysis-stream resolution: 'sd' = 480x640 (default, fast), 'hd' =
   * 960x720 (slower ticks, reads small print better).
   */
  analysisSize?: 'sd' | 'hd';
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
