import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The SPA always calls the relative `/api` prefix: Vite proxies it in development and Nginx in
// production, so the build needs no environment variables.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
  preview: { port: 4173 },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // The ECharts chunk (~200 kB gzip) is lazy-loaded with the dashboard pages and cached; every
    // other chunk stays far below this limit.
    chunkSizeWarningLimit: 650,
  },
});
