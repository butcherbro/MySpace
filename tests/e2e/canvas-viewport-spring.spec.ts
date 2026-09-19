import { expect, test } from "./fixtures";

// todo.md №26: "the canvas springs back to the top" bug.
//
// Root cause: `onMoveEnd` (CanvasAdapter -> App.tsx's `useViewportController`)
// pins the *persisted* viewport to `{x: 0, y: 0}` on every scroll settle
// (ADR-0003: pan is never saved, only zoom) and feeds that same zeroed value
// back into `state.viewport` — the prop CanvasAdapter used for both
// `defaultViewport` and the `onInit` imperative `setViewport`. Those two are
// also used by `<ReactFlow key={interactionResetRevision}>`'s *interaction-
// reset* remount (`resetInterruptedMarquee`, meant only to clear a `pointerup`
// WKWebView can lose mid-marquee) — so any trigger of that remount (window
// blur, Escape, a lost pointerup) while a `.react-flow__selection` box is
// still in the DOM silently yanked the live pan back to (0, 0), regardless of
// where the user had actually scrolled to. This is intermittent by nature: it
// only fires when a marquee-adjacent gesture coincides with a blur/Escape.
//
// Fix: CanvasAdapter now tracks the real, continuously updated pan in its own
// `liveViewportRef`, independent of the zeroed value meant for persistence,
// and both `defaultViewport` and `onInit`'s `setViewport` use that instead.
// Only a genuine board switch (`viewportResetToken`) still resets to (0, 0),
// per ADR-0003.
test("an interrupted marquee (window blur) does not spring the pan back to the origin", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();

  // A tall board: enough notes that scrolling down is a real, useful gesture.
  for (let i = 0; i < 10; i++) {
    await page.getByRole("button", { name: "New note" }).click();
  }
  await expect(page.getByTestId("note-card")).toHaveCount(10);

  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  const readTranslate = async (): Promise<[number, number] | null> => {
    const style = await page.locator(".react-flow__viewport").getAttribute("style");
    const m = style?.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
  };

  // Scroll down and let the gesture fully settle — React Flow's own
  // `onMoveEnd` fires some time after the CSS transform already moved, and it
  // is that settle (not the transform) which pins `state.viewport` to
  // `{0, 0}` for persistence (the trap the fix avoids). The remount below
  // must see a `liveViewportRef` that has already caught up to this settle,
  // exactly as a real user pausing before the next gesture would.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(readTranslate).not.toEqual([0, 0]);
  const scrolled = await readTranslate();
  await page.waitForTimeout(500);

  // Start a marquee drag on empty canvas and leave it hanging (no mouseup) —
  // this is what leaves `.react-flow__selection` in the DOM.
  await page.mouse.move(box.x + box.width - 40, box.y + box.height - 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 140, box.y + box.height - 140, { steps: 8 });
  await expect(page.locator(".react-flow__selection")).toHaveCount(1);

  // A window blur mid-drag (e.g. Cmd+Tab) is exactly what
  // `resetInterruptedMarquee` reacts to.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));

  // The pan must still be where the user scrolled it — not sprung back to
  // the origin.
  await expect.poll(readTranslate).toEqual(scrolled);
});
