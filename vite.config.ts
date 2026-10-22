import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

/** Commit + build time, shown on the page so you can tell which build is live. */
function gitHash(): string {
  try {
    const h = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return dirty ? `${h}+local` : h;
  } catch {
    return process.env.GITHUB_SHA?.slice(0, 7) ?? 'unknown';
  }
}
const BUILD_INFO = { commit: gitHash(), time: new Date().toISOString() };

export default defineConfig({
  plugins: [iwsdkDev()],
  define: { __BUILD_INFO__: JSON.stringify(BUILD_INFO) },
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
