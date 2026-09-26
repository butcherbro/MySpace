import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import packageJson from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(packageJson.version) },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Let `*.css?raw` imports return the real source (typography.test.ts reads
    // the tokens); other CSS stays stubbed out as before.
    css: { include: [/\.css\?raw$/] },
  },
});
