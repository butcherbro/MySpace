import { expect, test } from "@playwright/test";

// Irreversible Empty Trash: requires the exact token EMPTY, then clears the
// Trash and the rail badge. Runs against the in-memory mock.

test("emptying trash requires typing EMPTY and clears it", async ({ page }) => {
  await page.goto("/");

  // Create and delete a note.
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.locator(".canvas-surface").focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("trash-badge")).toHaveText("1");

  // Open Trash and start the empty flow.
  await page.getByRole("button", { name: "Open Trash" }).click();
  await page.getByRole("button", { name: "Empty Trash…" }).click();
  await expect(page.getByTestId("empty-trash-dialog")).toBeVisible();

  // Confirm is disabled until the exact token is typed.
  const confirm = page
    .getByTestId("empty-trash-dialog")
    .getByRole("button", { name: "Empty Trash", exact: true });
  await expect(confirm).toBeDisabled();
  await page.getByRole("textbox", { name: "Type EMPTY" }).fill("EMPTY");
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // Trash is now empty and the badge is gone.
  await expect(page.getByText("Trash is empty")).toBeVisible();
  await expect(page.getByTestId("trash-badge")).toHaveCount(0);
});