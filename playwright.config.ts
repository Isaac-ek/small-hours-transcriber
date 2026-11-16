import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 180000,
  use: {
    baseURL: "http://127.0.0.1:8191",
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || undefined,
    viewport: { width: 1440, height: 1050 },
  },
  webServer: {
    command: ".venv/bin/python app.py",
    url: "http://127.0.0.1:8191/api/health",
    env: {
      TRANSCRIBER_PORT: "8191",
      TRANSCRIBER_DATA: `.runtime/e2e-${Date.now()}`,
    },
    reuseExistingServer: false,
    timeout: 30000,
  },
});
