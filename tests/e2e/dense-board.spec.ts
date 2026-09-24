import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

// P1.8 budget: a board of 1 000 note cards must paint fast and pan smoothly.
//
// Seeded through the in-memory mock gateway's test-only dense fixture
// (`?fixture=dense&notes=N`, src/test/dense-board-fixture.ts) — never real data.
//
// Budgets are wall-clock and therefore machine-dependent. The plan's target is
// 500 ms first paint on the developer Mac (packaged build); this harness runs
// the unbundled Vite dev server in a shared Linux container/CI runner, so the
// defaults are generous and can be tightened per machine:
//   DENSE_BOARD_PAINT_BUDGET_MS (default 1500)
//   DENSE_BOARD_PAN_BUDGET_MS   (default 200)
const NOTE_COUNT = 1000;
const PAINT_BUDGET_MS = Number(process.env.DENSE_BOARD_PAINT_BUDGET_MS ?? 1500);
const PAN_BUDGET_MS = Number(process.env.DENSE_BOARD_PAN_BUDGET_MS ?? 200);

// Mirrors the fixture's grid (DENSE_NOTE_COLUMNS / DENSE_NOTE_PITCH, 240x120 cards at 40,40).
const GRID = { columns: 40, originX: 40, originY: 40, pitchX: 260, pitchY: 140, width: 240, height: 120 };

test.use({ viewport: { width: 1440, height: 900 } });

declare global {
  interface Window {
    __denseBoard?: { surfaceAt: number | null; paintedAt: number | null; expected: number };
  }
}

/** How many fixture notes intersect a pane of the given size at pan (0,0), zoom 1. */
function expectedVisibleNotes(paneWidth: number, paneHeight: number): number {
  let count = 0;
  for (let i = 0; i < NOTE_COUNT; i += 1) {
    const x = GRID.originX + (i % GRID.columns) * GRID.pitchX;
    const y = GRID.originY + Math.floor(i / GRID.columns) * GRID.pitchY;
    if (x < paneWidth && y < paneHeight && x + GRID.width > 0 && y + GRID.height > 0) count += 1;
  }
  return count;
}

/** Notes whose rendered static content intersects the canvas pane right now. */
async function paintedVisibleNotes(page: Page): Promise<number> {
  return page.evaluate(() => {
    const pane = document.querySelector('[data-testid="canvas-surface"]')!.getBoundingClientRect();
    let n = 0;
    for (const el of document.querySelectorAll(".react-flow__node .note-card")) {
      if (!el.querySelector("[data-static-document] strong")) continue;
      const r = el.getBoundingClientRect();
      if (r.right > pane.left && r.left < pane.right && r.bottom > pane.top && r.top < pane.bottom && r.width > 0) n += 1;
    }
    return n;
  });
}

test("a 1 000-note board paints within budget and culls off-screen cards", async ({ page }) => {
  // Warm-up load: the first request makes Vite transform every module; that
  // one-off dev-server cost is not what this budget measures.
  await page.goto(`/?fixture=dense&notes=${NOTE_COUNT}`);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();

  const pane = await page.getByTestId("canvas").boundingBox();
  if (!pane) throw new Error("canvas not laid out");
  const expected = expectedVisibleNotes(pane.width, pane.height);
  expect(expected).toBeGreaterThan(10);

  // Probe installed before any app script runs: it timestamps the moment the
  // canvas mounts (board still loading) and the first frame on which every
  // note intersecting the pane shows its rendered content.
  await page.addInitScript((expectedCount: number) => {
    window.__denseBoard = { surfaceAt: null, paintedAt: null, expected: expectedCount };
    const tick = () => {
      const probe = window.__denseBoard!;
      const surface = document.querySelector('[data-testid="canvas-surface"]');
      if (surface && probe.surfaceAt === null) probe.surfaceAt = performance.now();
      if (surface && probe.paintedAt === null) {
        const paneRect = surface.getBoundingClientRect();
        let n = 0;
        for (const el of document.querySelectorAll(".react-flow__node .note-card")) {
          if (!el.querySelector("[data-static-document] strong")) continue;
          const r = el.getBoundingClientRect();
          if (r.right > paneRect.left && r.left < paneRect.right && r.bottom > paneRect.top && r.top < paneRect.bottom && r.width > 0) n += 1;
        }
        if (n >= probe.expected) probe.paintedAt = performance.now();
      }
      if (probe.paintedAt === null) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, expected);

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__denseBoard?.paintedAt ?? null), { timeout: 30_000 }).not.toBeNull();
  const timing = await page.evaluate(() => window.__denseBoard!);
  const paintMs = timing.paintedAt! - timing.surfaceAt!;
  const sinceNavigationMs = timing.paintedAt!;
  console.log(
    `[P1.8] dense board: ${expected} visible of ${NOTE_COUNT} notes painted ${paintMs.toFixed(0)} ms after canvas mount ` +
      `(${sinceNavigationMs.toFixed(0)} ms after navigation start; budget ${PAINT_BUDGET_MS} ms)`,
  );
  expect(paintMs).toBeLessThan(PAINT_BUDGET_MS);

  // No card mounted an editor: idle notes are static HTML (one editor at most, for editing).
  await expect(page.locator(".note-card .ProseMirror[contenteditable]")).toHaveCount(0);

  // `onlyRenderVisibleElements`: after the initial measure pass React Flow
  // unmounts cards outside the viewport.
  await expect.poll(() => page.locator(".react-flow__node").count()).toBeLessThan(NOTE_COUNT / 4);
  expect(await paintedVisibleNotes(page)).toBeGreaterThanOrEqual(expected);
});

test("panning across a 1 000-note board stays responsive", async ({ page }) => {
  await page.goto(`/?fixture=dense&notes=${NOTE_COUNT}`);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await expect.poll(() => page.locator(".react-flow__node").count()).toBeLessThan(NOTE_COUNT / 4);

  const samples: number[] = [];
  // Pan right and down across the board in several gestures. Each sample is
  // the time from dispatching the wheel gesture to the frame after the one on
  // which the viewport transform changed.
  for (const [dx, dy] of [[900, 0], [900, 300], [900, 300], [0, 600], [-600, 300]]) {
    const elapsed = await page.evaluate(
      ([deltaX, deltaY]) =>
        new Promise<number>((resolve, reject) => {
          const viewport = document.querySelector<HTMLElement>(".react-flow__viewport")!;
          const pane = document.querySelector<HTMLElement>(".react-flow__pane")!;
          const before = viewport.style.transform;
          const rect = pane.getBoundingClientRect();
          const start = performance.now();
          pane.dispatchEvent(
            new WheelEvent("wheel", {
              deltaX,
              deltaY,
              deltaMode: 0,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2,
              bubbles: true,
              cancelable: true,
            }),
          );
          // Resolve on the frame *after* the transform changed, so the sample
          // includes React Flow's re-render and the browser's paint.
          const check = () => {
            if (viewport.style.transform !== before) {
              requestAnimationFrame(() => resolve(performance.now() - start));
              return;
            }
            if (performance.now() - start > 5000) return reject(new Error("viewport never moved"));
            requestAnimationFrame(check);
          };
          check();
        }),
      [dx, dy] as const,
    );
    samples.push(elapsed);
    // The newly exposed region fills in with rendered cards.
    await expect.poll(() => paintedVisibleNotes(page)).toBeGreaterThan(10);
  }

  console.log(
    `[P1.8] dense board pan: ${samples.map((s) => s.toFixed(0)).join(", ")} ms per gesture (budget ${PAN_BUDGET_MS} ms)`,
  );
  expect(Math.max(...samples)).toBeLessThan(PAN_BUDGET_MS);
  // Culling still holds after panning.
  expect(await page.locator(".react-flow__node").count()).toBeLessThan(NOTE_COUNT / 4);
});

test("group drag moves selected cards that are off-screen (culled) too", async ({ page }) => {
  await page.goto(`/?fixture=dense&notes=${NOTE_COUNT}`);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await expect.poll(() => page.locator(".react-flow__node").count()).toBeLessThan(NOTE_COUNT / 4);
  // dense-note-46 sits at column 6 (x = 1600): outside the 1344 px pane, so unmounted.
  const offscreen = page.locator('.react-flow__node[data-id="dense-note-46"]');
  await expect(offscreen).toHaveCount(0);

  await page.getByTestId("canvas-surface").focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect.poll(() => page.locator(".react-flow__node.selected").count()).toBeGreaterThan(10);

  const box = await page.locator('.react-flow__node[data-id="dense-note-0"]').boundingBox();
  if (!box) throw new Error("note 0 not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  const translate = (transform: string) => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(transform);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  };
  const anchor = page.locator('.react-flow__node[data-id="dense-note-0"]');
  // Wait for the drop to land (the drag threshold eats a few pixels of the gesture).
  await expect.poll(async () => translate(await anchor.evaluate((el) => (el as HTMLElement).style.transform))?.x ?? 40).toBeGreaterThan(60);
  const moved = translate(await anchor.evaluate((el) => (el as HTMLElement).style.transform))!;
  const delta = { x: moved.x - 40, y: moved.y - 40 };

  // Pan right so the culled card mounts, then read where it was rendered.
  await page.mouse.move(700, 400);
  // (React Flow's panOnScroll speed is 0.5: a 1600 px wheel pans 800 px.)
  await page.mouse.wheel(1600, 0);
  await expect(offscreen).toHaveCount(1);
  // It moved by exactly the same delta as the card under the pointer.
  await expect
    .poll(async () => translate(await offscreen.evaluate((el) => (el as HTMLElement).style.transform)))
    .toEqual({ x: 1600 + delta.x, y: 180 + delta.y });
});

test("clicking an idle note places the caret where the click landed", async ({ page }) => {
  await page.goto("/?fixture=dense&notes=4");
  const note = page.locator('.react-flow__node[data-id="dense-note-1"] .note-card');
  await expect(note.locator("[data-static-document]")).toHaveText("Note 1: a short line of text");

  // Click in the middle of the line — right after the bold "Note 1" — on the
  // static (editor-free) view. The editor mounts only after this click, so
  // without forwarding the click point the caret would land at a document
  // edge instead.
  const end = await note.locator("[data-static-document] strong").evaluate((strong) => {
    const rect = strong.getBoundingClientRect();
    return { x: rect.right - 1, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(end.x, end.y);
  await expect(note.locator('[contenteditable="true"]')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("contenteditable"))).toBe("true");
  await page.keyboard.type("!");

  // Leave editing; the static view shows the edit at the clicked position.
  await page.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
  await expect(note.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(note.locator("[data-static-document]")).toHaveText("Note 1!: a short line of text");
});
