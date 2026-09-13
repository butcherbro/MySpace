import { execFileSync } from "node:child_process";

/**
 * E2E must never reuse whatever happens to listen on a fixed port: a stale
 * `vite` process from another checkout silently serves an old bundle and the
 * suite reports a green run against code that is not under test.
 *
 * So the port is allocated per run and handed to both Vite (`--port`,
 * `--strictPort`) and Playwright (`baseURL`, `webServer.url`). If the port is
 * taken between allocation and startup, `strictPort` makes the run fail loudly
 * instead of quietly connecting to a foreign server. Parallel worktrees each
 * allocate their own port instead of colliding on 1420.
 *
 * Playwright re-evaluates this config inside every worker process, so the
 * allocated port is written back to `process.env.E2E_PORT` and inherited by the
 * workers: without that, each worker would pick a different free port and every
 * `page.goto` would hit a server that is not there. `E2E_PORT` set by the caller
 * wins outright, which is also what CI uses.
 */
export function resolveE2EPort(): number {
  const existing = process.env.E2E_PORT;
  if (existing) {
    const parsed = Number.parseInt(existing, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(`E2E_PORT must be a valid TCP port, received ${JSON.stringify(existing)}`);
    }
    return parsed;
  }

  const probe = execFileSync(
    process.execPath,
    [
      "-e",
      // Bind :0, read the assigned port, release it. The kernel hands out a
      // port that is free right now, which keeps parallel runs apart.
      "const net=require('node:net');" +
        "const s=net.createServer();" +
        "s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>{process.stdout.write(String(p));});});",
    ],
    { encoding: "utf8" },
  ).trim();

  const port = Number.parseInt(probe, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `could not allocate an E2E port (probe returned ${JSON.stringify(probe)}); set E2E_PORT`,
    );
  }

  process.env.E2E_PORT = String(port);
  return port;
}
