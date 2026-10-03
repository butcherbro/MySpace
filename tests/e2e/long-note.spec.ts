import { expect, test, type Page } from "./fixtures";

// Long text in a note (user report 2026-10-03, Windows): a narrow "till
// receipt" note, a scroll that springs back to the top, and — past the
// backend's 10 000px frame limit — a note that vanished mid-scroll because
// the rejected auto-grow left the store's height behind the DOM's.

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
  await pasteIntoEditor(page, paragraphs(12));

  await expect.poll(async () => (await card.boundingBox())?.width).toBe(480);
  // Grown to the content: nothing left to scroll inside the card.
  await expect
    .poll(() => card.evaluate((el) => el.scrollHeight - el.clientHeight))
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
  }, paragraphs(12));

  const card = page.getByTestId("note-card");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-editing", "false");
  await expect.poll(async () => (await card.boundingBox())?.width).toBe(480);
  await expect
    .poll(() => card.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeLessThanOrEqual(0);
});

test("a note taller than the frame limit caps at it and stays on the canvas while scrolling", async ({ page }) => {
  const card = await openNewNote(page);
  await pasteIntoEditor(page, paragraphs(220));

  await expect.poll(async () => Math.round((await card.boundingBox())?.height ?? 0)).toBe(10000);
  await page.waitForTimeout(400); // past the auto-grow write debounce
  await expect(page.locator(".error-banner")).toHaveCount(0);

  await page.mouse.click(1100, 600); // leave edit mode
  await expect(card).toHaveAttribute("data-editing", "false");
  await page.mouse.move(600, 500);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 400);
  await expect.poll(() => readTranslateY(page)).toBeLessThan(-2000);
  // Culling works from the store's frame; it must match the DOM card.
  await expect(card).toHaveCount(1);
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
  await expect.poll(async () => (await card.boundingBox())?.height ?? 0).toBeGreaterThan(2000);
  const offsets = await page.evaluate(() =>
    [".workspace__canvas", ".canvas-surface", ".react-flow"].map((selector) => {
      const el = document.querySelector(selector)!;
      el.scrollTop = 300;
      return el.scrollTop;
    }),
  );
  expect(offsets).toEqual([0, 0, 0]);
});
