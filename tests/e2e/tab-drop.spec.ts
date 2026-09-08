import { expect, test } from "@playwright/test";

// Cross-board drag onto a board tab: hovering a tab opens that board, and
// releasing the pointer moves the card there. Runs against the in-memory mock.

test("dragging a note onto a board tab moves it to that board", async ({ page }) => {
  await page.goto("/");

  // Create a child board, open it (so a tab exists), then return Home.
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);
  await page.locator(".board-portal-card__tile").dblclick({ force: true });
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();
  await expect(page.getByTestId("board-tab")).toHaveCount(2);

  // Create a note on Home.
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);

  // Drag the note onto the "New Board" tab and hold for the hover-open.
  const note = await page.locator(".note-card").boundingBox();
  const tab = await page
    .getByTestId("board-tab")
    .filter({ hasText: "New Board" })
    .boundingBox();
  if (!note || !tab) throw new Error("note/tab not visible");

  await page.mouse.move(note.x + note.width / 2, note.y + note.height / 2);
  await page.mouse.down();
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2, { steps: 10 });
  await page.waitForTimeout(1000);

  // The hover opened the child board and the ghost is previewing.
  await expect(page.getByTestId("breadcrumbs")).toContainText("New Board");
  await expect(page.getByTestId("cross-board-ghost")).toBeVisible();

  // Move over the canvas and release to commit the move.
  const canvas = await page.getByTestId("canvas-region").boundingBox();
  if (!canvas) throw new Error("canvas not visible");
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2, {
    steps: 5,
  });
  await page.mouse.up();

  // The note now lives on the child board.
  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await expect(page.getByTestId("breadcrumbs")).toContainText("New Board");
});