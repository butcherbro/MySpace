import { expect, test } from "./fixtures";

// Group move: dragging one card of a multi-selection onto a breadcrumb moves the
// whole selection into that board's Unsorted panel. Runs against the in-memory mock.

test("dragging a multi-selection onto a breadcrumb moves all cards", async ({ page }) => {
  await page.goto("/");

  // Create a child board and put two notes inside it.
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.locator(".board-portal-card__tile").dblclick({ force: true });
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(2);

  // Select both notes.
  await page.locator(".canvas-surface").focus();
  await page.keyboard.press("Control+a");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);

  // Drag the first note onto the Home breadcrumb.
  const note = await page.locator(".note-card").first().boundingBox();
  const crumb = await page
    .getByTestId("breadcrumbs")
    .getByRole("button", { name: "Home" })
    .boundingBox();
  if (!note || !crumb) throw new Error("note/crumb not visible");

  await page.mouse.move(note.x + note.width / 2, note.y + note.height / 2);
  await page.mouse.down();
  await page.mouse.move(crumb.x + crumb.width / 2, crumb.y + crumb.height / 2, { steps: 8 });
  await page.mouse.up();

  // Both notes left the child board.
  await expect(page.getByTestId("note-card")).toHaveCount(0);

  // Navigate Home: both notes are now in Home's Unsorted panel.
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();
  await expect(page.getByTestId("unsorted-panel")).toBeVisible();
  await expect(page.getByTestId("unsorted-card")).toHaveCount(2);
});