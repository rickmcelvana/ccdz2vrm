import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The page lives in app/; Tauri loads dist/ in a build and the dev server in `tauri dev`.
// In a plain browser (`pnpm dev`) there is no Tauri, and backend.ts swaps in a fake that
// plays a conversion back from out/ -- which is why the dev server may read the repo root.
export default defineConfig({
  root: 'app',
  plugins: [react()],
  // fakeBackend.ts serves out/ through Vite's /@fs/ route; this is where out/ is.
  define: { REPO_ROOT: JSON.stringify(fileURLToPath(new URL('.', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '')) },
  clearScreen: false,
  server: { port: 5174, strictPort: true, fs: { allow: ['..'] } },
  // three.js + three-vrm are ~900 KB in one chunk; it loads from disk in the app, so no split.
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2023', chunkSizeWarningLimit: 1500 },
  test: {
    root: '.',
    environment: 'jsdom',
    include: ['app/src/**/*.test.{ts,tsx}'],
  },
});
