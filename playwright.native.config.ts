import { defineConfig, devices } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = 'http://127.0.0.1:3101';
export default defineConfig({
  testDir: './tests/native',
  outputDir: './test-results/native-mcp',
  workers: 1,
  timeout: 120000,
  use: { ...devices['Desktop Chrome'], baseURL: url, actionTimeout: 40000 },
  webServer: {
    command: 'npm run start -- --hostname 127.0.0.1 -p 3101',
    url,
    reuseExistingServer: false,
    env: {
      HH_EXECUTOR: 'codex',
      HH_DATA_DIR: join(tmpdir(), 'hh-native-mcp-' + randomUUID()),
      HH_CODEX_MCP_READ_ONLY: 'hh_smoke/sample_lookup'
    }
  }
});
