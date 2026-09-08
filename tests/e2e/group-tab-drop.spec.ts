import { expect, test } from "@playwright/test";

// Group move onto a board tab: hover the tab to open the board, then release,
// and the whole multi-selection lands in that board's Unsorted panel.

test("dragging a multi-selection onto a tab moves all cards", async ({ page }) => {
  await page.goto("/");

  // Create a child board B and open it as a tab; then return Home.
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.locator(".board-portal-card__tile").dblclick({ force: true });
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();
  await expect(page.getByTestId("board-tab")).toHaveCount(2);

  // Two notes on Home (near the origin, above the board portal).
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(2);

  // Marquee-select everything (two notes + the board portal) via a full-pane drag.
  const pane = await page.locator(".react-flow__pane").boundingBox();
  if (!pane) throw new Error("pane not visible");
  await page.mouse.move(pane.x + 5, pane.y + pane.height - 40);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width - 5, pane.y + 5, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(3);

  // Drag the first note onto the "New Board" tab and hold to open it.
  const note = await page.locator(".note-card").first().boundingBox();
  const tab = await page.getByTestId("board-tab").filter({ hasText: "New Board" }).boundingBox();
  if (!note || !tab) throw new Error("note/tab not visible");

  await page.mouse.move(note.x + note.width / 2, note.y + note.height / 2);
  await page.mouse.down();
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2, { steps: 10 });
  await page.waitForTimeout(1000);
  await expect(page.getByTestId("breadcrumbs")).toContainText("New Board");

  const canvas = await page.getByTestId("canvas-region").boundingBox();
  if (!canvas) throw new Error("canvas not visible");
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2, { steps: 5 });
  await page.mouse.up();

  // Both notes are now in board B's Unsorted panel.
  await expect(page.getByTestId("unsorted-panel")).toBeVisible();
  await expect(page.getByTestId("unsorted-card")).toHaveCount(2);
});