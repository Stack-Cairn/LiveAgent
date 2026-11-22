import { $, $$, browser, expect } from "@wdio/globals";
import { TIMEOUTS, byTestId, primaryModifier, waitForAppReady } from "../support/app.mjs";

const palette = "[data-command-palette]";
const action = (id) => `${palette} [data-command-palette-action="${id}"]`;

describe("command palette", () => {
  it("opens with the keyboard, filters, and runs an action", async () => {
    await waitForAppReady();
    await browser.keys([await primaryModifier(), "k"]);
    await $(palette).waitForDisplayed({ timeout: TIMEOUTS.ui, timeoutMsg: "palette did not open" });
    await expect($(action("toggle-sidebar"))).toBeDisplayed();

    const input = await $(`${palette} [role="combobox"]`);
    await input.waitForDisplayed({ timeout: TIMEOUTS.ui });
    await browser.keys("settings".split(""));
    await browser.waitUntil(
      async () => (await $$(`${palette} [data-command-palette-action]`).length) >= 1 &&
        !(await $(action("toggle-sidebar")).isExisting()),
      { timeout: TIMEOUTS.ui, timeoutMsg: "palette did not filter" },
    );
    await expect($(action("open-settings"))).toBeDisplayed();

    await $(action("open-settings")).click();
    await $(palette).waitForDisplayed({ reverse: true, timeout: TIMEOUTS.ui });
    await expect($(byTestId("settings-nav-about"))).toBeDisplayed();
  });
});
