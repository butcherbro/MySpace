import { test as base, expect, type ConsoleMessage, type Page } from "@playwright/test";

/**
 * Browser runtime errors that every E2E test fails on.
 *
 * An allowlist entry is a deliberate, narrow exception: it must name the exact
 * message shape and the reason it is expected. Anything not matched here fails
 * the test during teardown, so a broken render, a rejected promise or a React
 * warning cannot hide behind a green assertion.
 *
 * Keep this list as small as possible; prefer fixing the app over allowing the
 * message.
 */
export const ALLOWED_RUNTIME_ERRORS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    // Matched on the resource URL, not just on the message: Chromium reports
    // every refused subresource with this same generic sentence, so the URL is
    // what keeps the exception from swallowing unrelated failures.
    pattern:
      /^console\.error: Failed to load resource: net::ERR_UNKNOWN_URL_SCHEME @ myspace-asset:\/\//u,
    reason:
      "`myspace-asset://` is a Tauri-only protocol handler. E2E runs the browser build " +
      "against the in-memory mock, so card thumbnails and board covers point at a scheme " +
      "Chromium refuses before any network request is made. What the images render is " +
      "asserted by component tests that read the resulting src.",
  },
];

export function isAllowedRuntimeError(text: string): boolean {
  return ALLOWED_RUNTIME_ERRORS.some((entry) => entry.pattern.test(text));
}

/** Message plus the document/resource it came from, so allowlists can be precise. */
function describeConsoleError(message: ConsoleMessage): string {
  const location = message.location();
  const where = location.url ? ` @ ${location.url}` : "";
  return `console.error: ${message.text()}${where}`;
}

function attach(page: Page, violations: string[]): void {
  page.on("pageerror", (error) => {
    const text = `pageerror: ${error.stack ?? String(error)}`;
    if (!isAllowedRuntimeError(text)) violations.push(text);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = describeConsoleError(message);
    if (!isAllowedRuntimeError(text)) violations.push(text);
  });
}

/**
 * Auto fixture: attached to every test in this directory, so a spec cannot
 * forget to opt in. The failure is raised after the test body, which keeps the
 * assertion message (the useful part) intact and appends the browser errors.
 */
export const test = base.extend<{ failOnBrowserRuntimeErrors: void }>({
  failOnBrowserRuntimeErrors: [
    async ({ page }, use) => {
      const violations: string[] = [];
      attach(page, violations);

      await use();

      if (violations.length > 0) {
        const listed = violations.map((violation) => `  - ${violation}`).join("\n");
        throw new Error(`browser runtime errors during this test:\n${listed}`);
      }
    },
    { auto: true },
  ],
});

export { expect };
