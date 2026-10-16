import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Image services are no longer configured separately: the workbench reads the
// chat providers, so provider settings show no image tab and the client only
// lists the derived services.
const { createImageStudioClient } = createTsModuleLoader().loadModule("@liveagent/ui/lib/imaging/client");

const profileSet = {
  version: "kbrain.image.v1",
  revision: 3,
  profiles: [
    {
      id: "ip_0123456789abcdef",
      name: "RollDek",
      platform: "rolldek",
      providerId: "rolldek",
      baseUrl: "https://api-cn.rolldek.com/v1",
      enabled: true,
      models: ["gpt-image-2"],
      apiKeyConfigured: true,
      targets: [
        {
          id: "it_abc",
          model: "gpt-image-2",
          adapter: "rolldek-images",
          capabilities: { operations: ["generate", "reference"], supportsCancel: false, supportsReconcile: false, supportsContinuation: false, supportsPreview: false, maxInputs: 16, maxCount: 4, outputFormats: ["png"] },
          parameters: [{ key: "size", label: "size", type: "string", required: false }],
          ready: true,
        },
      ],
    },
  ],
};

test("the workbench lists provider image models as 供应商 · 模型", async () => {
  const seen = [];
  const client = createImageStudioClient({
    transport: async (path, init) => {
      seen.push([init.method ?? "GET", path]);
      return new Response(JSON.stringify(profileSet), { headers: { "Content-Type": "application/json" } });
    },
  });
  const targets = await client.listTargets();
  assert.deepEqual(seen, [["GET", "/v1/image/profiles"]]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "RollDek · gpt-image-2");
  assert.equal(targets[0].remoteId, "gpt-image-2");
  assert.equal(targets[0].enabled, true);
  assert.deepEqual(Object.keys(client.profiles).sort(), ["createJobWithParams", "listProfiles"]);
});

test("provider settings no longer embed an image services tab", async () => {
  const fs = await import("node:fs");
  const page = fs.readFileSync(new URL("../../../agent-ui/src/pages/settings/SettingsPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /ProviderImageServices|ImageProfilesPanel/);
  for (const gone of ["pages/settings/ProviderImageServices.tsx", "pages/settings/ImageProfilesPanel.tsx", "features/image-studio/ImageTargetSettings.tsx"])
    assert.equal(fs.existsSync(new URL(`../../../agent-ui/src/${gone}`, import.meta.url)), false, gone);
});