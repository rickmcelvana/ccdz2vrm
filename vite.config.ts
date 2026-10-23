import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The page lives in app/. dist/ is both the desktop app's page (Tauri) and the static site: in
// a plain browser backend.ts picks the built-in converter. `base: './'` lets the site sit in any
// folder of any static host. With ?fake the dev server plays a conversion back from out/ --
// which is why it may read the repo root.
export default defineConfig({
  root: 'app',
  base: './',
  plugins: [react()],
  // the converter runs in a module worker that imports WASM (ufbx, mozjpeg, meshoptimizer)
  worker: { format: 'es' },
  // mozjpeg's loader finds its .wasm next to itself (import.meta.url): keep it out of prebundling
  optimizeDeps: { exclude: ['@jsquash/jpeg'] },
  // fakeBackend.ts serves out/ through Vite's /@fs/ route; this is where out/ is.
  define: { REPO_ROOT: JSON.stringify(fileURLToPath(new URL('.', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '')) },
  clearScreen: false,
  server: { port: 5174, strictPort: true, fs: { allow: ['..'] } },
  // three.js + three-vrm are ~900 KB in one chunk; split would buy little for one page.
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2023', chunkSizeWarningLimit: 1500 },
  test: {
    root: '.',
    environment: 'jsdom',
    include: ['app/src/**/*.test.{ts,tsx}'],
  },
});
