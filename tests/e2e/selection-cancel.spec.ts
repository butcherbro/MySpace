import { expect, test } from "@playwright/test";

async function beginMarquee(page: import("@playwright/test").Page) {
  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  if (!box) throw new Error("React Flow pane is not visible");

  await page.mouse.move(box.x + 180, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 520, box.y + 420, { steps: 6 });
  await expect(page.locator(".react-flow__selection")).toBeVisible();
}

test("an interrupted marquee never remains painted over the board", async ({ page }) => {
  await page.goto("/");

  await beginMarquee(page);
  await page.locator(".react-flow__pane").dispatchEvent("pointercancel", {
    button: 0,
    buttons: 0,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
  });
  await expect(page.locator(".react-flow__selection")).toHaveCount(0);

  await beginMarquee(page);
  await page.keyboard.press("Escape");
  await expect(page.locator(".react-flow__selection")).toHaveCount(0);

  await beginMarquee(page);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.locator(".react-flow__selection")).toHaveCount(0);
});
