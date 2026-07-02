import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

export interface Point {
  x: number;
  y: number;
}

export interface RectangleBoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DetectedRectangle {
  points: Point[];
  boundingBox: RectangleBoundingBox;
  score: number;
}

export interface DetectRectanglesOptions {
  base64Image: string;
  maxResults?: number;
  minAreaRatio?: number;
  maxAreaRatio?: number;
  minAspectRatio?: number;
  maxAspectRatio?: number;
  approximationEpsilon?: number;
}

export interface DetectRectanglesResult {
  rectangles: DetectedRectangle[];
  width: number;
  height: number;
}

export interface CameraStreamCaptureResult {
  imagePath: string;
  width: number;
  height: number;
  rectangles: DetectedRectangle[];
  selectedRect?: DetectedRectangle;
}

export interface RectangleDetectionPlugin {
  detectRectangles(options: DetectRectanglesOptions): Promise<DetectRectanglesResult>;
  startCameraStream(): Promise<CameraStreamCaptureResult>;
  addListener(
    eventName: string,
    listenerFunc: (event: unknown) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export const RectangleDetection = registerPlugin<RectangleDetectionPlugin>(
  'RectangleDetection',
  {
    web: () =>
      Promise.resolve({
        async detectRectangles(): Promise<DetectRectanglesResult> {
          throw new Error('RectangleDetection is not available in the browser.');
        },
        async startCameraStream(): Promise<CameraStreamCaptureResult> {
          throw new Error('RectangleDetection camera stream is not available in the browser.');
        },
        async addListener() {
          return { remove: () => {} } as PluginListenerHandle;
        },
        async removeAllListeners() {},
      } as RectangleDetectionPlugin),
  },
);

export function useRectangleDetection() {
  async function detectRectangles(
    base64Image: string,
    options: Omit<DetectRectanglesOptions, 'base64Image'> = {},
  ): Promise<DetectRectanglesResult> {
    return RectangleDetection.detectRectangles({
      base64Image,
      ...options,
    });
  }

  async function startCameraStream(): Promise<CameraStreamCaptureResult> {
    return RectangleDetection.startCameraStream();
  }

  return {
    detectRectangles,
    startCameraStream,
  };
}
