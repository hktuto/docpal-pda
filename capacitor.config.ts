import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.docpal.warehousedemo',
  appName: 'Warehouse PDA',
  webDir: '.output/public',
  server: {
    url: 'http://192.168.0.139:3000',
    cleartext: true,
  },
};

export default config;
