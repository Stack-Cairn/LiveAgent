import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createImageStudioClient } = loader.loadModule("@liveagent/ui/lib/imaging/client");
const model = loader.loadModule("@liveagent/ui/pages/settings/imageSettingsAdapter");
const fixture = () => ({
  revision: 1,
  connections: [model.newImageConnection("ic_test")],
  targets: [{ ...model.newImageTarget("it_test", "ic_test"), remoteId: "image-model", enabled: true }],
});
const json = (body, status = 200) => Response.json({ version: "kbrain.image.v1", ...body }, { status });
const secretRef = `is_${"a".repeat(32)}`;

function mockBackend(initial = fixture(), scope) {
  let settings = initial;
  const calls = [];
  const client = createImageStudioClient({ signal: scope?.signal, transport: async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith("/targets")) return json({ items: settings.targets });
    if (path.endsWith("/secrets")) return json({ ref: secretRef, configured: true });
    assert.ok(path.endsWith("/settings"), path);
    if (init.method === "PUT") {
      const request = JSON.parse(init.body);
      settings = { revision: settings.revision + 1, connections: request.connections, targets: request.targets };
    }
    return json({ settings });
  } });
  return { client, calls };
}

test("same-client settings invalidation follows confirmed saves, isolates subscribers and supports cleanup", async () => {
  const scope = new AbortController();
  const { client } = mockBackend(fixture(), scope);
  const { client: other } = mockBackend();
  let notified = 0;
  let otherNotified = 0;
  client.subscribeSettingsSaved(() => { throw new Error("observer failed"); });
  const unsubscribe = client.subscribeSettingsSaved(() => { notified++; });
  other.subscribeSettingsSaved(() => { otherNotified++; });
  await client.getSettings();
  assert.equal(notified, 0);
  const saved = await client.saveSettings(model.settingsUpdate(fixture()));
  assert.equal(saved.revision, 2);
  assert.equal(notified, 1);
  assert.equal(otherNotified, 0);
  unsubscribe();
  await client.saveSettings(model.settingsUpdate(saved));
  assert.equal(notified, 1);
  client.subscribeSettingsSaved(() => { notified++; });
  scope.abort();
  await assert.rejects(client.saveSettings(model.settingsUpdate(saved)));
  assert.equal(notified, 1);
});

test("failed or malformed settings saves do not invalidate targets", async () => {
  for (const response of [
    json({ error: { code: "IMAGE_REVISION_CONFLICT", message: "conflict", retryable: false, requestId: "r" } }, 409),
    json({ settings: { revision: 2 } }),
  ]) {
    let notified = 0;
    const client = createImageStudioClient({ transport: async () => response });
    client.subscribeSettingsSaved(() => { notified++; });
    await assert.rejects(client.saveSettings(model.settingsUpdate(fixture())));
    assert.equal(notified, 0);
  }
});

test("legacy credential purposes and saved refs bind the canonical adapter keys", async () => {
  for (const [legacy, canonical] of [["api_key", "apiKey"], ["access_key", "accessKey"], ["secret_key", "secretKey"], ["security_token", "securityToken"]]) {
    const settings = fixture();
    settings.connections[0].binding.secretRefs = { [legacy]: secretRef };
    const { client, calls } = mockBackend(settings);
    let notified = 0;
    client.subscribeSettingsSaved(() => { notified++; });
    const response = await model.writeAndBindImageSecret(client, settings, "ic_test", legacy, "TEST-ONLY", () => true, () => {});
    assert.deepEqual(response.connections[0].binding.secretRefs, { [canonical]: secretRef });
    const write = calls.find(call => call.path.endsWith("/secrets"));
    assert.equal(JSON.parse(write.init.body).purpose, canonical);
    assert.equal(notified, 1);
    assert.deepEqual(model.settingsUpdate(settings).connections[0].binding.secretRefs, { [canonical]: secretRef });
  }
  const settings = fixture();
  const canonicalRef = `is_${"b".repeat(32)}`;
  settings.connections[0].binding.secretRefs = { api_key: secretRef, apiKey: canonicalRef };
  assert.deepEqual(model.settingsUpdate(settings).connections[0].binding.secretRefs, { apiKey: canonicalRef });
  for (const invalid of ["unknown", "constructor", "__proto__", "bad purpose"])
    assert.equal(model.canonicalImageSecretPurpose(invalid), undefined);
});

test("credential options match the five adapter protocols", () => {
  for (const protocol of model.imageProtocols) {
    const settings = fixture();
    settings.targets[0].adapter = protocol.id;
    assert.deepEqual(model.imageSecretPurposes(settings, "ic_test"), protocol.id === "jimeng-image" ? ["accessKey", "secretKey", "securityToken"] : ["apiKey"]);
  }
  const settings = fixture();
  settings.targets = [];
  settings.connections[0].binding.authKind = "signed_request";
  assert.deepEqual(model.imageSecretPurposes(settings, "ic_test"), ["accessKey", "secretKey", "securityToken"]);
});

async function mounted(run) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://local.test" });
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root");
  const root = createRoot(container);
  try {
    await run({ dom, root, container });
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
    if (previous.act === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT; else globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
}
const uiMocks = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "../../components/IconSet": new Proxy({}, { get: () => () => null }),
  "../../components/ui/button": { Button: ({ variant: _variant, size: _size, ...props }) => React.createElement("button", props) },
  "../../components/ui/input": { Input: props => React.createElement("input", props) },
};
const click = async (container, text) => {
  const button = [...container.querySelectorAll("button")].find(item => item.textContent === text);
  assert.ok(button, text);
  assert.equal(button.disabled, false, text);
  await React.act(async () => button.click());
};

test("mounted workbench receives a same-client provider settings save without losing its draft or remounting", async () => {
  await mounted(async ({ root, container }) => {
    let controller;
    let mounts = 0;
    const uiLoader = createTsModuleLoader({ mocks: {
      ...uiMocks,
      "../../components/AppErrorBoundary": { AppErrorBoundary: ({ children }) => children },
      "./ImageComposer": { ImageComposer: ({ controller: current, view }) => {
        controller = current;
        React.useEffect(() => { mounts++; }, []);
        return React.createElement("output", { "data-targets": true }, view.targets.map(target => `${target.id}:${target.enabled}`).join(","));
      } },
      "./ImageCompareView": { ImageCompareView: () => null },
      "./ImageDetailPane": { ImageDetailPane: () => null },
      "./ImageProjectRail": { ImageProjectRail: () => null },
      "./ResultGallery": { ResultGallery: () => null },
    } });
    const { ImageStudioPage } = uiLoader.loadModule("@liveagent/ui/features/image-studio/ImageStudioPage");
    const { client, calls } = mockBackend();
    Object.assign(client, {
      capabilities: async () => ({ supported: true }),
      listProjects: async () => ({ items: [{ id: "p", title: "Project" }] }),
      listJobs: async () => ({ items: [] }),
    });
    const render = (showWorkbench = true, activeClient = client) => root.render(
      showWorkbench ? React.createElement(ImageStudioPage, { key: "workbench", client: activeClient, ownerId: "owner", backendId: "backend" }) : null,
    );
    await React.act(async () => render());
    const original = controller;
    await React.act(async () => controller.updateDraft({ prompt: "Keep this draft" }));
    assert.equal(container.querySelector("output").textContent, "it_test:true");
    assert.doesNotMatch(container.textContent, /目标设置/);
    // Provider settings save through the existing client, while this page remains mounted.
    const edited = fixture();
    edited.targets[0].enabled = false;
    await React.act(async () => client.saveSettings(model.settingsUpdate(edited)));
    assert.equal(calls.filter(call => call.path.endsWith("/targets")).length, 2);
    assert.equal(container.querySelector("output").textContent, "it_test:false");
    assert.equal(controller, original);
    assert.equal(mounts, 1);
    assert.equal(controller.view.projectId, "p");
    assert.equal(controller.view.draft.prompt, "Keep this draft");
    await React.act(async () => render(false));
    await client.saveSettings(model.settingsUpdate(fixture()));
    assert.equal(calls.filter(call => call.path.endsWith("/targets")).length, 2);
    // Older host mocks may omit the optional invalidation API entirely.
    const legacy = { ...client, subscribeSettingsSaved: undefined };
    await React.act(async () => render(true, legacy));
    assert.ok(container.querySelector("output"));
  });
});

test("mounted default credential entry writes apiKey and binds the adapter-visible reference", async () => {
  await mounted(async ({ root, container, dom }) => {
    // onInput forwarding keeps this test independent of react-dom's cached DOM feature detection.
    const uiLoader = createTsModuleLoader({ mocks: { ...uiMocks, "../../components/ui/input": {
      Input: ({ onChange, ...props }) => React.createElement("input", { ...props, onInput: onChange }),
    } } });
    const { ImageSettings } = uiLoader.loadModule("@liveagent/ui/pages/settings/ImageSettings");
    const { client, calls } = mockBackend();
    await React.act(async () => root.render(React.createElement(ImageSettings, { client })));
    const purposeLabel = [...container.querySelectorAll("label")].find(label => label.textContent === "凭据用途（purpose）");
    const select = container.querySelector(`[id="${purposeLabel.htmlFor}"]`);
    assert.equal(select.value, "apiKey");
    assert.deepEqual([...select.options].map(option => option.value), ["apiKey"]);
    const password = container.querySelector("input[type=password]");
    await React.act(async () => {
      password.value = "TEST-ONLY";
      password.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click(container, "写入并绑定凭据");
    const write = calls.find(call => call.path.endsWith("/secrets"));
    const save = calls.find(call => call.init.method === "PUT");
    assert.equal(JSON.parse(write.init.body).purpose, "apiKey");
    assert.deepEqual(JSON.parse(save.init.body).connections[0].binding.secretRefs, { apiKey: secretRef });
    assert.equal(password.value, "");
    assert.ok(!save.init.body.includes("TEST-ONLY"));
  });
});
