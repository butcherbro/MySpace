import type { Page } from "@playwright/test";
import { selectNotesOnly, waitForCanvasReady } from "./gestures";
import { expect, test } from "./fixtures";

// Группы (ADR-0013) против мока в памяти. Доска `?fixture=groups` — группа
// «Проект» (60,80 640×320) с заметками-членами A (100,150) и B (420,200) внутри
// и заметкой «Outside» (820,160) снаружи; все заметки 240×120. Состав хранится
// (`groupId`), рамка его не меняет — первые тесты проверяют именно это.

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

async function expectInside(page: Page, id: string, groupId: string) {
  const inner = await box(page, id);
  const outer = await box(page, groupId);
  expect(inner.x).toBeGreaterThanOrEqual(outer.x);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
}

// Дефект из проверки пользователя: рамка, поставленная на чужую заметку,
// затягивала её в группу.
test("a frame dropped over a foreign note does not capture it: the next frame drag leaves the note", async ({
  page,
}) => {
  await openFixture(page);
  const outside = await box(page, "group-note-outside");
  const frame = await box(page, "group-project");

  // «Проект» вправо на ~450 (первый из 10 шагов React Flow не засчитывает):
  // рамка 510..1150 накрывает «Outside» (820..1060 × 160..280) целиком.
  await drag(page, await groupBodyPoint(page), 500, 0);
  const moved = await frameDelta(page, frame);
  expect(moved.dx).toBeGreaterThan(400);
  // Проверка подготовки, а не исправления: сразу после броска заметка на месте
  // при любой реализации — рамку двигали, а не её.
  await expectInside(page, "group-note-outside", "group-project");
  await expectMovedBy(page, "group-note-outside", outside, 0, 0);

  // Это и есть проверка дефекта: при геометрическом составе заметка под рамкой
  // поехала бы с ней.
  const covering = await box(page, "group-project");
  const a = await box(page, "group-note-a");
  await drag(page, await groupBodyPoint(page), -200, 0);
  await expect.poll(async () => (await movedBy(page, "group-project", covering)).dx).toBeLessThan(-100);
  const back = await movedBy(page, "group-project", covering);
  await expectMovedBy(page, "group-note-a", a, back.dx, back.dy);
  await expectMovedBy(page, "group-note-outside", outside, 0, 0);
});

test("a selection of the frame and a foreign note under it moves both, but the note does not join", async ({
  page,
}) => {
  await openFixture(page);
  const frame = await box(page, "group-project");
  // Как в первом тесте: «Проект» вправо, рамка целиком накрывает «Outside».
  await drag(page, await groupBodyPoint(page), 500, 0);
  await frameDelta(page, frame);
  await expectInside(page, "group-note-outside", "group-project");

  // Рамка выделения от пустого места под рамкой до верхнего левого угла «Outside»:
  // задевает и рамку, и заметки.
  const covering = await box(page, "group-project");
  const outside = await box(page, "group-note-outside");
  await page.mouse.move(covering.x - 30, covering.y + covering.height + 40);
  await page.mouse.down();
  await page.mouse.move(outside.x + 20, outside.y + 20, { steps: 10 });
  await page.mouse.up();
  await expect(groupNode(page)).toHaveClass(/selected/);
  await expect(node(page, "group-note-outside")).toHaveClass(/selected/);
  await page.waitForTimeout(150);

  // Тащим выделение за «Outside»: едут все вместе.
  await drag(page, { x: outside.x + outside.width / 2, y: outside.y + outside.height - 16 }, 0, 100);
  await expect.poll(async () => (await box(page, "group-note-outside")).y - outside.y).toBeGreaterThan(60);
  await expect.poll(async () => (await box(page, "group-project")).y - covering.y).toBeGreaterThan(60);

  // Снять выделение кликом по пустому холсту и тащить рамку одну: «Outside» стоит.
  const shifted = await box(page, "group-project");
  await page.mouse.click(shifted.x - 30, shifted.y + shifted.height + 40);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  const outsideNow = await box(page, "group-note-outside");
  const a = await box(page, "group-note-a");
  await drag(page, await groupBodyPoint(page), -200, 0);
  await expect.poll(async () => (await movedBy(page, "group-project", shifted)).dx).toBeLessThan(-100);
  const back = await movedBy(page, "group-project", shifted);
  await expectMovedBy(page, "group-note-a", a, back.dx, back.dy);
  await expectMovedBy(page, "group-note-outside", outsideNow, 0, 0);
});

test("a note dropped inside the frame joins the group and moves with it", async ({ page }) => {
  await openFixture(page);
  const start = await box(page, "group-note-outside");
  // Влево на ~450: «Outside» встаёт на 370..610 × 160..280, целиком в рамке
  // (поверх B — перекрытие заметок членству не мешает).
  await drag(page, { x: start.x + start.width / 2, y: start.y + start.height / 2 }, -500, 0);
  await expect.poll(async () => (await box(page, "group-note-outside")).x - start.x).toBeLessThan(-400);
  await expectInside(page, "group-note-outside", "group-project");

  const joined = await box(page, "group-note-outside");
  const frame = await box(page, "group-project");
  await drag(page, await groupBodyPoint(page), 120, 80);

  const { dx, dy } = await frameDelta(page, frame);
  await expectMovedBy(page, "group-note-outside", joined, dx, dy);
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

test("membership survives a resize: a member left outside the shrunk frame still moves with it", async ({ page }) => {
  await openFixture(page);
  // Сужаем рамку на 300: правый край 700 → 400, и B (420..660) оказывается снаружи.
  const handle = await node(page, "group-project").getByTestId("group-resize").boundingBox();
  if (!handle) throw new Error("resize handle not visible");
  const before = await box(page, "group-project");
  await drag(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, -300, 0);
  await expect.poll(async () => (await box(page, "group-project")).width).toBeLessThan(before.width - 250);
  const shrunk = await box(page, "group-project");
  const b = await box(page, "group-note-b");
  expect(b.x).toBeGreaterThan(shrunk.x + shrunk.width);

  await drag(page, await groupBodyPoint(page), 120, 80);
  const { dx, dy } = await frameDelta(page, shrunk);
  await expectMovedBy(page, "group-note-b", b, dx, dy);
});

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

test("Cmd+G on a note inside «Проект» nests the new frame: dragging «Проект» moves it and the notes", async ({
  page,
}) => {
  await openFixture(page);
  // Клик открывает редактор A, Escape закрывает его, выделение остаётся.
  // Выделить две заметки внутри рамки синтетическим жестом нельзя: рамка
  // выделения не начинается внутри группы, а Cmd+клик React Flow в headless
  // Chromium не засчитывает (проверено) — группируем одну A.
  const aStart = await box(page, "group-note-a");
  await page.mouse.click(aStart.x + aStart.width / 2, aStart.y + aStart.height - 16);
  await page.keyboard.press("Escape");
  await expect(node(page, "group-note-a")).toHaveClass(/selected/);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+g");
  await expect(page.getByTestId("group-card")).toHaveCount(2);

  const inner = page.locator('.react-flow__node:not([data-id="group-project"]) [data-testid=group-card]');
  const innerBefore = await inner.boundingBox();
  if (!innerBefore) throw new Error("new group not visible");
  const a = await box(page, "group-note-a");
  const b = await box(page, "group-note-b");
  const frame = await box(page, "group-project");
  // Снять выделение: иначе жест потащил бы и выделенные карточки.
  await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height + 60);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  await drag(page, await groupBodyPoint(page), 120, 80);

  const { dx, dy } = await frameDelta(page, frame);
  await expectMovedBy(page, "group-note-a", a, dx, dy);
  await expectMovedBy(page, "group-note-b", b, dx, dy);
  await expect
    .poll(async () => {
      const now = await inner.boundingBox();
      return now && { dx: Math.round(now.x - innerBefore.x), dy: Math.round(now.y - innerBefore.y) };
    })
    .toEqual({ dx, dy });
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
