import { expect, test } from "@playwright/test";

// Reversible Trash acceptance: delete a Note + child Board in one selection,
// navigate away and back (projection rebuild must not resurrect them), inspect
// the single recoverable batch, restore it, and confirm both objects return.
// Runs against the in-memory MockWorkspaceGateway (no Tauri).

test("trash drawer inspects and restores a deleted note and board", async ({ page }) => {
  await page.goto("/");

  // Create a note and one child board on Home.
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);

  // Select all (note + board) via the canvas select-all shortcut, then Delete
  // both in one selection: exactly one Trash batch.
  await page.locator(".canvas-surface").focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("note-card")).toHaveCount(0);
  await expect(page.getByTestId("board-portal-card")).toHaveCount(0);
  await expect(page.getByTestId("trash-badge")).toHaveText("1");

  // Create a second board, open it, then return Home: the deleted objects must
  // not return after a projection rebuild.
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);
  await page.locator(".board-portal-card__tile").dblclick({ force: true });
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(0);
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);

  // Open Trash and inspect the single recoverable batch.
  await page.getByRole("button", { name: "Open Trash" }).click();
  await expect(page.getByTestId("trash-drawer")).toBeVisible();
  await expect(page.getByTestId("trash-batch")).toHaveCount(1);
  await expect(page.getByText("1 Board · 2 cards")).toBeVisible();

  // Restore the batch and confirm the note and board portal return.
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Trash is empty")).toBeVisible();
  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await expect(page.getByTestId("board-portal-card")).toHaveCount(2);

  // Close the drawer.
  await page.getByRole("button", { name: "Close Trash" }).click();
  await expect(page.getByTestId("trash-drawer")).toHaveCount(0);
});

test("trash rail button and drawer handle the empty and keyboard-close states", async ({ page }) => {
  await page.goto("/");

  // With nothing deleted there is no badge, and the drawer shows the empty state.
  await expect(page.getByTestId("trash-badge")).toHaveCount(0);
  await page.getByRole("button", { name: "Open Trash" }).click();
  await expect(page.getByTestId("trash-drawer")).toBeVisible();
  await expect(page.getByText("Trash is empty")).toBeVisible();

  // Escape closes the drawer without mutating the workspace.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("trash-drawer")).toHaveCount(0);
});