import { expect, test } from "@playwright/test";

// Search field acceptance: create a note with distinctive text inside a child
// board, return Home, type into the top-bar search field, and navigate back to
// the board that contains the matching note. Runs against the in-memory mock (no
// Tauri).

test("top-bar search navigates to a note's board", async ({ page }) => {
  await page.goto("/");

  // Create a child board and open it.
  await page.getByRole("button", { name: "New board", exact: true }).click();
  await expect(page.getByTestId("board-portal-card")).toHaveCount(1);
  await page.locator(".board-portal-card__tile").dblclick({ force: true });

  // Create a note with distinctive text.
  await page.getByRole("button", { name: "New note", exact: true }).click();
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
  await page.keyboard.type("needle phrase for search");
  await page.getByTestId("canvas").click({ position: { x: 5, y: 5 } });

  // Return Home so the matching board is no longer the current board.
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Home" }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(0);

  // Type into the always-visible search field; the result dropdown appears.
  await page.getByRole("searchbox", { name: "Search" }).fill("needle phrase");
  await expect(page.getByText("needle phrase for search")).toBeVisible();

  // Selecting it navigates to the child board and reveals the note.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("note-card")).toHaveCount(1);
  await expect(page.getByTestId("breadcrumbs")).toContainText("New Board");

  // Escape clears the field and hides the dropdown.
  await page.getByRole("searchbox", { name: "Search" }).fill("needle phrase");
  await expect(page.getByTestId("search-results")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("search-results")).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Search" })).toHaveValue("");
});

test("Backspace edits the search field instead of trashing canvas selection", async ({ page }) => {
  await page.goto("/");

  // Create a note so there is something that could wrongly be deleted.
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(page.getByTestId("note-card")).toHaveCount(1);

  // Type into the search field and delete one char with Backspace.
  const search = page.getByRole("searchbox", { name: "Search" });
  await search.click();
  await search.fill("abc");
  await page.keyboard.press("Backspace");

  // The text is edited in place, and the note is untouched.
  await expect(search).toHaveValue("ab");
  await expect(page.getByTestId("note-card")).toHaveCount(1);
});