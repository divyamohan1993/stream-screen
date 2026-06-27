/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config for the StreamScreen web viewer.
 *
 * The dev server proxies `/api/*` to the local signaling server so the viewer
 * can hit `/api/discover` (mDNS LAN hosts), `/api/sessions`, and `/api/code`
 * without CORS friction during development. Override the target with
 * `VITE_SIGNALING_HTTP` if the signaling server runs elsewhere on the LAN.
 */
const SIGNALING_HTTP = process.env.VITE_SIGNALING_HTTP ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/api': { target: SIGNALING_HTTP, changeOrigin: true },
      '/health': { target: SIGNALING_HTTP, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
});
