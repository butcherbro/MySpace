import { expect, test } from "@playwright/test";

// Dense-board visual acceptance: lock the Quiet Desk shell geometry and prove all
// object classes render together and stay scannable. Uses the test-only dense
// fixture via `?fixture=dense` (never seeds real data).

test.use({ viewport: { width: 1512, height: 982 } });

test("the dense shell keeps chrome fixed and renders every object class", async ({ page }) => {
  await page.goto("/?fixture=dense");

  // Top bar and left rail geometry are stable.
  const titleBar = await page.getByTestId("title-bar-region").boundingBox();
  const rail = await page.getByTestId("tool-rail-region").boundingBox();
  expect(titleBar).not.toBeNull();
  expect(rail).not.toBeNull();
  if (titleBar && rail) {
    expect(Math.round(titleBar.height)).toBe(44);
    expect(Math.round(rail.width)).toBe(56);
  }

  // No creation controls in the top bar (they live in the rail).
  await expect(page.getByTestId("top-bar-region")).not.toContainText("New note");

  // Home is a clickable breadcrumb.
  await expect(page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" })).toBeVisible();

  // All four object classes render on the dense board.
  await expect(page.getByTestId("board-portal-card")).toHaveCount(12);
  await expect(page.getByTestId("note-card")).toHaveCount(2);
  await expect(page.getByTestId("image-card")).toHaveCount(2);
  await expect(page.getByTestId("link-card")).toHaveCount(2);
});

test("context menu stays within the viewport on a dense board", async ({ page }) => {
  await page.goto("/?fixture=dense");

  const note = page.getByTestId("note-card").first();
  await expect(note).toBeVisible();
  const box = await note.boundingBox();
  if (!box) throw new Error("note not visible");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });

  const menu = await page.getByTestId("context-menu").boundingBox();
  expect(menu).not.toBeNull();
  const viewport = page.viewportSize();
  if (menu && viewport) {
    expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width);
    expect(menu.y + menu.height).toBeLessThanOrEqual(viewport.height);
  }
});