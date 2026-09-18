import { expect, test } from "./fixtures";

// tasks/todo.md №17: board shortcuts. Runs against the in-memory
// MockWorkspaceGateway (no Tauri). Covers: create a shortcut from a portal's
// context menu, click it to navigate to the target with real breadcrumbs, and
// the trash cascade — trashing the portal removes the shortcut too, and
// restoring brings both back.

test("Create Shortcut on a portal creates a shortcut card that navigates to the same board", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();

  await page.getByRole("button", { name: "New board", exact: true }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);

  await page.getByTestId("board-portal-card").click({ button: "right" });
  await page.getByRole("button", { name: "Create Shortcut" }).click();

  await expect(page.getByTestId("board-shortcut-card")).toHaveCount(1);
  // The shortcut mirrors the target's own tile identity/title.
  await expect(page.locator(".board-shortcut-card .board-portal-card__title")).toHaveText("New Board");

  // It landed near the source (+24/+24), not stacked exactly on top of it.
  const portalBox = await page.getByTestId("board-portal-card").boundingBox();
  const shortcutBox = await page.getByTestId("board-shortcut-card").boundingBox();
  expect(portalBox).not.toBeNull();
  expect(shortcutBox).not.toBeNull();
  expect(Math.abs((shortcutBox!.x ?? 0) - (portalBox!.x ?? 0))).toBeGreaterThan(0);

  // Double-clicking the shortcut opens the same board the portal opens, with
  // real breadcrumbs — not a copy.
  await page.getByTestId("board-shortcut-card").locator(".board-portal-card__tile").dblclick({ force: true });
  await expect(page.getByTestId("breadcrumbs")).toContainText("New Board");
  await expect(page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" })).toBeVisible();
});

test("trashing the portal cascades to its shortcut; restoring brings both back", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();

  await page.getByRole("button", { name: "New board", exact: true }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);

  await page.getByTestId("board-portal-card").click({ button: "right" });
  await page.getByRole("button", { name: "Create Shortcut" }).click();
  await expect(page.getByTestId("board-shortcut-card")).toHaveCount(1);

  // Trash the portal (which owns the board) via its own context menu. The
  // shortcut sits +24/+24 on top of it, so aim at the portal's exposed
  // top-left corner instead of its (now covered) center.
  await page
    .getByTestId("board-portal-card")
    .click({ button: "right", position: { x: 4, y: 4 } });
  await page.getByRole("button", { name: "Delete" }).click();

  await expect(page.getByTestId("board-portal-card")).toHaveCount(0);
  await expect(page.getByTestId("board-shortcut-card")).toHaveCount(0);

  // Restore the single batch: both the portal and the shortcut return.
  await page.getByRole("button", { name: "Open Trash" }).click();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);
  await expect(page.getByTestId("board-shortcut-card")).toHaveCount(1);
});
