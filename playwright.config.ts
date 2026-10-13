import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const testData = mkdtempSync(join(tmpdir(), "contextmesh-browser-"));
const webPort = process.env.E2E_WEB_PORT || "5273";
const apiPort = process.env.E2E_API_PORT || "4410";
const baseURL = `http://127.0.0.1:${webPort}`;
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL,
    trace: "retain-on-failure",
    launchOptions: {
      executablePath:
        process.env.CHROME_PATH ||
        (existsSync("/usr/bin/google-chrome")
          ? "/usr/bin/google-chrome"
          : undefined),
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: false,
    env: {
      CONTEXTMESH_MODE: "demo",
      PORT: apiPort,
      CONTEXTMESH_WEB_PORT: webPort,
      DATA_DIR: testData,
      ANTHROPIC_API_KEY: "",
      GEMINI_API_KEY: "",
      AI_PROVIDER: "auto",
      PAYPAL_CLIENT_ID: "",
      PAYPAL_CLIENT_SECRET: "",
      PAYPAL_WEBHOOK_ID: "",
      PAYPAL_MAYA_EMAIL: "",
      PAYPAL_ARJUN_EMAIL: "",
      HYDRADB_URL: "",
      HYDRADB_TOKEN: "",
      RENDER_API_KEY: "",
      RENDER_TASK_SLUG: "",
      APP_ACCESS_TOKEN: "",
      PUBLIC_URL: baseURL,
    },
  },
});
