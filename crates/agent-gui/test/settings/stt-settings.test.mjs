import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../../agent-gateway/test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url)),
});
const { getDefaultSttSettings, normalizeSttSettings } = loader.loadModule(
  "@liveagent/ui/lib/settings/index.ts",
);

test("STT provider defaults match the four provider configuration forms", () => {
  const defaults = getDefaultSttSettings();
  assert.equal(defaults.enabled, false);
  const providers = defaults.providers;
  assert.deepEqual(Object.keys(providers), [
    "tencent_cloud",
    "volcengine_seed_v3",
    "aliyun_dashscope",
    "baidu_cloud",
  ]);
  assert.equal(
    providers.aliyun_dashscope.websocketUrl,
    "wss://dashscope.aliyuncs.com/api-ws/v1/inference/",
  );
  assert.equal(providers.aliyun_dashscope.model, "paraformer-realtime-v2");
  assert.equal(providers.tencent_cloud.engineModelType, "16k_zh");
  assert.equal(
    providers.volcengine_seed_v3.websocketUrl,
    "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  );
  assert.equal(providers.baidu_cloud.websocketUrl, "wss://vop.baidu.com/realtime_asr");
  assert.equal(providers.baidu_cloud.devPid, "");
});

test("legacy STT settings gain protocol defaults without changing saved values", () => {
  const normalized = normalizeSttSettings({
    enabled: true,
    provider: "volcengine_v2",
    providers: {
      aliyun_dashscope: {
        id: "aliyun_dashscope",
        configured: true,
        model: "paraformer-realtime-8k-v2",
      },
      tencent_cloud: { id: "tencent_cloud", engineModelType: "16k_en" },
      volcengine_v2: { id: "volcengine_v2", cluster: "custom_cluster" },
    },
  });
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.provider, null);
  assert.equal(normalized.aliyun_dashscope, undefined);
  assert.equal(
    normalized.providers.aliyun_dashscope.websocketUrl,
    "wss://dashscope.aliyuncs.com/api-ws/v1/inference/",
  );
  assert.equal(normalized.providers.aliyun_dashscope.model, "paraformer-realtime-v2");
  assert.equal(normalized.providers.tencent_cloud.engineModelType, "16k_en");
  assert.equal(normalized.providers.volcengine_v2, undefined);
  assert.equal(
    normalized.providers.volcengine_seed_v3.websocketUrl,
    "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  );
  assert.equal(normalized.providers.baidu_cloud.websocketUrl, "wss://vop.baidu.com/realtime_asr");
});

test("STT settings name the active runtime in the UI language", () => {
  const i18n = loader.loadModule("src/i18n/config.ts");
  loader.loadModule("@liveagent/ui/i18n/namespaces/settings.ts");
  const { webSttSettingsService } = loader.loadModule("src/lib/stt/webSttSettingsService.ts");
  const runtimeLine = (key, locale) =>
    i18n.t("settings.stt.runtime", locale).replace("{runtime}", i18n.t(key, locale));

  assert.equal(webSttSettingsService.runtime, "webui");
  assert.equal(
    runtimeLine("settings.stt.runtimeWebui", "en-US"),
    "Current runtime: WebUI (synced with the desktop app; the Gateway keeps credentials secure)",
  );
  assert.equal(
    runtimeLine("settings.stt.runtimeDesktop", "en-US"),
    "Current runtime: Desktop app (synced to the Gateway WebUI)",
  );
  assert.equal(
    runtimeLine("settings.stt.runtimeWebui", "zh-CN"),
    "当前运行端：WebUI（与桌面端同步，凭据由 Gateway 安全托管）",
  );
  assert.equal(
    runtimeLine("settings.stt.runtimeDesktop", "zh-CN"),
    "当前运行端：桌面端（同步到 Gateway WebUI）",
  );
  for (const key of ["settings.stt.runtimeWebui", "settings.stt.runtimeDesktop"]) {
    assert.doesNotMatch(runtimeLine(key, "en-US"), /[\u3400-\u9fff]/);
  }
});

test("STT settings request failures keep the localized message and add the HTTP detail", async () => {
  const mocked = createWebModuleLoader({
    rootDir: fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url)),
    mocks: { "@/lib/storage": { loadToken: () => "token" } },
  });
  const { createWebSttSettingsService } = mocked.loadModule("src/lib/stt/webSttSettingsService.ts");
  const { SttSettingsRequestError } = mocked.loadModule("@liveagent/ui/lib/stt/errors.ts");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("STT settings unavailable", { status: 500 });
  try {
    await assert.rejects(createWebSttSettingsService().get(), (error) => {
      assert.ok(error instanceof SttSettingsRequestError);
      assert.equal(error.detail, "HTTP 500: STT settings unavailable");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("STT connection test saves the current form and identifies the active runtime", () => {
  const section = readFileSync(
    fileURLToPath(new URL("../../../agent-ui/src/pages/settings/SttSection.tsx", import.meta.url)),
    "utf8",
  );
  const desktopService = readFileSync(
    fileURLToPath(new URL("../../src/lib/stt/desktopSttSettingsService.ts", import.meta.url)),
    "utf8",
  );
  const settingsPage = readFileSync(
    fileURLToPath(new URL("../../../agent-ui/src/pages/settings/SettingsPage.tsx", import.meta.url)),
    "utf8",
  );
  // Chinese settings copy: the core table plus the lazily loaded settings namespace.
  const zhCNSettings = [
    "../../../agent-ui/src/i18n/translations/zhCNSettings.ts",
    "../../../agent-ui/src/i18n/namespaces/settingsZhCN.ts",
  ]
    .map((file) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"))
    .join("\n");
  const webService = readFileSync(
    fileURLToPath(
      new URL(
        "../../../agent-gateway/web/src/lib/stt/webSttSettingsService.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const gatewayView = readFileSync(
    fileURLToPath(
      new URL("../../../agent-gateway/web/src/app/GatewayAppView.tsx", import.meta.url),
    ),
    "utf8",
  );
  const desktopChatPage = readFileSync(
    fileURLToPath(new URL("../../src/pages/ChatPage.tsx", import.meta.url)),
    "utf8",
  );
  const desktopApp = readFileSync(
    fileURLToPath(new URL("../../src/App.tsx", import.meta.url)),
    "utf8",
  );
  const composerBar = readFileSync(
    fileURLToPath(
      new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url),
    ),
    "utf8",
  );
  const webSettingsSync = readFileSync(
    fileURLToPath(
      new URL(
        "../../../agent-gateway/web/src/app/hooks/useGatewaySettingsSync.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  assert.match(section, /if \(!\(await save\(\)\)\) return;/);
  assert.match(section, /<SettingsSection\s+title=\{t\("settings\.groupGeneral"\)\}/);
  assert.match(section, /title=\{t\("settings\.stt\.enable"\)\}/);
  assert.match(zhCNSettings, /"settings\.stt\.enable": "开启语音输入"/);
  assert.doesNotMatch(section, />语音输入<\/h3>/);
  assert.doesNotMatch(section, /语音转文字/);
  assert.match(zhCNSettings, /"settings\.navStt": "语音输入"/);
  assert.doesNotMatch(zhCNSettings, /语音转文字/);
  assert.match(section, /t\("settings\.stt\.saveAndTest"\)/);
  assert.match(zhCNSettings, /"settings\.stt\.saveAndTest": "保存并测试连接"/);
  assert.match(
    section,
    /t\("settings\.stt\.runtime"\)\.replace\(\s*"\{runtime\}",\s*t\(RUNTIME_LABEL_KEYS\[service\.runtime\]\),?\s*\)/,
  );
  assert.match(section, /desktop: "settings\.stt\.runtimeDesktop"/);
  assert.match(section, /webui: "settings\.stt\.runtimeWebui"/);
  assert.match(
    section,
    /import "@liveagent\/ui\/i18n\/namespaces\/settings";/,
  );
  assert.match(section, /fields: \["websocketUrl", "model", "apiKey"\]/);
  assert.match(
    section,
    /fields: \["appId", "engineModelType", "secretId", "secretKey"\]/,
  );
  assert.match(
    section,
    /fields: \["websocketUrl", "appId", "accessToken", "resourceId"\]/,
  );
  assert.match(
    section,
    /fields: \["websocketUrl", "baiduAppId", "devPid", "baiduApiKey"\]/,
  );
  assert.match(section, /provider === "tencent_cloud" \? "AppId" : "App ID"/);
  assert.doesNotMatch(section, /service\s*\.get\(\)/);
  assert.match(section, /const displayedStt = settings\.stt/);
  assert.match(section, /checked=\{displayedStt\.enabled\}/);
  assert.match(section, /stt: \{ \.\.\.previous\.stt, enabled, allowIncomplete: true \}/);
  assert.doesNotMatch(webSettingsSync, /receivedSyncedStt/);
  assert.match(webSettingsSync, /const stt = await webSttSettingsService\.get\(\)/);
  assert.match(
    webSettingsSync,
    /if \(!cancelled && liveSyncEpochRef\.current === sttEpoch\)/,
  );
  assert.match(webSettingsSync, /if \(liveSyncEpochRef\.current === 0\)/);
  assert.match(webSettingsSync, /persistWebSettings\(next\)/);
  assert.doesNotMatch(
    webSettingsSync,
    /queueSettingsSave\(prev, next, "同步桌面端设置失败。", false\)/,
  );
  assert.match(desktopService, /runtime: "desktop"/);
  assert.match(desktopService, /secretRevealMode: "value"/);
  assert.match(desktopService, /settings_reveal_stt_secret/);
  assert.match(webService, /runtime: "webui"/);
  // Runtime labels and request failures are translated by the page, never written in a service.
  for (const service of [desktopService, webService]) {
    assert.doesNotMatch(service, /[\u3400-\u9fff]/);
    assert.doesNotMatch(service, /runtimeLabel:/);
  }
  assert.match(webService, /secretRevealMode: "field-name"/);
  assert.match(section, /toggleSecretVisibility/);
  assert.match(section, /const SAVED_SECRET_MASK = "saved-secret-placeholder"/);
  assert.match(section, /selectedProvider: SttProviderId/);
  assert.match(section, /onSelectedProviderChange\(id\)/);
  assert.match(settingsPage, /const \[sttSelectedProvider, setSttSelectedProvider\]/);
  assert.match(settingsPage, /STT_SELECTED_PROVIDER_CACHE = new WeakMap/);
  assert.match(settingsPage, /STT_SELECTED_PROVIDER_CACHE\.set\(sttSettingsService, provider\)/);
  assert.match(settingsPage, /selectedProvider=\{sttSelectedProvider\}/);
  assert.match(settingsPage, /onSelectedProviderChange=\{handleSttProviderChange\}/);
  assert.match(section, /setDraftProviders/);
  assert.doesNotMatch(section, /volcengine_v2/);
  assert.doesNotMatch(section, /火山引擎实时语音识别 v2/);
  assert.match(section, /labelKey: "settings\.stt\.provider\.volcengine_seed_v3"/);
  assert.match(
    zhCNSettings,
    /"settings\.stt\.provider\.volcengine_seed_v3": "火山引擎实时语音识别"/,
  );
  assert.ok(section.indexOf('id: "tencent_cloud"') < section.indexOf('id: "volcengine_seed_v3"'));
  assert.ok(section.indexOf('id: "volcengine_seed_v3"') < section.indexOf('id: "aliyun_dashscope"'));
  assert.ok(section.indexOf('id: "aliyun_dashscope"') < section.indexOf('id: "baidu_cloud"'));
  assert.doesNotMatch(section, />保存配置</);
  assert.match(section, /onClick=\{\(\) => void clearProviderSecrets\(\)\}/);
  assert.match(section, /clearSecrets: true/);
  const selectProviderBlock = section.slice(
    section.indexOf("const selectProvider"),
    section.indexOf("const save"),
  );
  assert.doesNotMatch(selectProviderBlock, /setSettings/);
  const saveBlock = section.slice(section.indexOf("const save ="), section.indexOf("const clearProviderSecrets"));
  assert.match(saveBlock, /delete nextProvider\.clearSecrets/);
  assert.match(
    gatewayView,
    /settings\.stt\.enabled\s*\?\s*\(\s*sttProviderOverride\s*\?\?\s*settings\.stt\.provider\s*\?\?\s*"tencent_cloud"\s*\)\s*:\s*null/,
  );
  assert.match(gatewayView, /onSttProviderChange=\{setSttProviderOverride\}/);
  assert.match(gatewayView, /setSttProviderOverride\(null\)/);
  assert.doesNotMatch(gatewayView, /settings\.stt\.providers\[settings\.stt\.provider\]\.configured/);
  assert.match(
    desktopChatPage,
    /settings\.stt\.enabled\s*\?\s*\(\s*sttProviderOverride\s*\?\?\s*settings\.stt\.provider\s*\?\?\s*"tencent_cloud"\s*\)\s*:\s*null/,
  );
  assert.match(desktopChatPage, /sttProviderOverride/);
  assert.match(desktopApp, /sttProviderOverride=\{sttProviderOverride\}/);
  assert.match(desktopApp, /onSttProviderChange=\{setSttProviderOverride\}/);
  assert.match(desktopApp, /setSttProviderOverride\(null\)/);
  assert.match(desktopChatPage, /sttSessionKey:\s*currentConversationId/);
  assert.match(desktopChatPage, /sttSessionKey:\s*conversationId/);
  assert.match(gatewayView, /sttSessionKey=\{displayedConversationId\}/);
  assert.match(desktopChatPage, /sttProviderConfigured:/);
  assert.doesNotMatch(
    desktopChatPage,
    /settings\.stt\.providers\[settings\.stt\.provider\]\.configured/,
  );
  assert.match(desktopChatPage, /onSttError:\s*handleSttError/);
  assert.match(gatewayView, /onSttError=\{handleSttError\}/);
  assert.match(gatewayView, /sttProviderConfigured=/);
  assert.match(composerBar, /onError: onSttError/);
  assert.match(composerBar, /onConfigurationRequired: handleSttConfigurationRequired/);
  assert.match(composerBar, /id: "stt-provider-configuration-incomplete"/);
  assert.match(composerBar, /duration: 8_000/);
  assert.match(composerBar, /onOpenSettings\("stt"\)/);
  assert.match(composerBar, /providerConfigured: sttProviderConfigured/);
  assert.match(composerBar, /sessionKey: sttSessionKey/);
  assert.match(composerBar, /hidden,/);
  assert.doesNotMatch(composerBar, /stt\.error \? \(/);
  const composerStt = readFileSync(
    fileURLToPath(new URL("../../../agent-ui/src/pages/chat/useComposerStt.ts", import.meta.url)),
    "utf8",
  );
  assert.match(composerStt, /t\("chat\.stt\.error\.providerIncomplete"\)/);
  assert.doesNotMatch(composerStt, /"[^"\n]*[\u3400-\u9fff][^"\n]*"/);
  assert.match(composerStt, /resetSilenceClock/);
  assert.match(composerStt, /abortActiveSession/);
  assert.match(composerStt, /if \(!current\?\.ready \|\| current\.stopping\) return;/);
  assert.match(composerStt, /if \(active\.stopping\) \{/);
  assert.match(composerStt, /STT_SEND_QUEUE_TIMEOUT_MS/);
  assert.doesNotMatch(
    composerBar,
    /disabled=\{isInputDisabled \|\| stt\.state === "stopping"\}/,
  );
});
