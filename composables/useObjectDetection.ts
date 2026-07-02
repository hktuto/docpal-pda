import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

export interface DetectObjectsOptions {
  path: string;
  confidence?: number;
  enableMultipleObjects?: boolean;
  enableClassification?: boolean;
}

export interface DetectedObjectLabel {
  text: string;
  confidence: number;
  index: number;
}

export interface DetectedObjectBoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DetectedObject {
  trackingId?: number;
  boundingBox: DetectedObjectBoundingBox;
  labels: DetectedObjectLabel[];
}

export interface DetectObjectsResult {
  objects: DetectedObject[];
}

export interface ObjectDetectionPlugin {
  detectObjects(options: DetectObjectsOptions): Promise<DetectObjectsResult>;
  addListener(
    eventName: string,
    listenerFunc: (event: unknown) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export const ObjectDetection = registerPlugin<ObjectDetectionPlugin>('ObjectDetection', {
  web: () =>
    Promise.resolve({
      async detectObjects(): Promise<DetectObjectsResult> {
        throw new Error('ObjectDetection is not available in the browser.');
      },
      async addListener() {
        return { remove: () => {} } as PluginListenerHandle;
      },
      async removeAllListeners() {},
    } as ObjectDetectionPlugin),
});

export interface ObjectDetectionOptions {
  confidence?: number;
  enableMultipleObjects?: boolean;
  enableClassification?: boolean;
}

export function useObjectDetection() {
  async function detectFromPath(
    path: string,
    options: ObjectDetectionOptions = {},
  ): Promise<DetectObjectsResult> {
    return ObjectDetection.detectObjects({
      path,
      confidence: options.confidence ?? 0.5,
      enableMultipleObjects: options.enableMultipleObjects ?? true,
      enableClassification: options.enableClassification ?? true,
    });
  }

  return {
    detectFromPath,
  };
}
