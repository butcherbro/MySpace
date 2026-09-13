import { expect, test } from "./fixtures";

// Folder shortcut lifecycle (browser/mock): render, Search by name, and
// Trash/restore. The dense fixture provides one folder alias via ?fixture=dense.
// Real Finder-drop and bookmark durability are covered by the packaged manual
// acceptance, not this browser suite.

test("folder shortcut renders, searches, and survives trash/restore", async ({ page }) => {
  await page.goto("/?fixture=folder");
  await page.waitForTimeout(500);

  const card = page.getByTestId("folder-shortcut-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Research");

  // Search finds it by display name.
  await page.getByRole("searchbox", { name: "Search" }).fill("Research");
  await expect(page.locator(".search-bar__title").first()).toContainText("Research");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("search-results")).toHaveCount(0);

  // Delete -> one Trash batch.
  await card.click({ button: "right" });
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("trash-badge")).toHaveText("1");
  await expect(card).toHaveCount(0);

  // Restore brings it back.
  await page.getByRole("button", { name: "Open Trash" }).click();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("trash-drawer")).toHaveText(/Trash is empty/);
  await expect(card).toHaveCount(1);
});
