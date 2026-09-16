import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 供应商页在 WebUI 下的三条契约（旧 ProviderModal 已被三栏结构取代，这里按新组件锁定）：
// 1) "刷新模型列表"只在请求进行中禁用，不因 Key 已脱敏而禁用；
// 2) Key 脱敏时探测走已落库 Key（providerId + credentialId），不把脱敏串当 Key 发出；
// 3) 移动端左栏条目的内容与状态点在同一行。

function readSharedSettingsSource(file) {
  return readFileSync(
    new URL(`../../../agent-ui/src/pages/settings/${file}`, import.meta.url),
    "utf8",
  );
}

const providerDetailSource = readSharedSettingsSource("providers/ProviderDetail.tsx");
const modelListToolbarSource = readSharedSettingsSource("providers/ModelListToolbar.tsx");
const providersSectionSource = readSharedSettingsSource("ProvidersSection.tsx");
const providerProbeSource = readSharedSettingsSource("providerProbe.ts");
const providerChipsSource = readSharedSettingsSource("providers/providerChips.tsx");
const providerUtilsSource = readSharedSettingsSource("providerUtils.ts");
const catalogListSource = readSharedSettingsSource("providers/ProviderCatalogList.tsx");
const responsiveStylesSource = readFileSync(
  new URL("../src/styles/responsive.css", import.meta.url),
  "utf8",
);

function openingTagAround(source, anchor) {
  const anchorIndex = source.indexOf(anchor);
  assert.notEqual(anchorIndex, -1, `anchor not found: ${anchor}`);
  const start = source.lastIndexOf("<Button", anchorIndex);
  const end = source.indexOf(">", anchorIndex);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end + 1);
}

test("WebUI provider model refresh only disables while a request is running", () => {
  // 按钮本体在 ModelListToolbar（ModelListActions）里，禁用条件由 ProviderDetail 传入：
  // 只看 busy，不因 Key 已脱敏而禁用。
  const openingTag = openingTagAround(modelListToolbarSource, "onClick={onRefreshModels}");
  assert.match(openingTag, /disabled=\{refreshDisabled\}/);
  assert.doesNotMatch(openingTag, /isGatewayWebui|keyConfigured|redactedKey|canFetchModels/);
  const actionsStart = providerDetailSource.indexOf("<ModelListActions");
  assert.notEqual(actionsStart, -1);
  const actionsEnd = providerDetailSource.indexOf("/>", actionsStart);
  const actionsProps = providerDetailSource.slice(actionsStart, actionsEnd);
  assert.match(actionsProps, /refreshDisabled=\{busy !== null\}/);
  assert.doesNotMatch(actionsProps, /isGatewayWebui|keyConfigured|redactedKey|canFetchModels/);
});

test("provider model refresh reuses the saved WebUI key without exposing it", () => {
  // 脱敏态输入框的值永远是空串，占位文案不会成为提交值。
  assert.match(providerChipsSource, /value=\{redacted \? "" : value\}/);
  assert.match(providerChipsSource, /if \(redacted && configured && next\.trim\(\) === ""\) return;/);

  // 刷新走探测：启用的 Key 原样交给 probeProvider，并带 providerId 让桌面端能查落库 Key。
  const refreshStart = providersSectionSource.indexOf("async function refreshModels(");
  const refreshEnd = providersSectionSource.indexOf("function createFromDialog(", refreshStart);
  assert.notEqual(refreshStart, -1);
  assert.notEqual(refreshEnd, -1);
  const refreshSource = providersSectionSource.slice(refreshStart, refreshEnd);
  assert.match(refreshSource, /const credentials = enabledCredentials\(provider\);/);
  assert.match(refreshSource, /providerId: provider\.id,/);
  assert.doesNotMatch(refreshSource, /apiKeyConfigured|providerSecretConfigured|redacted/);

  // 探测对每把 Key 传 credentialId + strict；fetchModelsFromApi 在 WebUI 把它们交给网关。
  assert.match(providerProbeSource, /credentialId: credential\.id,/);
  assert.match(providerProbeSource, /credentialId: params\.credentialId,/);
  assert.match(providerProbeSource, /strict: true,/);
  assert.match(
    providerUtilsSource,
    /\{ credentialId: options\?\.credentialId, strict: options\?\.strict === true \}/,
  );
  assert.match(
    providerUtilsSource,
    /\.\.\.\(extra\?\.credentialId \? \{ credential_id: extra\.credentialId \} : \{\}\)/,
  );
});

test("catalog rows keep their content and status dot on one mobile row", () => {
  // 左栏条目：头像 / 文字 / 状态点是一行 flex，文字列 min-w-0 flex-1 截断，状态点 shrink-0。
  assert.match(catalogListSource, /settings-provider-catalog-row flex w-full items-center/);
  assert.match(catalogListSource, /min-w-0 flex-1 leading-tight/);
  assert.match(catalogListSource, /h-2 w-2 shrink-0 rounded-full/);
  // 窄屏两栏塌成一栏时，页面壳与列表列必须允许收缩，否则整行会被撑出视口。
  assert.match(
    providersSectionSource,
    /settings-provider-columns grid min-h-0 flex-1 grid-cols-\[264px_minmax\(0,1fr\)\] gap-5 max-\[720px\]:grid-cols-1/,
  );
  assert.match(
    responsiveStylesSource,
    /\.settings-provider-section\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?min-height:\s*0;/,
  );
});

test("mobile detail view is reached from the list and can go back", () => {
  assert.match(providersSectionSource, /mobileDetailOpen && "max-\[720px\]:hidden"/);
  assert.match(providersSectionSource, /!mobileDetailOpen && "max-\[720px\]:hidden"/);
  assert.match(
    providerDetailSource,
    /settings-provider-back hidden h-8 w-8 max-\[720px\]:inline-flex/,
  );
});
