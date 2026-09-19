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

// todo.md №25: pasting *into* an open note editor must never also create a
// second, canvas-level note. The pre-fix bug was the `paste` DOM event's
// `target` not reliably reflecting real focus in the Tauri WKWebView build —
// so this dispatches paste on `document` (not on the editor element), exactly
// like the live repro, while the editor genuinely holds DOM focus. A synthetic
// paste is used deliberately: a real `Meta+V` keypress doesn't reliably raise
// a native `paste` DOM event in headless Chromium either, and it would not
// reproduce the WKWebView target/focus mismatch this test targets anyway — the
// keydown-vs-activeElement gap is covered at the unit level in
// `use-canvas-paste.test.ts`.
test("pasting inside the open note editor does not also create a second note on the canvas", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();

  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await page.waitForFunction(() => {
    const el = document.querySelector(".note-card");
    return el && el.getBoundingClientRect().width > 0;
  });

  const editSelector = '.note-card [contenteditable="true"]';
  const rect = await page.evaluate(() => {
    const el = document.querySelector(".note-card")!;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(rect.x, rect.y);
  await expect(page.locator(editSelector)).toHaveCount(1);
  // Let Tiptap's own focus effect (`editor.commands.focus()`, NoteEditor.tsx)
  // finish settling `document.activeElement` before the paste below — without
  // this wait the test is racy: dispatching the paste while that effect is
  // still in flight non-deterministically misses the repro.
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("contenteditable"))).toBe("true");

  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "pasted inside the editor");
    // `target: document` mirrors the live WKWebView repro: the editor is
    // focused (document.activeElement), but the DOM event's own `target` does
    // not point at it.
    const evt = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.dispatchEvent(evt);
  });

  // `handleCreateNote` awaits `CreateNoteCommand` before dispatching
  // `cardAdded`, so a bare `toHaveCount(1)` here would pass prematurely (it
  // already matches before the would-be duplicate lands) even on the bug —
  // `expect.poll` must observe the count stay at 1 across the async gap, not
  // just catch it once on the first check.
  await expect
    .poll(async () => page.getByTestId("note-card").count(), { timeout: 1000 })
    .toBe(1);
  await page.waitForTimeout(300);
  // Still exactly one note — no duplicate landed on the canvas.
  await expect(page.getByTestId("note-card")).toHaveCount(1);
});

// todo.md №25: `lastCanvasPointRef` is flow-space and only meaningful for the
// board that produced it. Switching boards without moving the mouse again
// must not reuse the previous board's stale coordinate — that read as "paste
// lands in the corner" on the live app, since the old number is meaningless on
// the new board's own coordinate system.
test("paste on a freshly opened board does not reuse the previous board's stale cursor position", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();

  // Create a nested board and navigate into it, then establish a tracked
  // cursor position on the Home board before navigating away.
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);
  await page.mouse.move(700, 500, { steps: 5 });

  // Open the nested (empty) board without any further mouse movement.
  const tile = page.locator(".board-portal-card__tile").first();
  await tile.dblclick();
  await expect(page.getByTestId("breadcrumbs")).toContainText("New Board");
  await expect(page.getByTestId("note-card")).toHaveCount(0);

  const center = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="canvas"]')!;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });

  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "pasted on the new board");
    const evt = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    window.dispatchEvent(evt);
  });

  await expect(page.getByTestId("note-card")).toHaveCount(1);
  const pasted = page.locator(".note-card").first();
  // Lands near the viewport center (the fallback: frame's top-left is the
  // paste position, same as the other two tests above), not wherever
  // (700, 500) happened to map to in flow space back on the Home board.
  await expect
    .poll(async () => {
      const box = await pasted.boundingBox();
      if (!box) return null;
      return Math.abs(box.x - center.x) <= 4 && Math.abs(box.y - center.y) <= 4;
    })
    .toBe(true);
});
