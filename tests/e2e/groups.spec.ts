import type { Page } from "@playwright/test";
import { selectNotesOnly, waitForCanvasReady } from "./gestures";
import { expect, test } from "./fixtures";

// Группы (ADR-0013) против мока в памяти. Доска `?fixture=groups` — группа
// «Проект» (60,80 640×320) с заметками A и B внутри и одной заметкой снаружи.

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const groupNode = (page: Page) => node(page, "group-project");

async function openFixture(page: Page) {
  await page.goto("/?fixture=groups");
  await waitForCanvasReady(page);
  await expect(page.getByTestId("group-card")).toHaveCount(1);
  await expect(page.getByTestId("note-card")).toHaveCount(3);
}

async function box(page: Page, id: string) {
  const b = await node(page, id).boundingBox();
  if (!b) throw new Error(`${id} not visible`);
  return b;
}

/** Точка на пустом месте рамки группы: внизу слева, мимо заметок и ручки размера. */
async function groupBodyPoint(page: Page) {
  const b = await box(page, "group-project");
  return { x: b.x + 24, y: b.y + b.height - 30 };
}

/** Пустое место у верхнего края рамки: меню, открытое здесь, целиком влезает в окно. */
async function groupTopPoint(page: Page) {
  const b = await box(page, "group-project");
  return { x: b.x + 20, y: b.y + 20 };
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 10 });
  await page.mouse.up();
}

async function movedBy(page: Page, id: string, before: { x: number; y: number }) {
  const after = await box(page, id);
  return { dx: Math.round(after.x - before.x), dy: Math.round(after.y - before.y) };
}

// React Flow начинает перетаскивание только с первого шага указателя, и этот
// шаг в смещение не входит, поэтому сверяем не с заданными (120, 80), а с тем,
// на сколько на самом деле уехала рамка.
async function expectMovedBy(page: Page, id: string, before: { x: number; y: number }, dx: number, dy: number) {
  await expect.poll(() => movedBy(page, id, before)).toEqual({ dx, dy });
}

async function frameDelta(page: Page, before: { x: number; y: number }) {
  await expect.poll(async () => (await movedBy(page, "group-project", before)).dx).toBeGreaterThan(60);
  return movedBy(page, "group-project", before);
}

test("the groups fixture shows a frame titled «Проект»", async ({ page }) => {
  await openFixture(page);
  await expect(page.getByTestId("group-title")).toHaveText("Проект");
});

test("Group in the context menu frames the selected notes", async ({ page }) => {
  await page.goto("/");
  await waitForCanvasReady(page);
  for (let index = 0; index < 2; index += 1) {
    await page.getByRole("button", { name: "New note", exact: true }).click();
  }
  await expect(page.getByTestId("note-card")).toHaveCount(2);
  await selectNotesOnly(page, 2);

  // После рамки выделения правый клик принимает её оверлей React Flow.
  await page.locator(".react-flow__nodesselection-rect").click({ button: "right" });
  await page.getByTestId("context-menu").getByRole("button", { name: "Group", exact: true }).click();

  await expect(page.getByTestId("group-card")).toHaveCount(1);
  await expect(page.getByTestId("group-title")).toHaveText("Группа без названия");
  const frame = await page.getByTestId("group-card").boundingBox();
  if (!frame) throw new Error("group not visible");
  for (const note of await page.locator(".note-card").all()) {
    const b = await note.boundingBox();
    if (!b) throw new Error("note not visible");
    expect(b.x).toBeGreaterThanOrEqual(frame.x);
    expect(b.y).toBeGreaterThanOrEqual(frame.y);
    expect(b.x + b.width).toBeLessThanOrEqual(frame.x + frame.width);
    expect(b.y + b.height).toBeLessThanOrEqual(frame.y + frame.height);
  }
});

test("dragging the frame moves the notes inside by the same delta and leaves the outside note", async ({ page }) => {
  await openFixture(page);
  const a = await box(page, "group-note-a");
  const b = await box(page, "group-note-b");
  const outside = await box(page, "group-note-outside");
  const frame = await box(page, "group-project");

  await drag(page, await groupBodyPoint(page), 120, 80);

  const { dx, dy } = await frameDelta(page, frame);
  expect(dy).toBeGreaterThan(40);
  await expectMovedBy(page, "group-note-a", a, dx, dy);
  await expectMovedBy(page, "group-note-b", b, dx, dy);
  await expectMovedBy(page, "group-note-outside", outside, 0, 0);
});

test("a note dragged out of the frame stays behind when the group moves", async ({ page }) => {
  await openFixture(page);
  const a = await box(page, "group-note-a");
  // Вниз: заметка A (y 150–270) уходит за нижний край рамки (y 400).
  await drag(page, { x: a.x + a.width / 2, y: a.y + a.height / 2 }, 0, 340);
  const frame = await box(page, "group-project");
  await expect.poll(async () => (await box(page, "group-note-a")).y).toBeGreaterThan(frame.y + frame.height);

  const leftOut = await box(page, "group-note-a");
  const b = await box(page, "group-note-b");
  await drag(page, await groupBodyPoint(page), 120, 80);

  const { dx, dy } = await frameDelta(page, frame);
  await expectMovedBy(page, "group-note-b", b, dx, dy);
  await expectMovedBy(page, "group-note-a", leftOut, 0, 0);
});

test("Ungroup removes only the frame; the notes stay where they were", async ({ page }) => {
  await openFixture(page);
  const a = await box(page, "group-note-a");
  const b = await box(page, "group-note-b");

  const point = await groupTopPoint(page);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.getByTestId("context-menu").getByRole("button", { name: "Ungroup", exact: true }).click();

  await expect(page.getByTestId("group-card")).toHaveCount(0);
  await expect(page.getByTestId("note-card")).toHaveCount(3);
  await expectMovedBy(page, "group-note-a", a, 0, 0);
  await expectMovedBy(page, "group-note-b", b, 0, 0);
});

test("double-clicking the chip renames the group", async ({ page }) => {
  await openFixture(page);
  await page.getByTestId("group-title").dblclick();
  const input = page.getByTestId("group-title-input");
  await expect(input).toBeFocused();
  await input.fill("Идеи");
  await input.press("Enter");

  await expect(page.getByTestId("group-title")).toHaveText("Идеи");
});

test("a note inside the frame still opens for editing on click", async ({ page }) => {
  await openFixture(page);
  await groupNode(page).waitFor();
  await node(page, "group-note-a").getByTestId("note-card").click();
  await expect(node(page, "group-note-a").getByTestId("note-card")).toHaveAttribute("data-editing", "true");
});

test("an arrow can be drawn from a note to the group frame", async ({ page }) => {
  await openFixture(page);
  const outside = node(page, "group-note-outside");
  await outside.hover();
  const handle = outside.getByTestId("connector-handle");
  await expect(handle).toBeVisible();
  const h = await handle.boundingBox();
  if (!h) throw new Error("connector handle not visible");
  const target = await groupBodyPoint(page);

  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.mouse.up();

  await expect(page.getByTestId("connector")).toHaveCount(1);
});

test("a marquee started outside the frame selects the frame and the notes it crosses", async ({ page }) => {
  await openFixture(page);
  const frame = await box(page, "group-project");
  await page.mouse.move(frame.x + frame.width + 40, frame.y + frame.height + 40);
  await page.mouse.down();
  await page.mouse.move(frame.x + 150, frame.y + 100, { steps: 10 });
  await page.mouse.up();

  await expect(page.locator(".react-flow__node.selected")).toHaveCount(3);
  await expect(groupNode(page)).toHaveClass(/selected/);
  await expect(node(page, "group-note-outside")).not.toHaveClass(/selected/);
});
