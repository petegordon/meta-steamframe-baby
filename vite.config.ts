import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [iwsdkDev()],
  // 0.0.0.0 so a headset on the same Wi-Fi can load it (IWSDK serves HTTPS with a dev cert).
  server: { host: '0.0.0.0', port: 8081, open: false },
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: { input: './index.html' },
  },
  worker: { format: 'es' },
  esbuild: { target: 'esnext' },
  resolve: { dedupe: ['three'] },
  optimizeDeps: {
    // MediaPipe loads its own WASM at runtime from public/mediapipe.
    exclude: ['@mediapipe/tasks-vision'],
    esbuildOptions: { target: 'esnext' },
  },
  publicDir: 'public',
  base: './',
});
