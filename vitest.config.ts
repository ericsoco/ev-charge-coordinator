import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// A per-test-file temp dir, so no suite can read or write the developer's real
// ~/.ev-charge-coordinator regardless of which modules it imports.
const TEST_CONFIG_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'ev-charge-coordinator-tests-')
);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    // Some suites write real files to a temp dir and shell out to the proxy resolver.
    testTimeout: 20000,
    // Set globally rather than per file. tests/services/tesla-error-reporting.test.ts
    // once wrote {"accessToken":"at",...} into the developer's real macOS keychain,
    // which then shadowed their real credentials and made the CLI re-prompt on
    // every run. A file that forgets the guard can still import code that saves
    // credentials, so the guard has to live where a file cannot forget it.
    env: {
      ECC_DISABLE_KEYCHAIN: '1',
      ECC_CONFIG_DIR: TEST_CONFIG_DIR,
    },
  },
});
