import { expect, test } from "./fixtures";

// ADR-0012: a folder shortcut created on another device (no locator here)
// renders dimmed with an "On <device>" badge, cannot open, and turns into a
// working shortcut after "Point to a folder on this computer…". The browser
// harness answers the folder picker with the fixture's folder
// (`fixturePickedFolder` in the mock gateway).

test("a shortcut from another device is badged, closed, and can be pointed at a local folder", async ({ page }) => {
  await page.goto("/?fixture=foreign-shortcut");

  const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const foreign = node("foreign-folder").getByTestId("folder-shortcut-card");
  const local = node("local-folder").getByTestId("folder-shortcut-card");
  await expect(page.getByTestId("folder-shortcut-card")).toHaveCount(2);

  // The local shortcut behaves as before.
  await expect(local).not.toHaveAttribute("data-foreign", "true");
  await expect(local).toHaveAttribute("data-preview-status", "ready");
  await expect(local.getByRole("button", { name: "Open Footage in Finder" })).toBeEnabled();

  // The foreign one: dimmed, badged with its origin device, open disabled,
  // no preview loaded.
  await expect(foreign).toHaveAttribute("data-foreign", "true");
  await expect(foreign).toHaveAttribute("data-preview-status", "foreign_device");
  const badge = foreign.getByTestId("folder-origin-badge");
  await expect(badge).toHaveText("On Studio Mac");
  await expect(badge).toHaveAttribute("title", "/Users/me/Research");
  await expect(foreign.getByRole("button", { name: "Open Research in Finder" })).toBeDisabled();
  await expect(foreign.getByTestId("folder-preview-row")).toHaveCount(0);

  // Its context menu offers the re-point instead of "Show in Finder".
  await foreign.click({ button: "right" });
  const menu = page.getByTestId("context-menu");
  await expect(menu.getByRole("button", { name: "Show in Finder" })).toHaveCount(0);
  await menu.getByRole("button", { name: "Point to a folder on this computer…" }).click();

  // Now local: badge gone, open enabled, the live preview loaded.
  await expect(foreign).not.toHaveAttribute("data-foreign", "true");
  await expect(foreign).toHaveAttribute("data-preview-status", "ready");
  await expect(foreign.getByTestId("folder-origin-badge")).toHaveCount(0);
  await expect(foreign.getByRole("button", { name: "Open Research in Finder" })).toBeEnabled();
  await expect(foreign.getByTestId("folder-preview-row").first()).toBeVisible();

  // A local shortcut's context menu keeps "Show in Finder".
  await local.click({ button: "right" });
  await expect(menu.getByRole("button", { name: "Show in Finder" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Point to a folder on this computer…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("the in-card button re-points a foreign shortcut too", async ({ page }) => {
  await page.goto("/?fixture=foreign-shortcut");
  const foreign = page
    .locator('.react-flow__node[data-id="foreign-folder"]')
    .getByTestId("folder-shortcut-card");
  await expect(foreign).toHaveAttribute("data-foreign", "true");
  await foreign.getByRole("button", { name: "Point to a folder on this computer…" }).click();
  await expect(foreign).toHaveAttribute("data-preview-status", "ready");
});
