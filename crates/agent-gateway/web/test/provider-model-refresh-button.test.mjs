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
const providerListSource = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/ProvidersSection.tsx", import.meta.url),
  "utf8",
);
const responsiveStylesSource = readFileSync(
  new URL("../src/styles/responsive.css", import.meta.url),
  "utf8",
);

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

test("provider cards keep their content and actions on one mobile row", () => {
  assert.match(providerListSource, /settings-provider-card-row/);
  assert.match(providerListSource, /settings-provider-card-main min-w-0 flex-1/);
  assert.match(
    responsiveStylesSource,
    /\.settings-provider-card-row\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*20px 20px minmax\(0, 1fr\) auto;/,
  );
});

test("provider request navigation label stays centered on mobile", () => {
  assert.match(
    providersSectionSource,
    /min-w-0 flex-1 max-\[720px\]:flex-none max-\[720px\]:basis-auto/,
  );
  assert.doesNotMatch(providersSectionSource, /max-\[720px\]:basis-\[calc\(100%-3rem\)\]/);
});
