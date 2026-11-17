import { defineConfig } from "@playwright/test";
const origin = process.env.SMALL_HOURS_ORIGIN;
export default defineConfig({
  testDir: "./tests/hosted",
  workers: 1,
  timeout: 210000,
  use: {
    baseURL: origin || "http://127.0.0.1:8193",
    channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || undefined,
    viewport: { width: 1440, height: 1050 },
  },
  webServer: origin
    ? undefined
    : {
        command:
          "npm --prefix browser run preview -- --host 127.0.0.1 --port 8193 --strictPort",
        url: "http://127.0.0.1:8193",
        reuseExistingServer: false,
      },
});
