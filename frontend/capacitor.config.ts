import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'in.algions.khata',
  appName: 'Khata',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: false, // Disallow cleartext HTTP for security
  },
  plugins: {
    CapacitorCookies: {
      enabled: true, // Enables native cookie sync for WebView and API calls
    },
    CapacitorHttp: {
      enabled: true, // Enables native HTTP bridge to preserve cookies across origins
    },
  },
};

export default config;
