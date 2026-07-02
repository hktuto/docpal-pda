import { ref } from 'vue';
import {
  DocumentScanner,
  ResponseType,
  ScannerMode,
} from '@capgo/capacitor-document-scanner';
import type {
  ScanDocumentOptions,
  ScanDocumentResponse,
} from '@capgo/capacitor-document-scanner';

export interface DocumentScannerResult {
  status: string;
  images: string[];
}

export function useDocumentScanner() {
  const isScanning = ref(false);
  const error = ref<string | null>(null);

  async function scanDocuments(
    options: ScanDocumentOptions = {},
  ): Promise<DocumentScannerResult> {
    isScanning.value = true;
    error.value = null;

    try {
      const result: ScanDocumentResponse = await DocumentScanner.scanDocument({
        responseType: ResponseType.Base64,
        scannerMode: ScannerMode.Full,
        maxNumDocuments: 1,
        letUserAdjustCrop: true,
        ...options,
      });

      return {
        status: result.status ?? 'unknown',
        images: result.scannedImages ?? [],
      };
    } catch (e: any) {
      error.value = e?.message ?? String(e);
      throw e;
    } finally {
      isScanning.value = false;
    }
  }

  return {
    isScanning,
    error,
    scanDocuments,
  };
}
