import { expect, test } from "@playwright/test";

// Smoke test of the core canvas interactions: open Home, create a note,
// single-click enters edit mode, and dragging does NOT enter edit mode. Text
// entry/save is covered by the NoteCard unit tests (component level); this
// e2e focuses on the click-versus-drag intent at the canvas boundary.
//
// Runs against the in-memory MockWorkspaceGateway (no Tauri), so it is fast and
// deterministic.

test("create a note, single-click to edit, drag without editing", async ({ page }) => {
  await page.goto("/");

  // Home canvas is present with zero notes initially.
  await expect(page.getByTestId("canvas")).toBeVisible();
  await expect(page.getByTestId("note-count")).toHaveText("0 notes");

  // Create a note.
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await expect(page.getByTestId("note-count")).toHaveText("1 note");

  // Wait until the note has measurable size (React Flow's measure pass is async).
  await page.waitForFunction(() => {
    const el = document.querySelector(".note-card");
    return el && el.getBoundingClientRect().width > 0;
  });

  // Single click enters edit mode (textarea appears).
  const rect = await page.evaluate(() => {
    const el = document.querySelector(".note-card")!;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(rect.x, rect.y);
  await expect(page.locator(".note-card__textarea")).toHaveCount(1);

  // Click empty canvas to exit editing (blur commits).
  await page.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
  await expect(page.locator(".note-card__textarea")).toHaveCount(0);

  // Drag the note (press, move beyond threshold, release). It must NOT re-enter
  // edit mode after a drag.
  const dragRect = await page.evaluate(() => {
    const el = document.querySelector(".note-card")!;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(dragRect.x, dragRect.y);
  await page.mouse.down();
  await page.mouse.move(dragRect.x + 100, dragRect.y + 60, { steps: 5 });
  await page.mouse.up();

  // Still in display mode: no editor after a drag.
  await expect(page.locator(".note-card__textarea")).toHaveCount(0);
});
