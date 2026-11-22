import { $, browser, expect } from "@wdio/globals";
import { TIMEOUTS, byTestId, isChecked, openSettings, restartApp, waitForAppReady } from "../support/app.mjs";

const shortcut = byTestId("sidebar-shortcut-memory");
const toggle = byTestId("settings-sidebar-shortcut-memory");

describe("settings", () => {
  it("opens settings and hides a sidebar shortcut", async () => {
    await waitForAppReady();
    await expect($(shortcut)).toBeDisplayed();

    await openSettings("system");
    const control = await $(toggle);
    await control.scrollIntoView({ block: "center" });
    await control.waitForClickable({ timeout: TIMEOUTS.ui });
    expect(await isChecked(control)).toBe(true);
    await control.click();
    await browser.waitUntil(async () => !(await isChecked(control)), {
      timeout: TIMEOUTS.ui,
      timeoutMsg: "switch did not turn off",
    });
    await $(`${byTestId("settings-save-state")}[data-state="saved"]`).waitForExist({
      timeout: TIMEOUTS.ui,
      timeoutMsg: "settings were not saved",
    });
    await expect($(shortcut)).not.toBeExisting();
  });

  it("keeps the change after an app restart", async () => {
    await restartApp();
    await expect($(shortcut)).not.toBeExisting();
    await openSettings("system");
    const control = await $(toggle);
    await control.scrollIntoView({ block: "center" });
    expect(await isChecked(control)).toBe(false);
  });
});
