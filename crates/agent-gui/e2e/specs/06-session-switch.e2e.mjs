import { $, $$, browser, expect } from "@wdio/globals";
import { replyFor } from "../support/fake-provider.mjs";
import {
  TIMEOUTS,
  assistantTexts,
  byTestId,
  sendPrompt,
  waitForAssistantText,
  waitForIdle,
} from "../support/app.mjs";

const rows = "[data-conversation-id]";
const titleIn = (id) => `[data-conversation-id="${id}"] ${byTestId("sidebar-conversation-title")}`;

async function activeConversationId() {
  return browser.execute((selector) => {
    const active = document.querySelector(`${selector} [aria-current="page"]`);
    return active?.closest(selector)?.getAttribute("data-conversation-id") ?? null;
  }, rows);
}

describe("session switching", () => {
  const first = "first session question";
  const second = "second session question";

  it("keeps separate transcripts and switches between them from the sidebar", async () => {
    await sendPrompt(first);
    await waitForAssistantText(replyFor(first));
    await waitForIdle();
    await browser.waitUntil(async () => (await activeConversationId()) !== null, {
      timeout: TIMEOUTS.ui,
      timeoutMsg: "first session never became active in the sidebar",
    });
    const firstId = await activeConversationId();

    await $(byTestId("sidebar-new-conversation")).click();
    await browser.waitUntil(async () => !(await assistantTexts()).some((text) => text.includes(replyFor(first))), {
      timeout: TIMEOUTS.ui,
      timeoutMsg: "new conversation still shows the first transcript",
    });
    await sendPrompt(second);
    await waitForAssistantText(replyFor(second));
    await waitForIdle();
    await browser.waitUntil(async () => (await $$(rows).length) >= 2, {
      timeout: TIMEOUTS.ui,
      timeoutMsg: "second session never appeared in the sidebar",
    });
    const secondId = await activeConversationId();
    expect(secondId).not.toBe(firstId);

    await $(titleIn(firstId)).click();
    await waitForAssistantText(replyFor(first));
    await browser.waitUntil(async () => (await activeConversationId()) === firstId, { timeout: TIMEOUTS.ui });
    expect((await assistantTexts()).some((text) => text.includes(replyFor(second)))).toBe(false);

    await $(titleIn(secondId)).click();
    await waitForAssistantText(replyFor(second));
    expect((await assistantTexts()).some((text) => text.includes(replyFor(first)))).toBe(false);
  });
});
