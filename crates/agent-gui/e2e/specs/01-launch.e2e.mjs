import { $, browser, expect } from "@wdio/globals";
import { TIMEOUTS, byTestId, openSettings, waitForAppReady } from "../support/app.mjs";

describe("launch", () => {
  it("boots into the chat view with the fake model selected", async () => {
    await waitForAppReady();
    await expect($("[data-app-boot-shell]")).not.toBeDisplayed();
    await expect($(byTestId("open-settings"))).toBeDisplayed();
  });

  it("reports a healthy K-brain backend in About", async () => {
    await openSettings("about");
    const status = await $(byTestId("kbrain-backend-status"));
    await status.waitForDisplayed({ timeout: TIMEOUTS.ui });
    await browser.waitUntil(async () => (await status.getAttribute("data-state")) !== "loading", {
      timeout: TIMEOUTS.boot,
      timeoutMsg: "K-brain health never resolved",
    });
    expect(await status.getAttribute("data-state")).toBe("ready");
    await expect(status).toHaveText(/K-brain/);
  });
});
