import type { Page } from "@playwright/test";
import { waitForCanvasReady } from "./gestures";
import { expect, test } from "./fixtures";

// Связи (стрелки между карточками) против мока в памяти. Доска
// `?fixture=connectors` — заметки A и B и одна стрелка A → B.

const nodeA = (page: Page) => page.locator('.react-flow__node[data-id="connector-note-a"]');
const nodeB = (page: Page) => page.locator('.react-flow__node[data-id="connector-note-b"]');

async function openFixture(page: Page) {
  await page.goto("/?fixture=connectors");
  await waitForCanvasReady(page);
  await expect(page.getByTestId("connector")).toHaveCount(1);
}

/** Наводит на заметку A и мелкими шагами тянет её угловую ручку в `(x, y)`. */
async function dragHandleFromA(page: Page, x: number, y: number) {
  await nodeA(page).hover();
  const handle = nodeA(page).getByTestId("connector-handle");
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  if (!box) throw new Error("connector handle not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
}

test("the connectors fixture shows one arrow from note A to note B", async ({ page }) => {
  await openFixture(page);
  const connector = page.getByTestId("connector");
  await expect(connector).toHaveAttribute("data-color-token", "default");
  await expect(connector).toHaveAttribute("data-arrow-ends", "end");
});

test("dragging the corner handle of one note onto another draws a new arrow", async ({ page }) => {
  await openFixture(page);
  const target = await nodeB(page).boundingBox();
  if (!target) throw new Error("note B not visible");

  await dragHandleFromA(page, target.x + target.width / 2, target.y + target.height / 2);

  await expect(page.getByTestId("connector")).toHaveCount(2);
});

test("releasing the handle over empty canvas draws nothing", async ({ page }) => {
  await openFixture(page);
  const source = await nodeA(page).boundingBox();
  if (!source) throw new Error("note A not visible");

  await dragHandleFromA(page, source.x + source.width / 2, source.y + source.height + 220);
  // Даём шанс ошибочному созданию дойти до холста, прежде чем считать.
  await page.waitForTimeout(200);

  await expect(page.getByTestId("connector")).toHaveCount(1);
});

test("a clicked arrow is deleted with Delete and comes back with undo", async ({ page }) => {
  await openFixture(page);

  await page.getByTestId("connector").click();
  await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("connector")).toHaveCount(0);
  // Карточки при этом не тронуты.
  await expect(page.getByTestId("note-card")).toHaveCount(2);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("connector")).toHaveCount(1);
});

test("the arrow's context menu changes its colour", async ({ page }) => {
  await openFixture(page);

  await page.getByTestId("connector").click({ button: "right" });
  const menu = page.getByTestId("connector-context-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: "Blue", exact: true }).click();

  await expect(page.getByTestId("connector")).toHaveAttribute("data-color-token", "blue");
});
