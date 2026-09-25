import { expect, test } from "./fixtures";

// In-app updates are desktop-only: the browser build (in-memory mock gateway,
// no `__TAURI_INTERNALS__`) must never check for updates, show the banner, or
// offer "Check for updates…".
test("the update banner never renders in the browser build", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "New note", exact: true })).toBeVisible();

  // Past the 3 s startup delay the desktop build would have checked by now.
  await page.waitForTimeout(3500);
  await expect(page.getByTestId("update-prompt")).toHaveCount(0);

  await page.getByRole("button", { name: "Open Trash" }).click();
  await expect(page.getByTestId("trash-drawer")).toBeVisible();
  await expect(page.getByTestId("trash-drawer-check-updates")).toHaveCount(0);
});
