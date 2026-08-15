import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebar = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ChatHistorySidebar.tsx", import.meta.url),
  "utf8",
);
const applicationView = readFileSync(
  new URL("../../../agent-ui/src/application/ApplicationView.tsx", import.meta.url),
  "utf8",
);
const pluginHub = readFileSync(
  new URL("../../../agent-ui/src/pages/plugin-hub/PluginHubPage.tsx", import.meta.url),
  "utf8",
);
const pluginDetailModal = readFileSync(
  new URL("../../../agent-ui/src/pages/plugin-hub/PluginDetailModal.tsx", import.meta.url),
  "utf8",
);
const pluginInstallModal = readFileSync(
  new URL("../../../agent-ui/src/pages/plugin-hub/PluginInstallModal.tsx", import.meta.url),
  "utf8",
);
const desktopChatPage = readFileSync(new URL("../../src/pages/ChatPage.tsx", import.meta.url), "utf8");
const webAppView = readFileSync(
  new URL("../../../agent-gateway/web/src/app/GatewayAppView.tsx", import.meta.url),
  "utf8",
);
const webPluginClient = readFileSync(
  new URL("../../../agent-gateway/web/src/lib/plugins/client.ts", import.meta.url),
  "utf8",
);

test("Plugin Hub is directly below MCP in the shared main sidebar", () => {
  const mcpEntry = sidebar.indexOf("onOpenMcpHub?.()");
  const pluginEntry = sidebar.indexOf("onOpenPluginHub?.()");
  assert.ok(mcpEntry >= 0);
  assert.ok(pluginEntry > mcpEntry);
  assert.match(sidebar.slice(mcpEntry, pluginEntry), /MCP Hub/);
  assert.match(sidebar.slice(pluginEntry), /pluginHub\.sidebarLabel/);
});

test("desktop and WebUI render the same Plugin Hub with host-specific clients", () => {
  assert.match(applicationView, /activeView === "plugin-hub"/);
  assert.match(applicationView, /<PluginHubPage/);
  assert.match(desktopChatPage, /pluginClient=\{desktopPluginClient\}/);
  assert.match(desktopChatPage, /pluginWorkspace=\{activeWorkspaceProjectPath \|\| workdir\}/);
  assert.match(webAppView, /pluginClient=\{pluginClient\}/);
  assert.match(
    webAppView,
    /pluginWorkspace=\{displayedConversationWorkdir \|\| activeWorkspaceProjectPath\}/,
  );
});

test("Plugin Hub writes Workspace config and WebUI cannot install packages", () => {
  // 配置写入与安装选项已拆到各自的弹层，断言跟着代码走，但仍钉住同一批不变量：
  // 配置必须带 workspace + expectedRevision（乐观并发），安装绝不预授权。
  assert.match(
    pluginDetailModal,
    /client\.updateConfig\(\{[\s\S]*pluginId: item\.id,[\s\S]*workspace,[\s\S]*expectedRevision:/,
  );
  assert.match(pluginDetailModal, /item\.contributes\.settings\.length > 0/);
  assert.match(pluginInstallModal, /grantedPermissions: \[\]/);
  assert.match(pluginInstallModal, /\[grantRequested, setGrantRequested\] = useState\(false\)/);
  // 安装入口只在桌面端出现：WebUI 的 client 报 canInstall:false。
  assert.match(pluginHub, /client\.canInstall !== false/);
  assert.match(webPluginClient, /canInstall: false/);
  assert.match(webPluginClient, /WebUI 不允许远程安装插件/);
  assert.doesNotMatch(webPluginClient, /pluginManage\([^)]*["']install["']/);
});

test("Plugin Hub surfaces trust level and grant gaps as readable text", () => {
  // 信任级别与缺授权是这个界面最该被看见的安全事实，不能只靠图标或颜色表达。
  const presentation = readFileSync(
    new URL("../../../agent-ui/src/pages/plugin-hub/pluginPresentation.ts", import.meta.url),
    "utf8",
  );
  for (const key of ["trust.fullTrust", "trust.unsigned", "trust.verified"]) {
    assert.match(presentation, new RegExp(`pluginHub\\.${key.replace(".", "\\.")}`));
  }
  const pluginCard = readFileSync(
    new URL("../../../agent-ui/src/pages/plugin-hub/PluginCard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(pluginCard, /trust\.label/);
  assert.match(pluginCard, /pluginHub\.missingGrants/);
});
