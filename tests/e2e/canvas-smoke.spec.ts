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

  // Single click enters edit mode (ProseMirror becomes editable).
  const editSelector = '.note-card [contenteditable="true"]';
  const rect = await page.evaluate(() => {
    const el = document.querySelector(".note-card")!;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(rect.x, rect.y);
  await expect(page.locator(editSelector)).toHaveCount(1);

  // Click empty canvas to exit editing (blur commits).
  await page.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
  await expect(page.locator(editSelector)).toHaveCount(0);

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
  await expect(page.locator(editSelector)).toHaveCount(0);
});

test("left-drag on empty canvas marquee-selects multiple notes", async ({ page }) => {
  await page.goto("/");
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "New note" }).click();
  }
  await expect(page.getByTestId("note-card")).toHaveCount(3);

  // Marquee requires a plain left-drag on the empty pane (no Shift). Because the
  // notes are placed near the top-left, drag across the whole pane to enclose them.
  const pane = await page.evaluate(() => {
    const el = document.querySelector(".react-flow__pane")!;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(pane.x + 5, pane.y + pane.h - 40);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.w - 5, pane.y + 5, { steps: 10 });
  await page.mouse.up();

  await expect(page.locator(".react-flow__node.selected")).toHaveCount(3);
});

test("right-click deletes the whole selection", async ({ page }) => {
  await page.goto("/");
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "New note" }).click();
  }
  await expect(page.getByTestId("note-card")).toHaveCount(3);

  // Marquee-select all three via a left-drag on the empty pane.
  const pane = await page.evaluate(() => {
    const el = document.querySelector(".react-flow__pane")!;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(pane.x + 5, pane.y + pane.h - 40);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.w - 5, pane.y + 5, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(3);

  // Right-click one of the selected notes, then choose Delete.
  const first = await page.evaluate(() => {
    const el = document.querySelector(".react-flow__node.selected")!;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(first.x, first.y, { button: "right" });
  await expect(page.getByTestId("context-menu")).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();

  await expect(page.getByTestId("note-card")).toHaveCount(0);
});

test("typing into a note persists and survives blur", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);

  // Wait until the note has measurable size.
  await page.waitForFunction(() => {
    const el = document.querySelector(".note-card");
    return el && el.getBoundingClientRect().width > 0;
  });

  // Single click enters edit mode.
  const editSelector = '.note-card [contenteditable="true"]';
  const rect = await page.evaluate(() => {
    const el = document.querySelector(".note-card")!;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(rect.x, rect.y);
  await expect(page.locator(editSelector)).toHaveCount(1);

  // Type into the ProseMirror editor and then blur (click empty canvas) so the
  // draft flushes through the real save path.
  await page.keyboard.type("persisted text");
  await page.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
  await expect(page.locator(editSelector)).toHaveCount(0);

  // The persisted text must still be on the note in display mode.
  await expect(page.locator(".note-card")).toContainText("persisted text");
});
