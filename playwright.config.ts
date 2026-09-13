import { defineConfig, devices } from "@playwright/test";
import { resolveE2EPort } from "./tests/e2e/port";

// A dedicated, per-run port: never 1420 (the interactive `npm run dev` port) and
// never a port that some other process already owns. See tests/e2e/port.ts.
const port = resolveE2EPort();
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Run the Vite dev server automatically so `npm run test:e2e` is self-contained.
  // The server is always started fresh: reusing one would let the suite test a
  // stale bundle, and `--strictPort` guarantees Vite cannot land on another port.
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
