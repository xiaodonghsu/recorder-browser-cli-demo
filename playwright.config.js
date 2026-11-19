import { defineConfig } from "@playwright/test";
const port = Number(process.env.PW_PORT || 5187);
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env.PW_CHANNEL || "msedge",
    headless: true,
    viewport: { width: 1440, height: 1050 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
