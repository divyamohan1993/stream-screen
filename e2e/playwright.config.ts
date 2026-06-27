import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * Resolve a Chromium binary in a way that works BOTH locally and in CI.
 *
 * Locally, this container ships a pre-installed Chromium under /opt/pw-browsers
 * and we never run `playwright install` — so when that path exists we point
 * Playwright straight at the on-disk binary.
 *
 * In CI (GitHub Actions) /opt/pw-browsers does not exist; the workflow runs
 * `npx playwright install --with-deps chromium`, so we return `null` here and
 * let Playwright resolve its own default-installed Chromium.
 */
function resolveChromium(): string | null {
  // Only honour the pre-installed container browser when it is actually present.
  if (!existsSync('/opt/pw-browsers')) return null;

  const candidates = [
    '/opt/pw-browsers/chromium/chromium',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `e2e: /opt/pw-browsers exists but no Chromium binary was found there (looked at: ${candidates.join(', ')})`,
  );
}

const chromiumPath = resolveChromium();

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
      // Use the pre-installed container Chromium when available; otherwise omit
      // executablePath so Playwright uses its own default-installed browser (CI).
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
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
