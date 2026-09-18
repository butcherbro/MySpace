import { expect, test } from "./fixtures";

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
  await expect(page.getByTestId("note-card")).toHaveCount(0);

  // Create a note.
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);

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

test("title-bar Undo and Redo follow workspace command history", async ({ page }) => {
  await page.goto("/");

  const undo = page.getByRole("button", { name: "Undo" });
  const redo = page.getByRole("button", { name: "Redo" });
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();

  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Undo Create note" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(0);

  await page.getByRole("button", { name: "Redo Create note" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);
});

test("New link creates an editable note ready for a pasted URL", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "New link" }).click();

  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await expect(page.locator('.note-card [contenteditable="true"]')).toHaveCount(1);
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

test("Backspace trashes the selection durably instead of only hiding canvas nodes", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await expect(page.locator(".board-portal-card")).toHaveCount(1);

  await page.getByTestId("canvas-surface").focus();
  await page.keyboard.press("Control+A");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await page.keyboard.press("Backspace");

  await expect(page.getByTestId("note-card")).toHaveCount(0);
  await expect(page.locator(".board-portal-card")).toHaveCount(0);

  // Any later projection rebuild used to resurrect the locally hidden objects.
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(0);
  await expect(page.locator(".board-portal-card")).toHaveCount(1);
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

test("a URL-only note waits for blur before converting to a link card", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);

  await page.waitForFunction(() => {
    const el = document.querySelector(".note-card");
    return el && el.getBoundingClientRect().width > 0;
  });

  const rect = await page.evaluate(() => {
    const el = document.querySelector(".note-card")!;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(rect.x, rect.y);
  const editor = page.locator('.note-card [contenteditable="true"]');
  await expect(editor).toHaveCount(1);

  await page.keyboard.type("https://example.com");
  await page.waitForTimeout(350);

  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await expect(page.getByTestId("link-card")).toHaveCount(0);

  await page.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId("link-card")).toHaveCount(1);
});

test("Enter finalizes a URL-only note immediately", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);

  const note = page.getByTestId("note-card");
  await note.click();
  await expect(page.locator('.note-card [contenteditable="true"]')).toHaveCount(1);

  await page.keyboard.type("https://example.com");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("note-card")).toHaveCount(0);
  await expect(page.getByTestId("link-card")).toHaveCount(1);
  await expect(page.getByTestId("link-card")).toContainText("Preview for example.com");
});

test("returning to a board resets the viewport to the top-left origin", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);

  const pane = await page.evaluate(() => {
    const el = document.querySelector(".react-flow__pane")!;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  await page.mouse.move(pane.x + 200, pane.y + 200);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(pane.x + 80, pane.y + 120, { steps: 6 });
  await page.mouse.up({ button: "middle" });

  await page.waitForFunction(() => {
    const viewport = document.querySelector(".react-flow__viewport");
    return viewport?.getAttribute("style")?.includes("translate(");
  });

  const beforeOpen = await page.locator(".react-flow__viewport").getAttribute("style");
  expect(beforeOpen).not.toContain("translate(0px, 0px)");

  const tile = page.locator(".board-portal-card__tile").first();
  await tile.dblclick();
  await expect(page.getByTestId("breadcrumbs")).toContainText("New Board");

  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();
  await expect(page.getByTestId("breadcrumbs")).toContainText("Home");

  await expect
    .poll(async () => page.locator(".react-flow__viewport").getAttribute("style"))
    .toContain("translate(0px, 0px)");
});

test("the canvas cannot pan above or left of its origin", async ({ page }) => {
  await page.goto("/");
  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  // Dragging the camera down/right would expose negative board coordinates.
  // The top-left extent must keep the transform pinned at the origin.
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + 340, box.y + 320, { steps: 6 });
  await page.mouse.up({ button: "middle" });
  await expect
    .poll(async () => page.locator(".react-flow__viewport").getAttribute("style"))
    .toContain("translate(0px, 0px)");

  // Dragging up/left reveals valid positive board coordinates and remains allowed.
  await page.mouse.move(box.x + 340, box.y + 320);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + 180, box.y + 170, { steps: 6 });
  await page.mouse.up({ button: "middle" });
  await expect
    .poll(async () => page.locator(".react-flow__viewport").getAttribute("style"))
    .not.toContain("translate(0px, 0px)");
});

// Double-click used to create a note directly; it now opens a create menu
// (`Add Note` / `Add Board`) at the click point instead — see the "double-click
// empty canvas opens a create menu" test below for the full flow and the
// left-top-corner-at-cursor assertion.
test("double-clicking empty canvas opens the create menu instead of creating a note directly", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("note-card")).toHaveCount(0);

  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.mouse.dblclick(box.x + 220, box.y + 160);

  await expect(page.getByTestId("pane-context-menu")).toBeVisible();
  await expect(page.getByTestId("note-card")).toHaveCount(0);
});

// --- Board hierarchy and breadcrumb drag-and-drop acceptance ---

// Helper: drag a card's center from one screen point to another via mouse
// press/move/release. React Flow treats a press+move as a node drag (not an
// edit click) when the pointer travels beyond the click threshold.
async function dragCenter(page: import("@playwright/test").Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

// Helper: bounding-box center of a locator's first element.
async function centerOf(page: import("@playwright/test").Page, selector: string): Promise<{ x: number; y: number }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
}

test("breadcrumbs show a root-first Home / Child path", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("breadcrumbs")).toContainText("Home");

  // Create a child board on Home, then open it.
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);
  await page.locator(".board-portal-card__tile").dblclick();
  await expect(page.getByTestId("breadcrumbs")).toContainText("New Board");

  // Breadcrumbs are root-first: Home then the child.
  const crumbs = await page.getByTestId("breadcrumbs").getByRole("button").allTextContents();
  expect(crumbs).toEqual(["Home", "New Board"]);

  // Home is always the first crumb and is itself navigable back to root.
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();
  await expect(page.getByTestId("breadcrumbs")).toContainText("Home");
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);
});

test("dropping a board portal onto another board portal reparents it", async ({ page }) => {
  await page.goto("/");

  // Create two sibling boards A and B on Home.
  await page.getByRole("button", { name: "New board" }).click();
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(2);

  // Drag the first portal's tile onto the second portal's tile.
  const tiles = page.locator(".board-portal-card__tile");
  const firstBox = await tiles.nth(0).boundingBox();
  const secondBox = await tiles.nth(1).boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  if (!firstBox || !secondBox) return;

  await dragCenter(
    page,
    { x: firstBox.x + firstBox.width / 2, y: firstBox.y + firstBox.height / 2 },
    { x: secondBox.x + secondBox.width / 2, y: secondBox.y + secondBox.height / 2 },
  );

  // The moved board's portal disappears from Home (moved into B).
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);

  // Open the remaining board; the moved portal now lives inside it.
  await page.locator(".board-portal-card__tile").dblclick();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);
});

test("dropping a leaf card onto the Home breadcrumb moves it to Home's Unsorted", async ({ page }) => {
  await page.goto("/");

  // Create a child board and open it.
  await page.getByRole("button", { name: "New board" }).click();
  await page.locator(".board-portal-card__tile").dblclick();
  await expect(page.getByTestId("breadcrumbs")).toContainText("New Board");

  // Create a note in this child board.
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);

  // Drag the note's center onto the Home breadcrumb crumb.
  const noteCenter = await centerOf(page, ".note-card");
  const homeCrumb = page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" });
  const homeBox = await homeCrumb.boundingBox();
  expect(homeBox).not.toBeNull();
  if (!homeBox) return;

  await dragCenter(page, noteCenter, { x: homeBox.x + homeBox.width / 2, y: homeBox.y + homeBox.height / 2 });

  // The note leaves the child board.
  await expect(page.getByTestId("note-card")).toHaveCount(0);

  // Navigate Home: the note is not on the canvas but in Home's Unsorted panel.
  await homeCrumb.click();
  await expect(page.getByTestId("note-card")).toHaveCount(0);
  await expect(page.getByTestId("unsorted-panel")).toBeVisible();
});

// --- Copy MySpace Link / Copy File Path ---

test("right-click a note copies its MySpace card link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");

  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);

  const center = await centerOf(page, ".note-card");
  await page.mouse.click(center.x, center.y, { button: "right" });
  await expect(page.getByTestId("context-menu")).toBeVisible();

  await page.getByRole("button", { name: "Copy MySpace Link" }).click();

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toMatch(/^myspace:\/\/card\/.+$/);
});

test("right-click a board portal copies the target board link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");

  await page.getByRole("button", { name: "New board" }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);

  const center = await centerOf(page, ".board-portal-card");
  await page.mouse.click(center.x, center.y, { button: "right" });
  await expect(page.getByTestId("context-menu")).toBeVisible();

  await page.getByRole("button", { name: "Copy MySpace Link" }).click();

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toMatch(/^myspace:\/\/board\/.+$/);
});

// --- Browser-like board tabs ---

test("opening boards creates tabs; closing a tab does not delete the board", async ({ page }) => {
  await page.goto("/");

  // Only Home is open: no tab strip.
  await expect(page.getByTestId("board-tabs")).toHaveCount(0);

  // Create a child board and open it.
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);
  await page.locator(".board-portal-card__tile").dblclick();
  await expect(page.getByTestId("breadcrumbs")).toContainText("New Board");

  // Two tabs now: Home + child.
  await expect(page.getByTestId("board-tab")).toHaveCount(2);
  await expect(
    page.getByTestId("board-tab").filter({ hasText: "New Board" }),
  ).toHaveAttribute("data-active", "true");

  // Open Home via breadcrumb -> Home becomes active, both tabs remain.
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();
  await expect(page.getByTestId("board-tab")).toHaveCount(2);
  await expect(
    page.getByTestId("board-tab").filter({ hasText: "Home" }).first(),
  ).toHaveAttribute("data-active", "true");

  // Close the child tab; the strip returns to single-Home (hidden) and the
  // child board still exists on Home as a portal.
  await page.getByRole("button", { name: "Close tab New Board" }).click();
  await expect(page.getByTestId("board-tabs")).toHaveCount(0);
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);
});

test("Back recreates a board tab that was closed while inactive", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.locator(".board-portal-card__tile").first().dblclick();
  await expect(page.getByTestId("board-tab")).toHaveCount(2);
  const firstChildId = await page.getByTestId("board-tab").nth(1).getAttribute("data-board-id");
  expect(firstChildId).toBeTruthy();

  await page.getByTestId("board-tab").first().getByRole("tab", { name: "Home" }).click();
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.locator(".board-portal-card__tile").last().dblclick();
  await expect(page.getByTestId("board-tab")).toHaveCount(3);

  await page
    .getByTestId("board-tab")
    .nth(1)
    .getByRole("button", { name: /Close tab/ })
    .click();
  await expect(page.getByTestId("board-tab")).toHaveCount(2);

  await page.keyboard.press("Control+BracketLeft");

  const restored = page.locator(`[data-testid="board-tab"][data-board-id="${firstChildId}"]`);
  await expect(restored).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("board-tab")).toHaveCount(3);
});

// --- Quick Boards ---

test("dropping a board portal pins a quick board; click opens; remove unpins", async ({ page }) => {
  await page.goto("/");

  // The persistent rail is visible even before the first board is pinned; it
  // starts collapsed so the strip never occupies full width on launch.
  await expect(page.getByTestId("quick-boards")).toHaveCount(1);
  await expect(page.getByTestId("quick-board")).toHaveCount(0);
  await expect(page.getByTestId("right-rail-region")).toHaveAttribute("data-collapsed", "true");

  // Create a child board portal.
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);

  // Свёрнутый край остаётся полноценной целью для закрепления доски.
  await expect(page.getByTestId("right-rail-region")).toHaveAttribute("data-collapsed", "true");
  await expect
    .poll(async () => (await page.getByTestId("right-rail-region").boundingBox())?.width)
    .toBeLessThanOrEqual(40);

  // Перетаскиваем портал на постоянную панель Quick Boards.
  const tileCenter = await centerOf(page, ".board-portal-card__tile");
  const quickRail = page.getByTestId("right-rail-region");
  const railBox = await quickRail.boundingBox();
  expect(railBox).not.toBeNull();
  if (!railBox) return;

  await page.mouse.move(tileCenter.x, tileCenter.y);
  await page.mouse.down();
  await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + 80, { steps: 8 });
  await expect(page.getByTestId("quick-boards")).toHaveClass(/quick-boards-rail--drop/);
  await page.mouse.up();

  // A quick board chip now appears for the pinned board.
  await expect(page.getByTestId("quick-board")).toHaveCount(1);
  await page.getByRole("button", { name: "Expand quick boards" }).click();

  // Changing the source Board cover updates its pinned identity immediately.
  await page.getByTestId("board-portal-card").click({ button: "right" });
  await page.getByRole("button", { name: "Set Cover from Clipboard" }).click();
  await expect(page.locator(".quick-boards-rail__cover")).toHaveCount(1);

  // Click it to open/activate the board tab.
  await page.getByRole("button", { name: "Open quick board New Board" }).click();
  await expect(page.getByTestId("breadcrumbs")).toContainText("New Board");

  // Remove the pin; the chip disappears but the board still exists.
  await page.getByRole("button", { name: /Remove quick board New Board/ }).click();
  await expect(page.getByTestId("quick-boards")).toHaveCount(1);
  await expect(page.getByTestId("quick-board")).toHaveCount(0);
});

test("dropping a note over Quick Boards still persists its canvas position", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
  await page.getByRole("button", { name: "New board", exact: true }).click();

  const note = page.getByTestId("note-card");
  await expect(note).toHaveCount(1);
  const noteNode = page.locator(".react-flow__node").filter({ has: note });
  const before = await note.boundingBox();
  const beforeTransform = await noteNode.evaluate((element) => (element as HTMLElement).style.transform);
  const rail = await page.getByTestId("right-rail-region").boundingBox();
  expect(before).not.toBeNull();
  expect(rail).not.toBeNull();
  if (!before || !rail) return;

  await dragCenter(
    page,
    { x: before.x + before.width / 2, y: before.y + before.height / 2 },
    { x: rail.x + rail.width / 2, y: rail.y + 120 },
  );
  const afterDropTransform = await noteNode.evaluate(
    (element) => (element as HTMLElement).style.transform,
  );
  expect(afterDropTransform).not.toBe(beforeTransform);

  await page.locator(".board-portal-card__tile").dblclick();
  await page.getByRole("button", { name: "Home" }).first().click();

  const afterReloadTransform = await noteNode.evaluate(
    (element) => (element as HTMLElement).style.transform,
  );
  expect(afterReloadTransform).toBe(afterDropTransform);
});

test("right-click empty canvas copies the current board's MySpace link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");

  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.mouse.click(box.x + 200, box.y + 200, { button: "right" });
  await expect(page.getByTestId("pane-context-menu")).toBeVisible();

  await page.getByRole("button", { name: "Copy MySpace Link" }).click();

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toMatch(/^myspace:\/\/board\/.+$/);
});

test("double-click empty canvas opens a create menu; Add Note places the note at the cursor", async ({ page }) => {
  await page.goto("/");

  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  const clickPoint = { x: box.x + 260, y: box.y + 180 };
  await page.mouse.dblclick(clickPoint.x, clickPoint.y);

  const menu = page.getByTestId("pane-context-menu");
  await expect(menu).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Note" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Board" })).toBeVisible();

  await page.getByRole("button", { name: "Add Note" }).click();
  await expect(menu).toHaveCount(0);

  const noteCard = page.locator(".note-card");
  await expect(noteCard).toHaveCount(1);
  await page.waitForFunction(() => {
    const el = document.querySelector(".note-card");
    return el && el.getBoundingClientRect().width > 0;
  });
  const noteBox = await noteCard.boundingBox();
  expect(noteBox).not.toBeNull();
  if (!noteBox) return;
  // Левый верхний угол новой карточки должен оказаться в точке клика (в пикселях
  // экрана, при дефолтном zoom 1 board-space совпадает со screen-space).
  expect(Math.abs(noteBox.x - clickPoint.x)).toBeLessThan(2);
  expect(Math.abs(noteBox.y - clickPoint.y)).toBeLessThan(2);
});

test("Escape closes the pane create menu", async ({ page }) => {
  await page.goto("/");

  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.mouse.dblclick(box.x + 200, box.y + 200);
  const menu = page.getByTestId("pane-context-menu");
  await expect(menu).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("double-click on an existing card does not open the pane create menu", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "New note" }).click();
  const noteCard = page.locator(".note-card");
  await expect(noteCard).toHaveCount(1);
  await page.waitForFunction(() => {
    const el = document.querySelector(".note-card");
    return el && el.getBoundingClientRect().width > 0;
  });

  const rect = await page.evaluate(() => {
    const el = document.querySelector(".note-card")!;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.dblclick(rect.x, rect.y);

  await expect(page.getByTestId("pane-context-menu")).toHaveCount(0);
});
