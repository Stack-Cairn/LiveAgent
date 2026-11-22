// Page helpers shared by the specs. Selectors only use data-testid / data-*
// hooks and text the fake provider produces, never localized UI strings.
import { $, $$, browser } from "@wdio/globals";
import { target } from "./env.mjs";

export const byTestId = (id) => `[data-testid="${id}"]`;

export const TIMEOUTS = {
  boot: 90_000,
  reply: 30_000,
  ui: 15_000,
};

/** Waits until the chat composer is interactive (backend connected, model loaded). */
export async function waitForAppReady() {
  const composer = await $(`${byTestId("chat-composer")} [role="textbox"]`);
  await composer.waitForDisplayed({ timeout: TIMEOUTS.boot, timeoutMsg: "chat composer never appeared" });
  await browser.waitUntil(
    async () => (await composer.getAttribute("aria-disabled")) !== "true",
    { timeout: TIMEOUTS.boot, timeoutMsg: "chat composer stayed disabled" },
  );
  return composer;
}

/** The platform modifier for app shortcuts (Cmd on macOS, Ctrl elsewhere). */
export async function primaryModifier() {
  const isMac = await browser.execute(() => /mac/i.test(navigator.platform));
  return isMac ? "Meta" : "Control";
}

export async function typePrompt(text) {
  const composer = await waitForAppReady();
  await composer.click();
  await browser.keys(text.split(""));
  await browser.waitUntil(async () => (await composer.getText()).includes(text), {
    timeout: TIMEOUTS.ui,
    timeoutMsg: `composer never contained ${JSON.stringify(text)}`,
  });
}

export async function sendPrompt(text) {
  await typePrompt(text);
  const send = await $(byTestId("composer-send"));
  await send.waitForClickable({ timeout: TIMEOUTS.ui });
  await send.click();
}

/** Text of every rendered assistant block, in document order. */
export async function assistantTexts() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-quote-source="assistant"]'), (node) =>
      (node.textContent ?? "").trim(),
    ),
  );
}

export async function waitForAssistantText(text, timeout = TIMEOUTS.reply) {
  await browser.waitUntil(async () => (await assistantTexts()).some((value) => value.includes(text)), {
    timeout,
    timeoutMsg: `assistant reply containing ${JSON.stringify(text)} never rendered`,
  });
}

/** Waits until the run is finished (the send button is no longer a stop button). */
export async function waitForIdle(timeout = TIMEOUTS.reply) {
  const send = await $(byTestId("composer-send"));
  await browser.waitUntil(async () => (await send.getAttribute("data-sending")) === "false", {
    timeout,
    timeoutMsg: "run never finished",
  });
}

/**
 * Records every distinct assistant text the page renders until `stop()` is
 * called, so a spec can prove a reply arrived incrementally.
 */
export async function recordAssistantFrames() {
  await browser.execute(() => {
    const frames = [];
    const capture = () => {
      const nodes = document.querySelectorAll('[data-quote-source="assistant"]');
      const last = nodes[nodes.length - 1];
      const text = (last?.textContent ?? "").trim();
      if (text && frames[frames.length - 1] !== text) frames.push(text);
    };
    const observer = new MutationObserver(capture);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    window.__e2eFrames = { frames, observer };
  });
  return {
    async stop() {
      return browser.execute(() => {
        const state = window.__e2eFrames;
        state?.observer.disconnect();
        return state?.frames ?? [];
      });
    },
  };
}

export async function openSettings(section) {
  const button = await $(byTestId("open-settings"));
  await button.waitForClickable({ timeout: TIMEOUTS.ui });
  await button.click();
  if (section) {
    const nav = await $(byTestId(`settings-nav-${section}`));
    await nav.waitForClickable({ timeout: TIMEOUTS.ui });
    await nav.click();
  }
}

export async function isChecked(element) {
  const value = await element.getAttribute("aria-checked");
  if (value !== null) return value === "true";
  return (await element.getAttribute("data-checked")) !== null;
}

/**
 * Restarts the app with the same isolated home. On the desktop target this
 * ends the WebDriver session (the app process exits) and launches a new one;
 * the browser host keeps its profile and reloads the page.
 */
export async function restartApp() {
  if (target === "tauri") {
    await browser.reloadSession();
  } else {
    await browser.refresh();
  }
  await waitForAppReady();
}
