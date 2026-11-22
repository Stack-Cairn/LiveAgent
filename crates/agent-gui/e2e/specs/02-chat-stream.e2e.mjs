import { $, expect } from "@wdio/globals";
import { replyFor } from "../support/fake-provider.mjs";
import {
  byTestId,
  recordAssistantFrames,
  sendPrompt,
  waitForAssistantText,
  waitForIdle,
} from "../support/app.mjs";

describe("chat", () => {
  it("streams a reply from the fake provider into a new session", async () => {
    const prompt = "stream a greeting for the e2e suite";
    const expected = replyFor(prompt);
    const recorder = await recordAssistantFrames();
    await sendPrompt(prompt);
    await waitForAssistantText(expected);
    await waitForIdle();
    const frames = await recorder.stop();

    // The reply arrived in several chunks: at least one partial frame is a
    // strict prefix of the final text.
    const partials = frames.filter((frame) => frame !== expected && expected.startsWith(frame));
    expect(partials.length).toBeGreaterThan(0);

    // The session shows up in the sidebar.
    await expect($(byTestId("sidebar-conversation-title"))).toBeDisplayed();
  });
});
