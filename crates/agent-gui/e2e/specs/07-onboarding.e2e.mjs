import { $, browser, expect } from "@wdio/globals";
import { TIMEOUTS, byTestId, insertText, openCommandPalette, waitForAppReady } from "../support/app.mjs";
import { target } from "../support/env.mjs";

// The harness keeps the first-run guide on for this file only (see
// wdio.conf.mjs). The profile is seeded with a provider and a default model in
// the config file, the way people who set up before the first launch arrive.
const STORAGE_KEY = "liveagent.onboarding.v1";
const palette = "[data-command-palette]";

async function onboardingStatus() {
  return browser.execute((key) => {
    try {
      return JSON.parse(window.localStorage.getItem(key) ?? "null")?.status ?? null;
    } catch {
      return null;
    }
  }, STORAGE_KEY);
}

describe("first-run guide", function () {
  before(function () {
    // The web target turns the guide off at build time.
    if (target !== "tauri") this.skip();
  });

  it("stays closed for a profile that already has a provider and model", async () => {
    await waitForAppReady();
    await browser.waitUntil(async () => (await onboardingStatus()) !== null, {
      timeout: TIMEOUTS.boot,
      timeoutMsg: "the startup decision was never recorded",
    });
    expect(await onboardingStatus()).toBe("auto-skipped");
    await expect($(byTestId("onboarding-dialog"))).not.toBeExisting();
    await $(byTestId("open-settings")).waitForClickable({ timeout: TIMEOUTS.ui });
  });

  it("opens from the command palette and can be skipped", async () => {
    await openCommandPalette();
    const input = `${palette} [role="combobox"]`;
    await $(input).waitForDisplayed({ timeout: TIMEOUTS.ui });
    await insertText(input, "onboarding");
    const action = await $(`${palette} [data-command-palette-action="open-onboarding"]`);
    await action.waitForDisplayed({ timeout: TIMEOUTS.ui });
    await action.click();

    const dialog = await $(byTestId("onboarding-dialog"));
    await dialog.waitForDisplayed({ timeout: TIMEOUTS.ui, timeoutMsg: "the guide did not open" });
    const skip = await $(byTestId("onboarding-skip"));
    await skip.waitForClickable({ timeout: TIMEOUTS.ui });
    await skip.click();
    await dialog.waitForExist({ reverse: true, timeout: TIMEOUTS.ui, timeoutMsg: "the guide stayed open" });
    expect(await onboardingStatus()).toBe("skipped");
    await $(byTestId("open-settings")).waitForClickable({ timeout: TIMEOUTS.ui });
  });
});
