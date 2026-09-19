import { readStyleSource } from "../../../agent-ui/test-support/style-values.mjs";
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

test("WebUI provider model refresh only disables while a request is running", () => {
  const clickHandlerIndex = providersSectionSource.indexOf("onClick={handleRefresh}");
  assert.notEqual(clickHandlerIndex, -1);

  const openingTagStart = providersSectionSource.lastIndexOf("<Button", clickHandlerIndex);
  const openingTagEnd = providersSectionSource.indexOf(">", clickHandlerIndex);
  assert.notEqual(openingTagStart, -1);
  assert.notEqual(openingTagEnd, -1);

  const openingTag = providersSectionSource.slice(openingTagStart, openingTagEnd + 1);
  // 只允许「请求进行中」和「连 base URL 都没有」两个禁用条件；绝不能因 WebUI
  // 看不到已保存的 key 就把按钮禁掉（key 复用由 handleRefresh 内部处理）。
  assert.match(openingTag, /disabled=\{fetchingModels \|\| !baseUrl\.trim\(\)\}/);
  assert.doesNotMatch(openingTag, /isGatewayWebui|canFetchModels|apiKey/);
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
  assert.match(providerListSource, /min-w-0 flex-1 web:max-520:min-w-0/);
  assert.match(
    providerListSource,
    /web:max-520:grid web:max-520:grid-cols-settings-provider-card-row/,
  );
  const theme = readStyleSource(new URL("../../../agent-ui/src/styles/tokens.css", import.meta.url));
  assert.match(theme, /--grid-template-columns-settings-provider-card-row:\s*20px\s+20px\s+minmax\(0, 1fr\)\s+auto;/);
});

// 导航从左侧列表改为头部的两个 ghost 按钮：窄屏下头部包裹换行，按钮组靠左、
// 保存/取消靠右，不再需要旧的 basis 类微调。
test("provider request navigation lives in a wrapping header on mobile", () => {
  assert.match(
    providersSectionSource,
    /<DialogHeader className="flex-row flex-wrap items-center gap-3 border-0">/,
  );
  assert.match(providersSectionSource, /onClick=\{\(\) => setActivePanel\("request"\)\}/);
  assert.match(providersSectionSource, /onClick=\{\(\) => setActivePanel\("usage"\)\}/);
  assert.match(providersSectionSource, /ml-auto flex flex-wrap items-center justify-end gap-2/);
  assert.doesNotMatch(providersSectionSource, /max-\[720px\]:basis-\[calc\(100%-3rem\)\]/);
});
