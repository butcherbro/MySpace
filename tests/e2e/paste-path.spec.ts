import { expect, test } from "./fixtures";

// tasks/todo.md №23: Cmd+V on the empty canvas with a filesystem path on the
// clipboard creates a folder shortcut / File Card instead of a note, mirroring
// native Finder drag-drop. Runs against the in-memory MockWorkspaceGateway,
// whose `classifyPath` heuristic treats an extensionless path as an existing
// folder, an extensioned path as an existing file, and any path containing
// "does-not-exist" as missing (see mock-workspace-gateway.ts).

async function pasteText(page: import("@playwright/test").Page, text: string) {
  await page.evaluate((value) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", value);
    const evt = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    window.dispatchEvent(evt);
  }, text);
}

test("pasting an existing folder path creates a folder shortcut under the cursor", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();

  const target = { x: 480, y: 320 };
  await page.mouse.move(target.x, target.y, { steps: 5 });

  await pasteText(page, "/Users/mock/Research");

  await expect(page.getByTestId("folder-shortcut-card")).toHaveCount(1);
  const card = page.getByTestId("folder-shortcut-card");
  // Folder shortcuts get a 360x300 default frame centered on the cursor
  // (same `-180/-150` offset as the native Finder-drop origin), so the card's
  // top-left sits that far above/left of the cursor point, not under it.
  await expect
    .poll(async () => {
      const box = await card.boundingBox();
      if (!box) return null;
      return (
        Math.abs(box.x - (target.x - 180)) <= 2 && Math.abs(box.y - (target.y - 150)) <= 2
      );
    })
    .toBe(true);
  // No fallback note was created alongside the shortcut.
  await expect(page.getByTestId("note-card")).toHaveCount(0);
});

test("pasting an existing file path creates a File Card", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();

  await page.mouse.move(460, 300, { steps: 5 });
  await pasteText(page, "/Users/mock/readme.txt");

  await expect(page.getByTestId("file-card")).toHaveCount(1);
  await expect(page.getByTestId("note-card")).toHaveCount(0);
});

test("pasting a path that does not exist falls back to a plain note", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();

  await page.mouse.move(440, 280, { steps: 5 });
  await pasteText(page, "/Users/mock/does-not-exist.txt");

  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await expect(page.getByTestId("folder-shortcut-card")).toHaveCount(0);
  await expect(page.getByTestId("file-card")).toHaveCount(0);
  await expect(page.locator(".note-card")).toContainText("/Users/mock/does-not-exist.txt");
});

test("pasting multi-line text starting with / still creates a plain note", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas")).toBeVisible();

  await page.mouse.move(420, 260, { steps: 5 });
  await pasteText(page, "/not/a/path\nsecond line");

  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await expect(page.getByTestId("folder-shortcut-card")).toHaveCount(0);
  await expect(page.getByTestId("file-card")).toHaveCount(0);
});
