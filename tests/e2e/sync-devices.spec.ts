import { expect, test } from "./fixtures";

// LAN sync (ADR-0011 S3) against the in-memory mock: `?fixture=sync-peers`
// puts two devices "on the network"; the mock pairs with the code 123456 and
// `Sync now` stamps the last sync time.

test("pair a discovered device from the Devices dialog and sync it", async ({ page }) => {
  await page.goto("/?fixture=sync-peers");

  const pill = page.getByTestId("sync-status-pill");
  await expect(pill).toHaveAttribute("data-state", "no-peers");
  await pill.click();

  const dialog = page.getByTestId("devices-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("devices-no-peers")).toBeVisible();
  const pc = dialog.getByTestId("discovered-row").filter({ hasText: "Windows PC" });
  await expect(pc).toBeVisible();
  await expect(dialog.getByTestId("discovered-row")).toHaveCount(2);

  await pc.getByTestId("discovered-pair").click();
  await pc.getByTestId("pair-code-input").fill("123456");
  await pc.getByTestId("pair-submit").click();

  const paired = dialog.getByTestId("paired-row").filter({ hasText: "Windows PC" });
  await expect(paired).toBeVisible();
  await expect(paired.getByTestId("paired-online")).toHaveAttribute("data-online", "true");
  await expect(dialog.getByTestId("discovered-row")).toHaveCount(1);
  await expect(pill).toHaveAttribute("data-state", "idle");

  const lastSync = paired.getByTestId("paired-last-sync");
  await expect(lastSync).toHaveText("Last sync: Never");
  await paired.getByTestId("paired-sync-now").click();
  await expect(lastSync).toHaveText("Last sync: just now");
  await expect(lastSync).not.toHaveAttribute("data-last-sync-at", "");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("the Devices dialog opens from the Trash drawer and shows the pairing code", async ({ page }) => {
  await page.goto("/?fixture=sync-peers");
  await page.getByRole("button", { name: "Open Trash" }).click();
  await page.getByTestId("trash-drawer-devices").click();
  const dialog = page.getByTestId("devices-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("devices-begin-pairing").click();
  await expect(dialog.getByTestId("devices-pairing-code")).toHaveText("123 456");
});
