import { defineConfig, devices } from "@playwright/test";

const existingServer = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: existingServer ?? "http://127.0.0.1:3100",
    actionTimeout: 20_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  },
  webServer: existingServer ? undefined : {
    command: "npx next dev --hostname 127.0.0.1 --port 3100",
    // Archive tests mock entitlement responses; exercise the real gate by default.
    env: { NEXT_PUBLIC_EXPORT_TEST_BYPASS: "false" },
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
