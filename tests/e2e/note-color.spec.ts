import { expect, test } from "./fixtures";

// Note background color: selecting a note swaps the left rail to note tools with
// a "Note color" palette; choosing a preset changes the card color and survives
// navigation (persisted through the backend). Runs against the in-memory mock.

test("changing a note's background color persists across navigation", async ({ page }) => {
  await page.goto("/");

  // Create a note and select it (opens the contextual note rail).
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);
  const rect = await page.evaluate(() => {
    const el = document.querySelector(".note-card")!;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(rect.x, rect.y);

  // The note rail shows the note-color palette; choose pale yellow.
  const yellow = page.getByRole("button", { name: "Pale yellow" });
  await expect(yellow).toBeVisible();
  await yellow.click();

  // The card now carries the yellow preset.
  await expect(page.locator('.note-card[data-color="yellow"]')).toHaveCount(1);

  // Click empty canvas to leave note tools, then navigate away and back.
  await page.locator(".react-flow__pane").click({ position: { x: 400, y: 300 } });
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.locator(".board-portal-card__tile").dblclick({ force: true });
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();
  await expect(page.locator('.note-card[data-color="yellow"]')).toHaveCount(1);
});