import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// The daemon API (P2 step 2) defaults to 3002 (env ECC_API_PORT there); the
// dev proxy folds it under /api so the app stays same-origin in development.
const apiPort = process.env.ECC_API_PORT ?? '3002';

export default defineConfig({
  plugins: [svelte()],
  // Under vitest, resolve Svelte's browser build: the default (server)
  // condition makes mount() throw lifecycle_function_unavailable.
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.ts'],
    setupFiles: ['./src/test-setup.ts'],
  },
});