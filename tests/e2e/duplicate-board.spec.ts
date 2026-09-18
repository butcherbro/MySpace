import { expect, test } from "./fixtures";

// tasks/todo.md №16: duplicate a Board Portal's whole subtree. Runs against
// the in-memory MockWorkspaceGateway (no Tauri), covering both entrances:
// the "Duplicate" context-menu action and copy/paste of a selected portal.

test("Duplicate on a portal's context menu creates a second portal nearby", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();

  await page.getByRole("button", { name: "New board", exact: true }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);

  await page.getByTestId("board-portal-card").click({ button: "right" });
  await page.getByRole("button", { name: "Duplicate" }).click();

  await expect(page.getByTestId("board-portal-card")).toHaveCount(2);
  // The duplicate is named "<original> copy" — the backend-assigned title
  // (ADR-0009), not something the frontend guessed.
  await expect(page.locator(".board-portal-card__title").nth(1)).toHaveText("New Board copy");

  // It landed near the original (+24/+24), not stacked exactly on top of it.
  const boxes = await page.locator(".board-portal-card").evaluateAll((nodes) =>
    nodes.map((n) => n.getBoundingClientRect()),
  );
  expect(boxes).toHaveLength(2);
  expect(Math.abs(boxes[1].x - boxes[0].x)).toBeGreaterThan(0);
  expect(Math.abs(boxes[1].y - boxes[0].y)).toBeGreaterThan(0);
});

test("copy/paste a selected portal duplicates its board under the cursor", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();

  await page.getByRole("button", { name: "New board", exact: true }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);
  await page.waitForFunction(() => {
    const el = document.querySelector(".board-portal-card");
    return el && el.getBoundingClientRect().width > 0;
  });

  // Select the portal (a plain click selects a single card).
  await page.locator(".board-portal-card").click();
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);

  await page.keyboard.press("Control+c");

  const target = { x: 520, y: 360 };
  await page.mouse.move(target.x, target.y, { steps: 5 });
  // Same synthetic-paste approach as tests/e2e/paste-cursor.spec.ts: the
  // internal card clipboard doesn't read clipboardData, so a bare paste
  // event exercises the same code path deterministically in headless Chromium.
  await page.evaluate(() => {
    const evt = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    window.dispatchEvent(evt);
  });

  await expect(page.getByTestId("board-portal-card")).toHaveCount(2);
  await expect(page.locator(".board-portal-card__title").nth(1)).toHaveText("New Board copy");

  const pasted = page.locator(".board-portal-card").nth(1);
  await expect
    .poll(async () => {
      const box = await pasted.boundingBox();
      if (!box) return null;
      return Math.abs(box.x - target.x) <= 2 && Math.abs(box.y - target.y) <= 2;
    })
    .toBe(true);
});
