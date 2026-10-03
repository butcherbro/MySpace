import { expect, test } from "./fixtures";

// P1.7: a note whose stored document could not be parsed is shown as a
// "damaged" card with its recovered plain text; it cannot be typed into until
// the user chooses Repair, and the repaired text then saves normally.
//
// Seeded through the in-memory mock's test-only `?fixture=corrupt-note`
// (src/services/mock-workspace-gateway.ts): `corrupt-note` is damaged,
// `healthy-note` is a normal note.

test("a damaged note is read-only until Repair; Repair + edit + blur saves", async ({ page }) => {
  await page.goto("/?fixture=corrupt-note");

  const damaged = page.locator('.react-flow__node[data-id="corrupt-note"] .note-card');
  const healthy = page.locator('.react-flow__node[data-id="healthy-note"] .note-card');
  await expect(damaged).toBeVisible();
  await expect(damaged).toHaveAttribute("data-corrupt", "true");
  await expect(damaged.getByRole("status")).toHaveText("Damaged note — showing recovered text");
  await expect(damaged.locator("[data-static-document]")).toHaveText("Recovered words");
  await expect(healthy).toHaveAttribute("data-corrupt", "false");
  await expect(healthy.locator("[data-static-document]")).toHaveText("Healthy words");
  // A damaged note is read-only: nothing resizes it on its own (no frame write).
  await page.waitForTimeout(400);
  expect(Math.round((await damaged.boundingBox())!.height)).toBe(120);

  // Clicking the damaged note does not open an editor, and typing changes nothing.
  await damaged.locator("[data-static-document]").click();
  await expect(damaged.locator('[contenteditable="true"]')).toHaveCount(0);
  await page.keyboard.type("xyz");
  await expect(damaged.locator("[data-static-document]")).toHaveText("Recovered words");
  await expect(damaged).toHaveAttribute("data-corrupt", "true");

  // Repair: the editor opens on the recovered text.
  await damaged.getByRole("button", { name: "Repair" }).click();
  const editor = damaged.locator('.ProseMirror[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveText("Recovered words");
  // Put the caret after the text by clicking right of it on its line: `End`
  // does not move the caret in a contenteditable on macOS, so a click on the
  // editor's centre left it mid-word there ("Recovered wor repairedds").
  const editorBox = (await editor.boundingBox())!;
  await editor.click({ position: { x: editorBox.width - 2, y: 8 } });
  await page.keyboard.press("End");
  await page.keyboard.type(" repaired");
  await expect(editor).toHaveText("Recovered words repaired");

  // Blur (click the empty canvas): the save goes through and the card is normal.
  await page.locator(".react-flow__pane").click({ position: { x: 900, y: 600 } });
  await expect(damaged).toHaveAttribute("data-corrupt", "false");
  await expect(damaged.getByRole("status")).toHaveCount(0);
  await expect(damaged.locator("[data-static-document]")).toHaveText("Recovered words repaired");
  await expect(page.locator(".error-banner")).toHaveCount(0);

  // It stays repaired across navigation (persisted through the gateway).
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await page.locator(".board-portal-card__tile").dblclick({ force: true });
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();
  const reloaded = page.locator('.react-flow__node[data-id="corrupt-note"] .note-card');
  await expect(reloaded).toHaveAttribute("data-corrupt", "false");
  await expect(reloaded.locator("[data-static-document]")).toHaveText("Recovered words repaired");
});

test("recovery mode renders only the restore dialog", async ({ page }) => {
  await page.goto("/?fixture=startup-failure");
  await expect(page.getByTestId("recovery-dialog")).toBeVisible();
  await expect(page.getByTestId("recovery-dialog-message")).toContainText("db_open_failed");
  await expect(page.getByTestId("recovery-dialog-restore")).toHaveText(/^Restore from /);
  await expect(page.getByRole("button", { name: "Quit" })).toBeVisible();
  await expect(page.getByTestId("canvas")).toHaveCount(0);
});
