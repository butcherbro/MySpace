import { expect, test, type Page } from "./fixtures";

// Long text in a note (user report 2026-10-03, Windows): a narrow "till
// receipt" note many screens tall, a scroll that springs back to the top, and
// — past the backend's 10 000px frame limit — a note that vanished mid-scroll
// because the rejected auto-grow left the store's height behind the DOM's.
// Now: a long text gets one standard width, height stops at about a screen,
// and the rest scrolls inside the note only while it is being edited.

const paragraphs = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `Абзац ${i}: на каждом Google-аккаунте откройте Google Cloud Console и создайте отдельный проект.`,
  ).join("\n\n");

async function pasteIntoEditor(page: Page, text: string) {
  // ProseMirror's own paste handler runs on the contenteditable; a synthetic
  // event carries the clipboard payload without OS clipboard permissions.
  await page.evaluate((value) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", value);
    document
      .querySelector(".ProseMirror")!
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

async function openNewNote(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();
  await page.getByRole("button", { name: "New note" }).click();
  const card = page.getByTestId("note-card");
  await card.dblclick();
  await expect(card).toHaveAttribute("data-editing", "true");
  return card;
}

const readTranslateY = async (page: Page) => {
  const style = await page.locator(".react-flow__viewport").getAttribute("style");
  const m = style?.match(/translate\([-\d.]+px,\s*([-\d.]+)px\)/);
  return m ? parseFloat(m[1]) : null;
};

test("a long paste into a note widens it and grows it to fit", async ({ page }) => {
  const card = await openNewNote(page);
  await pasteIntoEditor(page, paragraphs(8));

  await expect.poll(async () => (await card.boundingBox())?.width).toBe(480);
  // Grown to the content: nothing left to scroll inside the card.
  await expect
    .poll(() => page.getByTestId("note-card-body").evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeLessThanOrEqual(0);
});

test("a long text pasted on the empty canvas becomes a wide note sized to its content", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();
  await page.mouse.move(300, 200);
  await page.evaluate((value) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", value);
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, paragraphs(8));

  const card = page.getByTestId("note-card");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-editing", "false");
  await expect.poll(async () => (await card.boundingBox())?.width).toBe(480);
  await expect
    .poll(() => page.getByTestId("note-card-body").evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeLessThanOrEqual(0);
});

test("a very long note stops at about a screen and scrolls inside only while editing", async ({ page }) => {
  const card = await openNewNote(page);
  const body = page.getByTestId("note-card-body");
  await pasteIntoEditor(page, paragraphs(220));

  // The standard long-text width, one screen tall, no rejected frame write.
  await expect.poll(async () => (await card.boundingBox())?.width).toBe(480);
  await expect.poll(async () => Math.round((await card.boundingBox())?.height ?? 0)).toBe(720);
  await page.waitForTimeout(400); // past the auto-grow write debounce
  await expect(page.locator(".error-banner")).toHaveCount(0);

  // Editing: the wheel over the note scrolls its text, not the canvas.
  await body.evaluate((el) => (el.scrollTop = 0));
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  const before = await readTranslateY(page);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await readTranslateY(page)).toBe(before);

  // At the end of the text the wheel goes back to the canvas.
  await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.mouse.wheel(0, 300);
  await expect.poll(() => readTranslateY(page)).toBeLessThan(before ?? 0);

  // Idle: clipped with a fade, back at the top, and the wheel pans the canvas.
  await page.mouse.click(1200, 650);
  await expect(card).toHaveAttribute("data-editing", "false");
  await expect(card.locator(".note-card__fade")).toHaveCount(1);
  expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
  const idleBox = (await card.boundingBox())!;
  await page.mouse.move(idleBox.x + idleBox.width / 2, idleBox.y + Math.min(idleBox.height, 400) / 2);
  const idleBefore = (await readTranslateY(page)) ?? 0;
  await page.mouse.wheel(0, 300);
  await expect.poll(() => readTranslateY(page)).toBeLessThan(idleBefore);
  expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
});

test("a manual shrink of a long note sticks instead of springing back", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 }); // the corner must be on screen
  const card = await openNewNote(page);
  await pasteIntoEditor(page, paragraphs(60));
  await expect.poll(async () => Math.round((await card.boundingBox())?.height ?? 0)).toBe(720);
  await page.waitForTimeout(400);

  // Drag the corner up and a little left: a real drag changes the width too,
  // which used to re-run the auto-grow and undo the shrink.
  const handle = page.getByTestId("note-resize");
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - 20, h.y + h.height / 2 - 400, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const box = (await card.boundingBox())!;
  expect(Math.round(box.height)).toBeLessThan(400);
  expect(Math.round(box.width)).toBeLessThan(480);
  await expect(page.locator(".error-banner")).toHaveCount(0);
});

test("a long image caption keeps the image visible and scrolls only while editing", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();
  await page.mouse.move(500, 380, { steps: 5 });
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const card = page.getByTestId("image-card");
  await expect(card).toHaveCount(1);
  const caption = page.getByTestId("image-caption");
  await caption.dblclick();
  await expect(card).toHaveAttribute("data-editing", "true");
  await pasteIntoEditor(page, paragraphs(30));

  const cardBox = (await card.boundingBox())!;
  // The caption takes at most half the card; the image keeps the rest.
  await expect.poll(async () => (await caption.boundingBox())!.height).toBeLessThanOrEqual(cardBox.height / 2 + 1);
  expect((await card.locator(".image-card__image").boundingBox())!.height).toBeGreaterThan(cardBox.height / 3);
  // Editing: the caption scrolls inside.
  expect(await caption.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await caption.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");

  // Idle: clipped with a fade, not scrollable.
  await page.mouse.click(1200, 650);
  await expect(card).toHaveAttribute("data-editing", "false");
  await expect(card.locator(".image-card__caption-fade")).toHaveCount(1);
  expect(await caption.evaluate((el) => getComputedStyle(el).overflowY)).toBe("clip");
});

test("a lost Ctrl keyup does not turn the wheel into zoom", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();
  for (let i = 0; i < 6; i++) await page.getByRole("button", { name: "New note" }).click();

  // A keydown with no matching keyup — what a focus change mid-Ctrl+V leaves.
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", code: "ControlLeft", bubbles: true })),
  );
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 400);

  await expect.poll(() => readTranslateY(page)).toBeLessThan(0);
  expect(await page.locator(".react-flow__viewport").getAttribute("style")).toContain("scale(1)");
});

test("the canvas is never a native scroller", async ({ page }) => {
  const card = await openNewNote(page);
  await pasteIntoEditor(page, paragraphs(40));
  // The note now reaches far below the window. Transformed descendants count
  // as scrollable overflow, so an `overflow: hidden` ancestor can be scrolled
  // by focus()/scrollIntoView(); React Flow answers on its wrapper with
  // scrollTo(0, 0) — the visible "spring back to the top".
  await expect.poll(async () => (await card.boundingBox())?.height ?? 0).toBeGreaterThan(700);
  const offsets = await page.evaluate(() =>
    [".workspace__canvas", ".canvas-surface", ".react-flow"].map((selector) => {
      const el = document.querySelector(selector)!;
      el.scrollTop = 300;
      return el.scrollTop;
    }),
  );
  expect(offsets).toEqual([0, 0, 0]);
});
