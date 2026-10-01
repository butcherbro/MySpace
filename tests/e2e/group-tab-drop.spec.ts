import type { Page } from "@playwright/test";
import { selectNotesOnly, waitForCanvasReady } from "./gestures";
import { expect, test } from "./fixtures";

// Mixed group moves onto a board tab. ADR-0007 makes the backend refuse a
// selection that contains the destination board's own portal, and move loose
// leaves into the destination's Unsorted panel in one atomic call.

async function openNewBoardTab(page: Page) {
  await page.goto("/");
  await waitForCanvasReady(page);
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.locator(".board-portal-card__tile").dblclick({ force: true });
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();
  await expect(page.getByTestId("board-tab")).toHaveCount(2);
}

async function addNotes(page: Page, count: number) {
  for (let index = 0; index < count; index += 1) {
    await page.getByRole("button", { name: "New note", exact: true }).click();
  }
  await expect(page.getByTestId("note-card")).toHaveCount(count);
}

/** Drag the first selected card onto the "New Board" tab and release on its canvas. */
async function dropOnNewBoardTab(page: Page) {
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
}

test("dragging loose notes onto a tab moves them into that board's Unsorted", async ({ page }) => {
  await openNewBoardTab(page);
  await addNotes(page, 2);
  await selectNotesOnly(page, 2);
  await dropOnNewBoardTab(page);

  await expect(page.getByTestId("unsorted-panel")).toBeVisible();
  await expect(page.getByTestId("unsorted-card")).toHaveCount(2);
});

test("a selection containing the destination board's own portal is refused whole", async ({
  page,
}) => {
  await openNewBoardTab(page);
  await addNotes(page, 2);

  // Grab everything: the two notes plus the New Board portal sitting on Home. The
  // old code silently dropped that portal; the atomic move refuses the whole
  // selection instead, so nothing may move.
  const pane = await page.locator(".react-flow__pane").boundingBox();
  if (!pane) throw new Error("pane not visible");
  await page.mouse.move(pane.x + 5, pane.y + pane.height - 40);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width - 5, pane.y + 5, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(3);

  await dropOnNewBoardTab(page);

  await expect(page.getByTestId("unsorted-card")).toHaveCount(0);
});
