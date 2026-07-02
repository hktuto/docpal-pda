import { ref } from 'vue';
import type {
  GoogleSubjectSegmentationModuleInstallState,
  ProcessImageOptions,
  ProcessImageResult,
} from '@capacitor-mlkit/subject-segmentation';

export function useSubjectSegmentation() {
  const isProcessing = ref(false);
  const moduleInstallProgress = ref(0);

  async function loadSubjectSegmentation() {
    const { SubjectSegmentation } = await import('@capacitor-mlkit/subject-segmentation');
    return SubjectSegmentation;
  }

  async function ensureModuleAvailable(): Promise<boolean> {
    const SubjectSegmentation = await loadSubjectSegmentation();
    const { available } = await SubjectSegmentation.isGoogleSubjectSegmentationModuleAvailable();
    if (available) return true;

    await SubjectSegmentation.addListener(
      'googleSubjectSegmentationModuleInstallProgress',
      ({ state, progress }) => {
        moduleInstallProgress.value = progress ?? 0;
        if (state === GoogleSubjectSegmentationModuleInstallState.COMPLETED) {
          moduleInstallProgress.value = 100;
        }
      },
    );

    await SubjectSegmentation.installGoogleSubjectSegmentationModule();
    return false;
  }

  async function processImage(
    options: ProcessImageOptions,
  ): Promise<ProcessImageResult> {
    const SubjectSegmentation = await loadSubjectSegmentation();
    isProcessing.value = true;
    try {
      const result = await SubjectSegmentation.processImage(options);
      return result;
    } finally {
      isProcessing.value = false;
      await SubjectSegmentation.removeAllListeners();
    }
  }

  return {
    isProcessing,
    moduleInstallProgress,
    ensureModuleAvailable,
    processImage,
  };
}
