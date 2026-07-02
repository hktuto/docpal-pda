import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.docpal.warehousedemo',
  appName: 'Warehouse PDA',
  webDir: '.output/public',
  server: {
    androidScheme: 'https',
    url: process.env.CAPACITOR_SERVER_URL,
    cleartext: !!process.env.CAPACITOR_SERVER_URL,
  },
};

export default config;
