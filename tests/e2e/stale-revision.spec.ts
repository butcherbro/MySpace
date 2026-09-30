import { waitForCanvasReady } from "./gestures";
import { expect, test } from "./fixtures";

// A write refused as `stale_revision` shows its error banner and re-reads the
// open board, so the card shows what is stored instead of staying diverged.
//
// The mock's test-only `?fixture=stale-card` (src/services/mock-workspace-gateway.ts)
// hands the page a note at revision 1 and then rewrites it at revision 2, as
// another device would; the page's next write to that note is refused.

test("a stale write shows its error and reloads the board to the stored state", async ({ page }) => {
  await page.goto("/?fixture=stale-card");
  await waitForCanvasReady(page);
  const note = page.getByTestId("note-card");
  await expect(note).toContainText("Before the other device");

  const box = await note.boundingBox();
  if (!box) throw new Error("note not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 5 });
  await page.mouse.up();

  await expect(page.getByTestId("error-banner")).toContainText("stale_revision: expected 1, actual 2");
  await expect(note).toContainText("Written on another device");
  // The reload must not wipe the failed write's banner.
  await expect(page.getByTestId("error-banner")).toContainText("stale_revision: expected 1, actual 2");
});

test("typing into a note another device only moved keeps both the text and the move", async ({ page }) => {
  await page.goto("/?fixture=stale-card-frame");
  await waitForCanvasReady(page);
  const note = page.getByTestId("note-card");
  await expect(note).toContainText("Before the other device");
  const before = await note.boundingBox();
  if (!before) throw new Error("note not visible");

  await page.mouse.click(before.x + before.width / 2, before.y + before.height / 2);
  await expect(page.locator('.note-card [contenteditable="true"]')).toHaveCount(1);
  await page.keyboard.press("End");
  await page.keyboard.type(" and mine");

  await expect(page.getByTestId("error-banner")).toContainText("stale_revision");
  await expect(note).toContainText("Before the other device and mine");
  await expect.poll(async () => (await note.boundingBox())?.x).toBeGreaterThan(before.x + 300);

  // Leaving Home and coming back re-reads it from the backend.
  await page.waitForTimeout(350);
  await page.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.locator(".board-portal-card__tile").dblclick({ force: true });
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();
  await expect(note).toContainText("Before the other device and mine");
  await expect.poll(async () => (await note.boundingBox())?.x).toBeGreaterThan(before.x + 300);
});
