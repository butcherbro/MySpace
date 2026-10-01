import { expect } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Wait until React Flow has initialised the canvas. Before that, a board
 * created from the rail lands on a fallback position right across the notes
 * the button cascades, so any layout-dependent gesture starts from a
 * timing-dependent layout.
 */
export async function waitForCanvasReady(page: Page): Promise<void> {
  await expect(page.getByTestId("canvas")).toHaveAttribute("data-flow-ready", "true");
}

/**
 * Marquee-select exactly the note cards, leaving a board portal on the canvas
 * untouched — which matters because a selection containing the destination
 * board's own portal is refused whole (ADR-0007).
 *
 * Precondition: the notes share a left edge (the "New note" button cascades
 * them straight down) and no other card overlaps that edge. The marquee is a
 * narrow strip over those left edges, because selection is partial
 * (SelectionMode.Partial) and a box around the notes would also catch a
 * portal lying across them. Notes with different left edges are not all
 * reached, and the count check below fails loudly rather than flaking.
 *
 * The gesture is left to settle before returning: a node drag started on the
 * very next frame after a marquee occasionally never engages, and the cards then
 * simply stay where they were. A human's rhythm has that gap naturally; a
 * synthetic gesture has to be given it.
 */
export async function selectNotesOnly(page: Page, count: number): Promise<void> {
  const boxes = [];
  for (let index = 0; index < count; index += 1) {
    const box = await page.locator(".note-card").nth(index).boundingBox();
    if (!box) throw new Error("note not visible");
    boxes.push(box);
  }
  const left = Math.min(...boxes.map((b) => b.x)) - 12;
  const top = Math.min(...boxes.map((b) => b.y)) - 12;
  const right = Math.min(...boxes.map((b) => b.x)) + 24;
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 12;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(right, bottom, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(count);
  await page.waitForTimeout(150);
}
