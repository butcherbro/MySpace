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
