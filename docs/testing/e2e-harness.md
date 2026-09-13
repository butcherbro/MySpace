# E2E harness — runtime errors and server freshness

`npm run test:e2e` runs the browser build against the in-memory mock gateway. Two
properties of the harness keep a green run meaningful.

## A green run means no browser runtime errors

`tests/e2e/fixtures.ts` exports the `test` every spec in the directory imports. An
auto fixture collects `pageerror` events and `console.error` messages for the whole
test and fails the test during teardown, listing everything it saw. A spec cannot
forget to opt in, and a passing assertion no longer hides a broken render, a
rejected promise or a React warning.

`ALLOWED_RUNTIME_ERRORS` is the only way a message is ignored. Each entry states
the exact message shape and why it is expected, and console entries are matched
against the failing resource URL — Chromium reports every refused subresource with
the same generic sentence, so matching on the sentence alone would swallow
unrelated failures. Today the list holds one entry: `myspace-asset://` is a
Tauri-only protocol handler, so thumbnails in a plain browser are refused before
any request is made; what the images render is asserted by component tests.

To check the harness itself, add a temporary spec that raises a `pageerror` or an
unexpected `console.error`, confirm it fails with the collected list, then delete
it (the proof does not belong in the committed suite).

## A green run means the tests hit this checkout's code

`tests/e2e/port.ts` allocates a free port per run and `playwright.config.ts`
hands it to both Vite (`--host 127.0.0.1 --port <n> --strictPort`) and Playwright
(`baseURL`, `webServer.url`). Nothing is hard-coded to 1420, so a leftover dev
server from another checkout cannot serve a stale bundle: Playwright is
configured with `reuseExistingServer: false` and aborts with `… is already used`
if something already owns the port, and `--strictPort` stops Vite from quietly
landing somewhere else. `E2E_PORT=<n>` pins the port when a caller needs it.

Playwright re-evaluates the config inside every worker, so the allocated port is
written back to `process.env.E2E_PORT`; without that each worker would allocate
its own port and every `page.goto` would be refused.

## Known limitation

The mock keeps cards and the board snapshot in one in-memory graph, so a card's
local revision is always the store's revision. Bugs that need a *stale local
revision* against a newer snapshot — the class of failure behind the mixed-move
regressions — cannot be reproduced through the UI here; they are covered by
gateway and command unit tests, and by backend tests that reject a stale
expectation.
