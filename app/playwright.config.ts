import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export default defineConfig({
  outputDir: './test-results/browser',
  testDir: './tests/browser', workers: 1, timeout: 45_000,
  use: { baseURL: 'http://127.0.0.1:4329', channel: 'msedge', headless: true, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm run start:api', url: 'http://127.0.0.1:4330/api/health', reuseExistingServer: false, timeout: 30_000, env: { WORLDFORGE_API_PORT: '4330', WORLDFORGE_FRONTEND_ORIGINS: 'http://127.0.0.1:4329', WORLDFORGE_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'worldforge-browser-')), WORLDFORGE_DEMO_TICK_MS: '10' } },
    { command: 'npm run start:web', url: 'http://127.0.0.1:4329', reuseExistingServer: false, timeout: 30_000, env: { WORLDFORGE_WEB_PORT: '4329', WORLDFORGE_API_URL: 'http://127.0.0.1:4330' } },
  ],
});
