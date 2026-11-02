import assert from "node:assert/strict";
import test from "node:test";
import React, { useEffect, useState } from "react";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

let scopes = [];
const env = await createDomTestEnv({ mocks: {
  "../i18n": { useLocale: () => ({ t: (key) => key }) },
  "../features/image-studio/ImageStudioPage": { ImageStudioPage: ({ backendId, headerActions }) => {
    useEffect(() => { scopes.push(`mount:${backendId}`); return () => scopes.push(`unmount:${backendId}`); }, [backendId]);
    return React.createElement("div", { "data-image-studio": backendId }, headerActions);
  } },
  "../pages/mcp-hub/McpHubPage": { McpHubPage: () => null },
  "../pages/planning/PlanningPage": { PlanningPage: () => null },
  "../pages/resources/ResourceManagementPage": { ResourceManagementPage: () => null },
  "../pages/skills-hub/SkillsHubPage": { SkillsHubPage: () => null },
} });
const { ApplicationView } = env.loadModule("@liveagent/ui/application/ApplicationView");

test("hub navigation retains chat state and resets image scope; absent host has a real placeholder", async () => {
  const container = document.createElement("div");
  const root = env.createRoot(container);
  let mounts = 0, unmounts = 0;
  function Chat() {
    const [value, setValue] = useState(0);
    useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
    return React.createElement("button", { "data-chat": "", onClick: () => setValue(value + 1) }, value);
  }
  const props = { settings: {}, setSettings() {}, isAgentMode: true, chat: { content: React.createElement(Chat) } };
  const host = (id) => ({ client: {}, ownerId: "local", backendId: id, scopeKey: id });
  const render = (activeView, imageStudioHost) => env.act(async () => root.render(React.createElement(ApplicationView, { ...props, activeView, imageStudioHost })));
  try {
    await render("chat", host("a"));
    const chat = container.querySelector("[data-chat]");
    await env.act(async () => chat.click());
    await render("image-studio-hub", host("a"));
    assert.equal(chat.parentElement.hidden, true);
    assert.equal(chat.parentElement.style.display, "none");
    assert.equal(unmounts, 0);
    await render("image-studio-hub", host("b"));
    assert.deepEqual(scopes, ["mount:a", "unmount:a", "mount:b"]);
    await render("image-studio-hub");
    assert.match(container.textContent, /settings.imageStudioUnsupported/);
    await render("chat");
    assert.equal(container.querySelector("[data-chat]"), chat);
    assert.equal(chat.textContent, "1");
    assert.equal(chat.parentElement.hidden, false);
    assert.equal(mounts, 1);
    assert.equal(unmounts, 0);
  } finally { await env.act(async () => root.unmount()); }
});

test("image studio shows exactly the header actions its host supplies (desktop: theme toggle; web: none, its app header has one)", async () => {
  const container = document.createElement("div");
  const root = env.createRoot(container);
  const render = (headerActions) => env.act(async () => root.render(React.createElement(ApplicationView, {
    settings: { theme: "light" }, setSettings() {}, isAgentMode: true, chat: { content: null }, activeView: "image-studio-hub",
    imageStudioHost: { client: {}, ownerId: "local", backendId: "t", scopeKey: "t", headerActions },
  })));
  try {
    await render(undefined);
    assert.equal(container.querySelector("[data-image-studio] button"), null, "no implicit second theme toggle");
    await render(React.createElement("button", { "data-host-action": "" }, "theme"));
    assert.ok(container.querySelector("[data-image-studio] [data-host-action]"));
  } finally { await env.act(async () => root.unmount()); }
});
