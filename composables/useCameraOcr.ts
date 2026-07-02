import { ref } from 'vue';
import type {
  TextDetectionResult,
} from '@pantrist/capacitor-plugin-ml-kit-text-recognition';

export interface CameraOcrOptions {
  quality?: number;
  allowEditing?: boolean;
}

export function useCameraOcr() {
  const isScanning = ref(false);
  const previewUrl = ref<string | null>(null);

  async function scanText(options: CameraOcrOptions = {}): Promise<TextDetectionResult> {
    const [{ Camera, CameraResultType, CameraSource }, { CapacitorPluginMlKitTextRecognition }] =
      await Promise.all([
        import('@capacitor/camera'),
        import('@pantrist/capacitor-plugin-ml-kit-text-recognition'),
      ]);

    isScanning.value = true;
    previewUrl.value = null;

    async function tryScan(quality: number, width: number): Promise<TextDetectionResult> {
      const photo = await Camera.getPhoto({
        quality,
        allowEditing: options.allowEditing ?? false,
        resultType: CameraResultType.Base64,
        source: CameraSource.Camera,
        width,
      });

      if (!photo.base64String) {
        throw new Error('No image data returned from camera.');
      }

      console.log(
        `[ocr] captured image format=${photo.format} quality=${quality} width=${width} base64Length=${photo.base64String.length}`,
      );

      previewUrl.value = `data:image/${photo.format};base64,${photo.base64String}`;

      // ML Kit only accepts 0, 90, 180, 270. Use 0 by default; EXIF orientation
      // has been a common source of "Unable process image!" failures.
      return await CapacitorPluginMlKitTextRecognition.detectText({
        base64Image: photo.base64String,
        rotation: 0,
      });
    }

    try {
      try {
        return await tryScan(options.quality ?? 80, 1280);
      } catch (e: any) {
        const message = e?.message ?? String(e);
        console.warn(`[ocr] first scan failed (${message}), retrying with smaller image...`);
        return await tryScan(60, 800);
      }
    } catch (e: any) {
      console.error('[ocr] detectText failed:', e);
      throw e;
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
