import { expect, test } from "./fixtures";

// Error reports: the canvas error banner offers "Copy report", which copies the
// saved report text and then confirms. Nothing is copied until the click.
//
// The in-memory mock's test-only `?fixture=load-failure`
// (src/services/mock-workspace-gateway.ts) fails the first Home load, so the
// banner appears on startup.

test("Copy report copies the error report and confirms", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.evaluate(() => navigator.clipboard.writeText("untouched"));

  await page.goto("/?fixture=load-failure");

  const banner = page.getByTestId("error-banner");
  await expect(banner).toContainText("mock: the Home board could not be loaded");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("untouched");

  await banner.getByRole("button", { name: "Copy report" }).click();

  await expect(banner.getByText("Report copied — send it to the developer")).toBeVisible();
  await expect(banner.getByRole("button", { name: "Copy report" })).toHaveCount(0);
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("MySpace error report");
  expect(clipboard).toContain("Message: mock: the Home board could not be loaded");
  expect(clipboard).toContain("Source: canvas");
});
