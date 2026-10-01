import { waitForCanvasReady } from "./gestures";
import type { Page } from "@playwright/test";
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

  await expect(note).toContainText("Before the other device and mine");
  await expect.poll(async () => (await note.boundingBox())?.x).toBeGreaterThan(before.x + 300);
  // The refused save was written again at the stored revision: nothing failed.
  await expect(page.getByTestId("error-banner")).toHaveCount(0);

  // Leaving Home and coming back re-reads it from the backend.
  await page.waitForTimeout(350);
  await page.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.locator(".board-portal-card__tile").dblclick({ force: true });
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();
  await expect(note).toContainText("Before the other device and mine");
  await expect.poll(async () => (await note.boundingBox())?.x).toBeGreaterThan(before.x + 300);
});

// Another device rewrote the note's text (`?fixture=stale-card`): the typed text
// must not overwrite it, and must not be lost either. It becomes a note headed
// "Conflict copy" next to the original, as device sync does for concurrent edits.

/** Clicks the empty canvas below the error banner, which covers its top edge. */
async function clickEmptyCanvas(page: Page) {
  const canvas = await page.getByTestId("canvas").boundingBox();
  if (!canvas) throw new Error("canvas not visible");
  await page.mouse.click(canvas.x + 5, canvas.y + canvas.height - 5);
}

/** Leaves Home for a new board and comes back, so the board is re-read from the backend. */
async function reopenHome(page: Page) {
  // Two pane clicks within 300 ms are a double-click, which creates a note.
  await page.waitForTimeout(350);
  await clickEmptyCanvas(page);
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.locator(".board-portal-card__tile").dblclick({ force: true });
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();
  await waitForCanvasReady(page);
}

async function startTypingAtEnd(page: Page) {
  const note = page.getByTestId("note-card");
  await expect(note).toContainText("Before the other device");
  const box = await note.boundingBox();
  if (!box) throw new Error("note not visible");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.note-card [contenteditable="true"]')).toHaveCount(1);
  await page.keyboard.press("End");
}

function conflictCopy(page: Page) {
  return page.getByTestId("note-card").filter({ hasText: "Conflict copy" });
}

function original(page: Page) {
  return page.getByTestId("note-card").filter({ hasNotText: "Conflict copy" });
}

test("typing on after another device rewrote the note continues in a conflict copy", async ({ page }) => {
  await page.goto("/?fixture=stale-card");
  await waitForCanvasReady(page);
  await startTypingAtEnd(page);
  await page.keyboard.type(" and mine");

  // The autosave is refused: the typed text moves into a copy, and editing goes on there.
  await expect(conflictCopy(page)).toHaveAttribute("data-editing", "true");
  await page.keyboard.type(" and more");
  await expect(conflictCopy(page)).toContainText("Before the other device and mine and more");
  await expect(original(page)).toContainText("Written on another device");
  await expect(page.getByTestId("error-banner")).toContainText("Conflict copy");

  await reopenHome(page);
  await expect(original(page)).toContainText("Written on another device");
  await expect(conflictCopy(page)).toContainText("Before the other device and mine and more");
});

test("leaving a note another device rewrote keeps the typed text in a conflict copy", async ({ page }) => {
  await page.goto("/?fixture=stale-card");
  await waitForCanvasReady(page);
  await startTypingAtEnd(page);
  await page.keyboard.type(" and mine");
  // Blur before the autosave: the blur flush is the write that is refused.
  await clickEmptyCanvas(page);

  await expect(conflictCopy(page)).toContainText("Before the other device and mine");
  await expect(original(page)).toContainText("Written on another device");
  await expect(page.locator('.note-card [contenteditable="true"]')).toHaveCount(0);
  await expect(page.getByTestId("error-banner")).toContainText("Conflict copy");

  await reopenHome(page);
  await expect(original(page)).toContainText("Written on another device");
  await expect(conflictCopy(page)).toContainText("Before the other device and mine");
});

test("switching boards while the refused save is in flight keeps both texts and says so on the next board", async ({
  page,
}) => {
  await page.goto("/?fixture=stale-card");
  await waitForCanvasReady(page);
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await startTypingAtEnd(page);
  await page.keyboard.type(" and mine");
  // Opens the board without a click, so the editor keeps focus and the write
  // refused is the navigation's own flush of the draft.
  await page.locator(".board-portal-card__tile").dispatchEvent("dblclick");

  await expect(page.getByTestId("breadcrumbs")).toContainText("New Board");
  await expect(page.getByTestId("error-banner")).toContainText("Conflict copy");

  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();
  await waitForCanvasReady(page);
  await expect(original(page)).toContainText("Written on another device");
  await expect(conflictCopy(page)).toContainText("Before the other device and mine");
});

test("a refused save of the text the other device already wrote makes no conflict copy", async ({ page }) => {
  await page.goto("/?fixture=stale-card-same");
  await waitForCanvasReady(page);
  await startTypingAtEnd(page);
  await page.keyboard.type(" and mine");
  await page.waitForTimeout(350);

  await reopenHome(page);
  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await expect(page.getByTestId("note-card")).toContainText("Before the other device and mine");
});

test("when the conflict copy cannot be created the typed text stays in the open editor and the report", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?fixture=stale-card-copy-fails");
  await waitForCanvasReady(page);
  await startTypingAtEnd(page);
  await page.keyboard.type(" and mine");

  const banner = page.getByTestId("error-banner");
  await expect(banner).toContainText("could not be saved as a \"Conflict copy\" note");
  // The banner stays short; the text itself is in the saved error report.
  await expect(banner).not.toContainText("Before the other device and mine");
  const editor = page.locator('.note-card [contenteditable="true"]');
  await expect(editor).toHaveCount(1);
  await expect(editor).toContainText("Before the other device and mine");

  await banner.getByRole("button", { name: "Copy report" }).click();
  await expect(banner.getByText("Report copied — send it to the developer")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Before the other device and mine");
});

test("every character typed while the conflict copy is being created ends up in the copy", async ({ page }) => {
  await page.goto("/?fixture=stale-card-slow-copy");
  await waitForCanvasReady(page);
  await startTypingAtEnd(page);
  await page.keyboard.type(" and mine");
  // The autosave goes out and is refused; creating the copy takes 400 ms, and the user types on.
  await page.waitForTimeout(300);
  await page.keyboard.type(" abcdefgh", { delay: 40 });

  await expect(conflictCopy(page)).toHaveAttribute("data-editing", "true");
  await page.keyboard.type(" end");
  await expect(conflictCopy(page)).toContainText("Before the other device and mine abcdefgh end");
  await expect(original(page)).toContainText("Written on another device");

  await reopenHome(page);
  await expect(original(page)).toContainText("Written on another device");
  await expect(conflictCopy(page)).toContainText("Before the other device and mine abcdefgh end");
});

test("the original opened again after a slow hand-off edits the stored text, not the handed-off one", async ({
  page,
}) => {
  await page.goto("/?fixture=stale-card-slow-copy");
  await waitForCanvasReady(page);
  await startTypingAtEnd(page);
  await page.keyboard.type(" and mine");
  // Typing on while the copy is created: editing moves to it before the refused save settles.
  await page.waitForTimeout(300);
  await page.keyboard.type(" abc", { delay: 40 });
  await expect(conflictCopy(page)).toHaveAttribute("data-editing", "true");
  await expect(conflictCopy(page)).toContainText("Before the other device and mine abc");

  await page.waitForTimeout(350);
  await clickEmptyCanvas(page);
  await expect(conflictCopy(page)).toHaveAttribute("data-saving", "false");
  await expect(conflictCopy(page)).toHaveAttribute("data-editing", "false");
  const box = await original(page).boundingBox();
  if (!box) throw new Error("original not visible");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const editor = original(page).locator('[contenteditable="true"]');
  await expect(editor).toHaveText("Written on another device");

  // Its edits stay in the original: no second conflict copy.
  await page.keyboard.press("End");
  await page.keyboard.type(" x");
  await expect(editor).toHaveText("Written on another device x");
  await page.waitForTimeout(350);
  await clickEmptyCanvas(page);
  await expect(original(page)).toContainText("Written on another device x");
  await expect(conflictCopy(page)).toHaveCount(1);
});

test("a reload by another process's write keeps the note open and saves everything typed", async ({ page }) => {
  await page.goto("/?fixture=external-write");
  await waitForCanvasReady(page);
  const typed = page.getByTestId("note-card").filter({ hasText: "Typing here" });
  const box = await typed.boundingBox();
  if (!box) throw new Error("note not visible");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("End");

  // Typed without a pause long enough for an autosave, across the change poll (every 3 s).
  const text = " one two three four five six seven eight nine ten eleven twelve";
  await page.keyboard.type(text, { delay: 110 });

  // The board was reloaded under the typing, and the note stayed open.
  await expect(page.getByTestId("note-card").filter({ hasText: "Changed by another process" })).toHaveCount(1);
  const editor = page.locator('.note-card [contenteditable="true"]');
  await expect(editor).toHaveCount(1);
  await expect(editor).toContainText(`Typing here${text}`);

  await reopenHome(page);
  await expect(page.getByTestId("note-card").filter({ hasText: "Typing here" })).toContainText(`Typing here${text}`);
});
