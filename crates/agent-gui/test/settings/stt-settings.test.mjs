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
  const zhCNSettings = readFileSync(
    fileURLToPath(
      new URL("../../../agent-ui/src/i18n/translations/zhCNSettings.ts", import.meta.url),
    ),
    "utf8",
  );
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
  assert.match(section, />语音输入<\/h3>/);
  assert.doesNotMatch(section, /语音转文字/);
  assert.match(zhCNSettings, /"settings\.navStt": "语音输入"/);
  assert.doesNotMatch(zhCNSettings, /语音转文字/);
  assert.match(section, /保存并测试连接/);
  assert.match(section, /当前运行端：\{service\.runtimeLabel\}/);
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
  assert.match(section, /delete next\[definition\.id\]/);
  assert.doesNotMatch(section, /service\s*\.get\(\)/);
  assert.match(section, /const displayedStt = settings\.stt/);
  assert.match(section, /checked=\{displayedStt\.enabled\}/);
  assert.match(section, /stt: \{ \.\.\.previous\.stt, enabled, allowIncomplete: true \}/);
  assert.match(section, /className="w-full min-w-0 space-y-5"/);
  assert.doesNotMatch(webSettingsSync, /receivedSyncedStt/);
  assert.match(webSettingsSync, /const stt = await webSttSettingsService\.get\(\)/);
  assert.match(webSettingsSync, /if \(!cancelled\) applyGatewaySettings\(\{ stt \}\)/);
  assert.match(webSettingsSync, /persistWebSettings\(next\)/);
  assert.doesNotMatch(
    webSettingsSync,
    /queueSettingsSave\(prev, next, "同步桌面端设置失败。", false\)/,
  );
  assert.match(desktopService, /runtimeLabel: "桌面端（同步到 Gateway WebUI）"/);
  assert.match(desktopService, /secretRevealMode: "value"/);
  assert.match(desktopService, /settings_reveal_stt_secret/);
  assert.match(webService, /runtimeLabel: "WebUI（与桌面端同步，凭据由 Gateway 安全托管）"/);
  assert.match(webService, /secretRevealMode: "field-name"/);
  assert.match(section, /WebUI 的查看按钮只显示字段名/);
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
  assert.match(section, /label: "火山引擎实时语音识别"/);
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
    /settings\.stt\.enabled \? \(settings\.stt\.provider \?\? "tencent_cloud"\) : null/,
  );
  assert.doesNotMatch(gatewayView, /sttProviderOverride/);
  assert.doesNotMatch(gatewayView, /onSttProviderChange=\{setSttProviderOverride\}/);
  assert.doesNotMatch(gatewayView, /settings\.stt\.providers\[settings\.stt\.provider\]\.configured/);
  assert.match(
    desktopChatPage,
    /settings\.stt\.enabled \? \(settings\.stt\.provider \?\? "tencent_cloud"\) : null/,
  );
  assert.doesNotMatch(desktopChatPage, /sttProviderOverride/);
  assert.match(desktopChatPage, /sttSessionKey=\{currentConversationId\}/);
  assert.match(gatewayView, /sttSessionKey=\{displayedConversationId\}/);
  assert.match(desktopChatPage, /sttProviderConfigured=/);
  assert.doesNotMatch(
    desktopChatPage,
    /settings\.stt\.providers\[settings\.stt\.provider\]\.configured/,
  );
  assert.match(desktopChatPage, /onSttError=\{handleSttError\}/);
  assert.match(gatewayView, /onSttError=\{handleSttError\}/);
  assert.match(gatewayView, /sttProviderConfigured=/);
  assert.match(composerBar, /onError: onSttError/);
  assert.match(composerBar, /providerConfigured: sttProviderConfigured/);
  assert.match(composerBar, /sessionKey: sttSessionKey/);
  assert.match(composerBar, /hidden,/);
  assert.doesNotMatch(composerBar, /stt\.error \? \(/);
  const composerStt = readFileSync(
    fileURLToPath(new URL("../../../agent-ui/src/pages/chat/useComposerStt.ts", import.meta.url)),
    "utf8",
  );
  assert.match(composerStt, /STT供应商配置不完整/);
  assert.match(composerStt, /resetSilenceClock/);
  assert.match(composerStt, /abortActiveSession/);
  assert.match(composerStt, /if \(!current\?\.ready \|\| current\.stopping\) return;/);
});
