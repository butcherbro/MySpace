import { expect, test } from "./fixtures";

// Workspace undo covers note text: one editing session = one undo entry, in
// order with card creation. The user's report: create a note, type, paste a
// screenshot, Cmd+Z — the screenshot went away, and the next Cmd+Z skipped the
// text. Runs against the in-memory mock (its clipboard import always yields an
// image asset, so a synthetic image paste exercises the real paste path).

const editSelector = '.note-card [contenteditable="true"]';

async function editNote(page: import("@playwright/test").Page) {
  const rect = await page.evaluate(() => {
    const r = document.querySelector(".note-card")!.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(rect.x, rect.y);
  await expect(page.locator(editSelector)).toHaveCount(1);
}

async function leaveEditor(page: import("@playwright/test").Page) {
  // Two pane clicks within 300 ms fold into a double-click, which creates a
  // note (CanvasAdapter `DOUBLE_CLICK_MS`); fast typing between two leaves
  // would otherwise hit that window.
  await page.waitForTimeout(350);
  await page.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
  await expect(page.locator(editSelector)).toHaveCount(0);
}

test("Cmd+Z undoes the last created card first, then the last note editing session", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await page.waitForFunction(() => {
    const el = document.querySelector(".note-card");
    return el && el.getBoundingClientRect().width > 0;
  });

  // Two editing sessions: the second one is what the second Cmd+Z must undo.
  await editNote(page);
  await page.keyboard.type("first");
  await leaveEditor(page);
  await editNote(page);
  await page.keyboard.press("End");
  await page.keyboard.type(" second");
  await leaveEditor(page);
  const note = page.getByTestId("note-card").first();
  await expect(note).toHaveText("first second");

  // Another card on top of the history.
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(2);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await expect(note).toHaveText("first second");

  await page.keyboard.press("ControlOrMeta+z");
  await expect(note).toHaveText("first");

  // Redo brings the session back, and the editor opens on the restored text.
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(note).toHaveText("first second");
  await editNote(page);
  await expect(page.locator(editSelector)).toHaveText("first second");
});

test("Cmd+Z after pasting a screenshot removes it, then restores the note's text", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await page.waitForFunction(() => {
    const el = document.querySelector(".note-card");
    return el && el.getBoundingClientRect().width > 0;
  });

  await editNote(page);
  await page.keyboard.type("typed text");
  await leaveEditor(page);
  const note = page.getByTestId("note-card");
  await expect(note).toHaveText("typed text");

  await page.mouse.move(500, 380, { steps: 5 });
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("image-card")).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("image-card")).toHaveCount(0);
  await expect(note).toHaveText("typed text");

  await page.keyboard.press("ControlOrMeta+z");
  await expect(note).toHaveText("");
  await expect(page.getByTestId("note-card")).toHaveCount(1);
});
