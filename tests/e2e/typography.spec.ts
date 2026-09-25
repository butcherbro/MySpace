import { expect, test } from "./fixtures";
import type { Locator } from "@playwright/test";

// The app ships its own font (Inter Variable via @fontsource-variable/inter,
// bundled as woff2), so text looks the same on Windows and macOS. These checks
// run against the real render: the family is applied, the face actually
// loaded (not a silent fallback to Segoe UI / -apple-system), and the note
// scale is identical in the static idle view and the mounted editor (P1.8).

test("the UI and note text render in the bundled Inter Variable", async ({ page }) => {
  await page.goto("/?fixture=dense&notes=4");
  const note = page.locator('.react-flow__node[data-id="dense-note-1"] .note-card');
  await expect(note.locator("[data-static-document]")).toBeVisible();

  const probe = await page.evaluate(async () => {
    await document.fonts.ready;
    // Subsets load lazily per unicode-range; the board has no Cyrillic yet.
    await document.fonts.load('15px "Inter Variable"', "Заметка");
    const staticRoot = document.querySelector('[data-static-document]') as HTMLElement;
    const text = getComputedStyle(staticRoot);
    return {
      body: getComputedStyle(document.body).fontFamily,
      note: text.fontFamily,
      noteSize: text.fontSize,
      noteLineHeight: text.lineHeight,
      features: text.fontFeatureSettings,
      // Latin and Cyrillic subsets are separate woff2 files; both must load.
      latin: document.fonts.check('15px "Inter Variable"', "Note"),
      cyrillic: document.fonts.check('15px "Inter Variable"', "Заметка"),
      // check() is also true when no face covers the text at all, so prove
      // the latin and cyrillic faces really loaded.
      loadedFaces: [...document.fonts].filter(
        (f) => f.family.replace(/"/g, "") === "Inter Variable" && f.status === "loaded",
      ).length,
    };
  });

  expect(probe.body).toMatch(/^"?Inter Variable"?,/);
  expect(probe.note).toMatch(/^"?Inter Variable"?,/);
  expect(probe.noteSize).toBe("15px");
  expect(parseFloat(probe.noteLineHeight)).toBeCloseTo(15 * 1.55, 1);
  expect(probe.features).toContain('"cv11"');
  expect(probe.latin).toBe(true);
  expect(probe.cyrillic).toBe(true);
  expect(probe.loadedFaces).toBeGreaterThanOrEqual(2);
});

/** Layout of every block in a note's document root, relative to the card. */
async function blockMetrics(root: Locator) {
  return root.evaluate((el) => {
    const origin = el.getBoundingClientRect();
    const blocks = [...el.querySelectorAll("p, h1, h2, h3, li")].map((b) => {
      const r = b.getBoundingClientRect();
      return { tag: b.tagName, top: r.top - origin.top, height: r.height, width: r.width };
    });
    return { height: el.scrollHeight, blocks };
  });
}

test("a note's text does not move when it enters edit mode", async ({ page }) => {
  await page.goto("/?fixture=dense&notes=4");
  const note = page.locator('.react-flow__node[data-id="dense-note-1"] .note-card');
  const staticRoot = note.locator("[data-static-document]");
  const editorRoot = note.locator('.ProseMirror[contenteditable="true"]');
  await expect(staticRoot).toBeVisible();

  // Give the note headings, a list and Cyrillic text (markdown input rules).
  await staticRoot.click();
  await expect(editorRoot).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("# Заголовок\n## Section\n### Detail\nПервый абзац текста.\n- one\ntwo\nthree");
  await page.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
  await expect(editorRoot).toHaveCount(0);
  await expect(staticRoot.locator("h1")).toHaveText("Заголовок");
  await expect(staticRoot.locator("li")).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready);

  const cardBefore = await note.boundingBox();
  const before = await blockMetrics(staticRoot);

  // Re-enter editing by clicking the heading (no content change).
  await staticRoot.locator("h1").click();
  await expect(editorRoot).toHaveCount(1);
  const cardAfter = await note.boundingBox();
  const after = await blockMetrics(editorRoot);

  expect(after.blocks.map((b) => b.tag)).toEqual(before.blocks.map((b) => b.tag));
  expect(after.height).toBeCloseTo(before.height, 0);
  after.blocks.forEach((b, i) => {
    expect(b.top).toBeCloseTo(before.blocks[i].top, 0);
    expect(b.height).toBeCloseTo(before.blocks[i].height, 0);
  });
  expect(cardAfter?.height).toBeCloseTo(cardBefore?.height ?? 0, 0);
  expect(cardAfter?.width).toBeCloseTo(cardBefore?.width ?? 0, 0);
});
