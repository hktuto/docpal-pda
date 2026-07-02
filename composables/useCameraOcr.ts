import { ref } from 'vue';
import type { TextDetectionResult } from '@pantrist/capacitor-plugin-ml-kit-text-recognition';

export interface CameraOcrOptions {
  quality?: number;
  allowEditing?: boolean;
  language?: 'latin' | 'chinese' | 'devanagari' | 'japanese' | 'korean';
}

export function useCameraOcr() {
  const isScanning = ref(false);
  const previewUrl = ref<string | null>(null);

  async function scanText(options: CameraOcrOptions = {}): Promise<TextDetectionResult> {
    const [{ Camera, CameraResultType, CameraSource }, { Ocr }] = await Promise.all([
      import('@capacitor/camera'),
      import('@pantrist/capacitor-plugin-ml-kit-text-recognition'),
    ]);

    isScanning.value = true;
    previewUrl.value = null;

    try {
      const photo = await Camera.getPhoto({
        quality: options.quality ?? 90,
        allowEditing: options.allowEditing ?? false,
        resultType: CameraResultType.Base64,
        source: CameraSource.Camera,
      });

      if (!photo.base64String) {
        throw new Error('No image data returned from camera.');
      }

      previewUrl.value = `data:image/${photo.format};base64,${photo.base64String}`;

      const result = await Ocr.detectText({
        base64Image: photo.base64String,
        rotation: photo.exif?.Orientation ? exifOrientationToDegrees(photo.exif.Orientation) : 0,
      });

      return result;
    } finally {
      isScanning.value = false;
    }
  }

  function clearPreview() {
    previewUrl.value = null;
  }

  return {
    isScanning,
    previewUrl,
    scanText,
    clearPreview,
  };
}

function exifOrientationToDegrees(orientation: number | string): number {
  const value = typeof orientation === 'string' ? parseInt(orientation, 10) : orientation;
  switch (value) {
    case 3:
      return 180;
    case 6:
      return 90;
    case 8:
      return 270;
    default:
      return 0;
  }
}
