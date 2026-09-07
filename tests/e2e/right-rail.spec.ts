import { expect, test } from "@playwright/test";

test("right rail renders content", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);
  // Open the board so tabs exist.
  await page.locator(".board-portal-card__tile").dblclick({ force: true });
  await expect(page.getByTestId("board-tab")).toHaveCount(2);
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();

  // Create a note and blind-drop it into the portal -> goes to Unsorted.
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);
  const noteCenter = await page.evaluate(() => {
    const el = document.querySelector(".note-card")!;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const portal = await page.locator(".board-portal-card__tile").boundingBox();
  if (!portal) return;
  await page.mouse.move(noteCenter.x, noteCenter.y);
  await page.mouse.down();
  await page.mouse.move(portal.x + portal.width / 2, portal.y + portal.height / 2, { steps: 8 });
  await page.mouse.up();

  // Open the child board: Unsorted panel should show the note.
  await page.locator(".board-portal-card__tile").dblclick({ force: true });
  await expect(page.getByTestId("unsorted-panel")).toBeVisible();
  await expect(page.getByTestId("unsorted-card")).toHaveCount(1);
  // Right rail (bookmarks) should render its heading.
  await expect(page.getByText("Quick Boards")).toBeVisible();
});