import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    // Some suites write real files to a temp dir and shell out to the proxy resolver.
    testTimeout: 20000,
  },
});
