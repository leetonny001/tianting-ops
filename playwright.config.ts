import { defineConfig, devices } from '@playwright/test';

export const BASE = 'http://ops.localhost:18290';

// 连真实的 console-server + 两个 im-server + Postgres；Prometheus、Alertmanager、备份桶、Grafana 是假的。见 e2e/stack.mjs。
// 共用一个时钟，所以不并行。
export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: BASE,
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        channel: process.env.CI ? undefined : 'chrome',
      },
    },
  ],
  webServer: {
    command: 'npm run build && node e2e/stack.mjs',
    url: 'http://127.0.0.1:18299/healthz',
    reuseExistingServer: false,
    timeout: 180_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 3000 },
  },
});
