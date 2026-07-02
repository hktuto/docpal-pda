import type { TextDetectionResult } from '@pantrist/capacitor-plugin-ml-kit-text-recognition';

export async function detectTextFromBase64(
  base64Image: string,
  rotation = 0,
): Promise<TextDetectionResult> {
  const { CapacitorPluginMlKitTextRecognition } = await import(
    '@pantrist/capacitor-plugin-ml-kit-text-recognition'
  );
  return await CapacitorPluginMlKitTextRecognition.detectText({
    base64Image,
    rotation,
  });
}
