import { readFile, rm } from "node:fs/promises";
import { $, expect } from "@wdio/globals";
import { TOOL_MARKER, TOOL_OUTPUT } from "../support/fake-provider.mjs";
import { toolMarkerFile } from "../support/env.mjs";
import {
  TIMEOUTS,
  byTestId,
  sendPrompt,
  waitForAppReady,
  waitForAssistantText,
  waitForIdle,
} from "../support/app.mjs";

describe("tool approval", () => {
  before(async () => {
    await rm(toolMarkerFile, { force: true });
    await waitForAppReady();
    // Switch the composer to "ask every time" so the Bash call needs approval.
    const picker = await $(byTestId("composer-safety-mode"));
    await picker.waitForClickable({ timeout: TIMEOUTS.ui });
    await picker.click();
    const ask = await $(byTestId("composer-safety-mode-ask"));
    await ask.waitForClickable({ timeout: TIMEOUTS.ui });
    await ask.click();
    await expect(picker).toHaveAttribute("data-mode", "ask");
  });

  it("asks before running the tool, then runs it once approved", async () => {
    await sendPrompt(`${TOOL_MARKER} write the marker file`);

    const bar = await $(byTestId("tool-approval"));
    await bar.waitForDisplayed({ timeout: TIMEOUTS.reply, timeoutMsg: "approval bar never appeared" });
    await expect($("[data-approval-command]")).toHaveText(expect.stringContaining(TOOL_OUTPUT));
    // Nothing ran yet.
    await expect(readFile(toolMarkerFile, "utf8")).rejects.toThrow();

    await $(byTestId("tool-approval-approve")).click();
    await bar.waitForDisplayed({ reverse: true, timeout: TIMEOUTS.ui });

    await waitForAssistantText(`Tool finished: ${TOOL_OUTPUT}`);
    await waitForIdle();
    expect(await readFile(toolMarkerFile, "utf8")).toBe(TOOL_OUTPUT);
  });
});
