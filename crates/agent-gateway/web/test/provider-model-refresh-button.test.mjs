import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const providersSectionSource = ["ProviderModal.tsx", "ProviderModalView.tsx"]
  .map((file) =>
    readFileSync(
      new URL(`../../../agent-ui/src/pages/settings/${file}`, import.meta.url),
      "utf8",
    ),
  )
  .join("\n");

test("WebUI provider model refresh only disables while a request is running", () => {
  const clickHandlerIndex = providersSectionSource.indexOf("onClick={handleRefresh}");
  assert.notEqual(clickHandlerIndex, -1);

  const openingTagStart = providersSectionSource.lastIndexOf("<Button", clickHandlerIndex);
  const openingTagEnd = providersSectionSource.indexOf(">", clickHandlerIndex);
  assert.notEqual(openingTagStart, -1);
  assert.notEqual(openingTagEnd, -1);

  const openingTag = providersSectionSource.slice(openingTagStart, openingTagEnd + 1);
  assert.match(openingTag, /disabled=\{fetchingModels\}/);
  assert.doesNotMatch(openingTag, /isGatewayWebui|canFetchModels/);
});

test("provider model refresh accepts a saved WebUI key without exposing it", () => {
  const handlerStart = providersSectionSource.indexOf("function handleRefresh()");
  const handlerEnd = providersSectionSource.indexOf("function toggleModel", handlerStart);
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);

  const handlerSource = providersSectionSource.slice(handlerStart, handlerEnd);
  assert.match(handlerSource, /!trimUrl && !modelsUrl\.trim\(\)/);
  assert.match(handlerSource, /!trimKey && !canReuseStoredApiKey/);
  assert.match(handlerSource, /setFetchError\(t\("settings\.noBaseUrlApiKey"\)\)/);
  assert.match(providersSectionSource, /canReuseStoredApiKey\s*=\s*isGatewayWebui\s*&&\s*apiKeyIsRedactedDisplay/);
  const reuseGuardStart = providersSectionSource.indexOf("const canReuseStoredApiKey");
  const reuseGuardEnd = providersSectionSource.indexOf("const persistedUsageQueryProviderId", reuseGuardStart);
  assert.notEqual(reuseGuardStart, -1);
  assert.notEqual(reuseGuardEnd, -1);
  assert.doesNotMatch(providersSectionSource.slice(reuseGuardStart, reuseGuardEnd), /isFullUrl\s*===/);
  assert.match(providersSectionSource, /providerId: initialData\?\.id/);
});
