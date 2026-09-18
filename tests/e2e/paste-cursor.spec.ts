import { expect, test } from "./fixtures";
import { selectNotesOnly } from "./gestures";

// tasks/todo.md №18: paste (both the internal card clipboard and the
// text/html canvas-paste path) must land under the cursor, not at the
// (40, 40) cascade default. Both go through the same `lastCanvasPointRef`
// cursor tracker in App.tsx, so one spec covers both call sites.
//
// Runs against the in-memory MockWorkspaceGateway (no Tauri), so it is fast
// and deterministic.

test("paste cards lands under the cursor, not the top-left corner", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();

  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await page.waitForFunction(() => {
    const el = document.querySelector(".note-card");
    return el && el.getBoundingClientRect().width > 0;
  });

  await selectNotesOnly(page, 1);
  await page.keyboard.press("Control+c");

  // Move the cursor to a point far from the (40, 40) default before pasting.
  const target = { x: 500, y: 380 };
  await page.mouse.move(target.x, target.y, { steps: 5 });
  // A real Ctrl+V keypress doesn't reliably raise a native `paste` DOM event
  // in headless Chromium without a focused editable/clipboard permissions;
  // the internal card clipboard (App.tsx's `onPasteCards`) doesn't read
  // `clipboardData` at all, so a synthetic event exercises the same code
  // path deterministically.
  await page.evaluate(() => {
    const evt = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    window.dispatchEvent(evt);
  });

  await expect(page.getByTestId("note-card")).toHaveCount(2);
  const pasted = page.locator(".note-card").nth(1);
  // Within 2px: sub-pixel rounding through the CSS transform, not the bug
  // under test (which places the note tens of pixels off, at the corner).
  await expect
    .poll(async () => {
      const box = await pasted.boundingBox();
      if (!box) return null;
      return Math.abs(box.x - target.x) <= 2 && Math.abs(box.y - target.y) <= 2;
    })
    .toBe(true);
});

test("pasting text lands under the cursor, not the top-left corner", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();
  await expect(page.getByTestId("note-card")).toHaveCount(0);

  const target = { x: 460, y: 300 };
  await page.mouse.move(target.x, target.y, { steps: 5 });

  // The handler reads clipboard text/html from the event, not `x`/`y`; the
  // paste position comes from the tracked pointermove above, exactly as a
  // real Cmd+V would see it.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "pasted text");
    const evt = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    window.dispatchEvent(evt);
  });

  await expect(page.getByTestId("note-card")).toHaveCount(1);
  const pasted = page.locator(".note-card").first();
  await expect
    .poll(async () => {
      const box = await pasted.boundingBox();
      if (!box) return null;
      return Math.abs(box.x - target.x) <= 2 && Math.abs(box.y - target.y) <= 2;
    })
    .toBe(true);
});
