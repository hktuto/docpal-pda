import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface ScannerBroadcastPlugin {
  addListener(
    eventName: 'scan',
    listenerFunc: (data: { value: string }) => void,
  ): Promise<PluginListenerHandle>;
}

/**
 * Hardware-scanner broadcast bridge (native ScannerBroadcastPlugin).
 * Emits one 'scan' event per decoded barcode. The web stub never emits —
 * in the browser only the keyboard-wedge path in useHardwareScanner works.
 */
export const ScannerBroadcast = registerPlugin<ScannerBroadcastPlugin>(
  'ScannerBroadcast',
  {
    web: () =>
      Promise.resolve({
        async addListener(): Promise<PluginListenerHandle> {
          return { remove: async () => {} };
        },
      } as ScannerBroadcastPlugin),
  },
);
