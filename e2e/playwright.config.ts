import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * Resolve the pre-installed Chromium binary shipped in this container. We never
 * run `playwright install` here — the browser is already on disk under
 * /opt/pw-browsers. Prefer the stable symlink, then fall back to the versioned
 * path so the suite keeps working if the revision changes.
 */
function resolveChromium(): string {
  const candidates = [
    '/opt/pw-browsers/chromium/chromium',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `e2e: could not find a pre-installed Chromium under /opt/pw-browsers (looked at: ${candidates.join(', ')})`,
  );
}

const PORT = Number(process.env.PORT ?? 8787);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'off',
    // We pass `--headless=new` ourselves (the pre-installed Chromium dropped the
    // legacy "old" headless mode that Playwright would otherwise inject), so we
    // set `headless: false` to stop Playwright from adding `--headless=old`.
    headless: false,
    launchOptions: {
      executablePath: resolveChromium(),
      args: [
        '--headless=new',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'node scripts/serve.mjs',
    url: `${BASE_URL}/health`,
    timeout: 30_000,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
  },
});
