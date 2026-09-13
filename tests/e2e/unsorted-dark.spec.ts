import { expect, test } from "./fixtures";

test.use({ colorScheme: "dark" });

test("unsorted panel visible in dark mode", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.locator(".board-portal-card__tile").dblclick({ force: true });
  await expect(page.getByTestId("board-tab")).toHaveCount(2);
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();

  await page.getByRole("button", { name: "New note", exact: true }).click();
  const noteCenter = await page.evaluate(() => {
    const el = document.querySelector(".note-card")!;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const portal = await page.locator(".board-portal-card__tile").boundingBox();
  if (!portal) return;
  await page.mouse.move(noteCenter.x, noteCenter.y);
  await page.mouse.down();
  await page.mouse.move(portal.x + portal.width / 2, portal.y + portal.height / 2, { steps: 8 });
  await page.mouse.up();

  await page.locator(".board-portal-card__tile").dblclick({ force: true });
  await expect(page.getByTestId("unsorted-panel")).toBeVisible();
  await expect(page.getByTestId("unsorted-card")).toHaveCount(1);
  await expect(page.getByText("Unsorted")).toBeVisible();
});