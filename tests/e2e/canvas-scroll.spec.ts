import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

// Milanote-style navigation: content-aware overlay scrollbars and Space+drag pan.
// Seeded through the test-only dense fixture (`?fixture=dense&notes=N`,
// src/test/dense-board-fixture.ts): notes in a 40-column grid of 240x120 cards
// at a 260x140 pitch from (40,40) — 1 000 notes reach far past the viewport on
// both axes.

test.use({ viewport: { width: 1440, height: 900 } });

async function readViewport(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  const style = (await page.locator(".react-flow__viewport").getAttribute("style")) ?? "";
  const t = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(style);
  const s = /scale\((-?[\d.]+)\)/.exec(style);
  return { x: t ? Number(t[1]) : 0, y: t ? Number(t[2]) : 0, zoom: s ? Number(s[1]) : 1 };
}

async function nodeTranslate(page: Page, id: string): Promise<{ x: number; y: number } | null> {
  const transform = await page
    .locator(`.react-flow__node[data-id="${id}"]`)
    .evaluate((el) => (el as HTMLElement).style.transform);
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(transform);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

test("scrollbars show only while content is off-screen and disappear once everything fits", async ({ page }) => {
  await page.goto("/?fixture=dense&notes=1000");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();

  const horizontal = page.getByTestId("canvas-scrollbar-horizontal");
  const vertical = page.getByTestId("canvas-scrollbar-vertical");
  await expect(horizontal).toHaveCount(1);
  await expect(vertical).toHaveCount(1);

  // The bars belong to the canvas: they never reach over the right rail.
  const canvas = (await page.getByTestId("canvas-surface").boundingBox())!;
  const hBox = (await horizontal.boundingBox())!;
  const vBox = (await vertical.boundingBox())!;
  expect(hBox.x + hBox.width).toBeLessThanOrEqual(canvas.x + canvas.width + 0.5);
  expect(vBox.x + vBox.width).toBeLessThanOrEqual(canvas.x + canvas.width + 0.5);
  expect(hBox.y + hBox.height).toBeLessThanOrEqual(canvas.y + canvas.height + 0.5);

  // Ctrl+wheel (pinch-zoom path) out to the minimum zoom: the whole grid fits.
  await page.mouse.move(canvas.x + 200, canvas.y + 200);
  await page.keyboard.down("Control");
  for (let i = 0; i < 20 && (await readViewport(page)).zoom > 0.11; i += 1) {
    await page.mouse.wheel(0, 400);
  }
  await page.keyboard.up("Control");
  await expect.poll(async () => (await readViewport(page)).zoom).toBeLessThan(0.13);
  await expect(horizontal).toHaveCount(0);
  await expect(vertical).toHaveCount(0);
});

test("dragging the horizontal thumb pans the board; a wheel over the bar still pans", async ({ page }) => {
  await page.goto("/?fixture=dense&notes=1000");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();

  const thumb = page.getByTestId("canvas-scrollbar-horizontal-thumb");
  await expect(thumb).toHaveCount(1);
  const before = await readViewport(page);
  expect(before.x).toBe(0);

  const box = (await thumb.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId("canvas-scrollbar-horizontal")).toHaveAttribute("data-active", "true");
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  const after = await readViewport(page);
  expect(after.x).toBeLessThan(-200); // the thumb moves a scaled-down copy of the board
  expect(after.y).toBe(before.y);
  expect(after.zoom).toBe(before.zoom);
  // The thumb followed.
  const moved = (await thumb.boundingBox())!;
  expect(moved.x).toBeGreaterThan(box.x + 150);

  // Wheel over the vertical strip is forwarded to the pane (panOnScroll).
  const vBox = (await page.getByTestId("canvas-scrollbar-vertical").boundingBox())!;
  await page.mouse.move(vBox.x + vBox.width / 2, vBox.y + vBox.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(async () => (await readViewport(page)).y).toBeLessThan(-50);
});

test("Space + left-drag pans the board, even over a card, without moving the card", async ({ page }) => {
  await page.goto("/?fixture=dense&notes=200");
  // dense-note-2 sits at (560, 40): still on screen after the pan below.
  const card = page.locator('.react-flow__node[data-id="dense-note-2"]');
  await expect(card).toBeVisible();
  await page.getByTestId("canvas-surface").focus();

  const box = (await card.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await page.keyboard.down("Space");
  await expect(page.getByTestId("canvas-surface")).toHaveAttribute("data-space-pan", "true");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 300, start.y - 100, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect(page.getByTestId("canvas-surface")).not.toHaveAttribute("data-space-pan", "true");

  const vp = await readViewport(page);
  expect(vp.x).toBeCloseTo(-300, 0);
  expect(vp.y).toBeCloseTo(-100, 0);
  // The card kept its board position and nothing was selected by a marquee.
  expect(await nodeTranslate(page, "dense-note-2")).toEqual({ x: 560, y: 40 });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);

  // The same gesture starting on empty pane pans too. Board point (810, 450)
  // lies in the gutter between columns 2/3 and rows 2/3 of the fixture grid.
  const pane = (await page.getByTestId("canvas-surface").boundingBox())!;
  const emptyPoint = async () => {
    const v = await readViewport(page);
    return { x: pane.x + 810 * v.zoom + v.x, y: pane.y + 450 * v.zoom + v.y };
  };
  const before = await readViewport(page);
  const gap = await emptyPoint();
  await page.keyboard.down("Space");
  await page.mouse.move(gap.x, gap.y);
  await page.mouse.down();
  await page.mouse.move(gap.x - 150, gap.y - 50, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  const after = await readViewport(page);
  expect(after.x - before.x).toBeCloseTo(-150, 0);
  expect(after.y - before.y).toBeCloseTo(-50, 0);
  await expect(page.locator(".react-flow__selection")).toHaveCount(0);

  // Without Space, a left-drag on the pane is a marquee again, not a pan.
  const gap2 = await emptyPoint();
  await page.mouse.move(gap2.x, gap2.y);
  await page.mouse.down();
  await page.mouse.move(gap2.x + 5, gap2.y + 5, { steps: 4 });
  await expect(page.locator(".react-flow__selection")).toHaveCount(1);
  await page.mouse.up();
  expect(await readViewport(page)).toEqual(after);
});

test("Space typed inside a note being edited inserts a space and never pans", async ({ page }) => {
  await page.goto("/?fixture=dense&notes=4");
  const note = page.locator('.react-flow__node[data-id="dense-note-1"] .note-card');
  await expect(note.locator("[data-static-document]")).toHaveText("Note 1: a short line of text");

  const end = await note.locator("[data-static-document] strong").evaluate((strong) => {
    const rect = strong.getBoundingClientRect();
    return { x: rect.right - 1, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(end.x, end.y);
  await expect(note.locator('[contenteditable="true"]')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("contenteditable"))).toBe("true");

  await page.keyboard.press("Space");
  await page.keyboard.type("x");
  await expect(page.getByTestId("canvas-surface")).not.toHaveAttribute("data-space-pan", "true");
  await expect(note.locator('[contenteditable="true"]')).toHaveText("Note 1 x: a short line of text");

  // Holding Space while editing and dragging does not pan either.
  await page.keyboard.down("Space");
  await expect(page.getByTestId("canvas-surface")).not.toHaveAttribute("data-space-pan", "true");
  await page.keyboard.up("Space");
  expect(await readViewport(page)).toEqual({ x: 0, y: 0, zoom: 1 });
});
