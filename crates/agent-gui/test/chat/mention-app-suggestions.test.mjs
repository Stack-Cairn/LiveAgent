import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// @ 提及已安装应用（computer use 目标）的铺点检查：共享 composer 的
// appMention 类型必须走全 chip 生命周期（建 chip / 序列化 / 剪贴板 /
// 草稿恢复），GUI 侧的门控必须与 cua-driver 的安全裁决同源。

const chatComponentsRoot = new URL("../../../agent-ui/src/components/chat/", import.meta.url);
const agentUiRoot = new URL("../../../agent-ui/src/", import.meta.url);
const guiRoot = new URL("../../src/", import.meta.url);
const tauriRoot = new URL("../../src-tauri/src/", import.meta.url);

function source(root, relativePath) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = src.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `unterminated function ${name}`);
  return src.slice(start, end + 3);
}

const model = source(chatComponentsRoot, "MentionComposerModel.ts");
const internals = source(chatComponentsRoot, "MentionComposerInternals.tsx");
const composer = source(chatComponentsRoot, "MentionComposer.tsx");
const overlays = source(chatComponentsRoot, "MentionComposerOverlays.tsx");

test("the mention model declares the full appMention surface", () => {
  // 建议、草稿段、草稿收集列表三处都必须有 app 臂，少一处就会出现
  // "能选进编辑器但发送时丢失"或"能发送但草稿恢复丢 chip"的断层。
  assert.match(model, /\{ type: "app"; app: MentionComposerApp \}/);
  assert.match(model, /\{ type: "appMention"; app: MentionComposerAppMention \}/);
  assert.match(model, /appMentions: MentionComposerAppMention\[\];/);
  assert.match(model, /APP_MENTION_NAME_ATTR = "data-app-name"/);
  assert.match(model, /APP_MENTION_BUNDLE_ID_ATTR = "data-app-bundle-id"/);
  assert.match(model, /APP_MENTION_PATH_ATTR = "data-app-path"/);
});

test("app chips round-trip through DOM serialization and the clipboard payload", () => {
  // DOM → 草稿段
  assert.match(internals, /el\.hasAttribute\(APP_MENTION_NAME_ATTR\)/);
  // 草稿段 → 发送文本
  assert.match(
    internals,
    /if \(segment\.type === "appMention"\) return formatAppMentionToken\(segment\.app\);/,
  );
  // 私有剪贴板通道恢复
  assert.match(internals, /if \(type === "appMention"\) \{/);
  // 粘贴/setDraft 重建 chip
  assert.match(internals, /if \(segment\.type === "appMention"\) \{\s*return createAppMentionChip\(segment\.app\);/);
  // 光标原子步进/删除把 app chip 当作一个整体
  const chipGuard = extractFunction(internals, "isComposerChipElement");
  assert.match(chipGuard, /APP_MENTION_NAME_ATTR/);
});

test("the app token carries a stable identity the model can hand to CUA tools", () => {
  const body = extractFunction(internals, "formatAppMentionToken").replace(
    /\(\s*app:[\s\S]*?,\s*\)/,
    "(app)",
  );
  const formatAppMentionToken = new Function(`${body}; return formatAppMentionToken;`)();
  assert.equal(
    formatAppMentionToken({ name: "Safari", bundleId: "com.apple.Safari", path: "/Applications/Safari.app" }),
    'app "Safari" (com.apple.Safari)',
  );
  // 无 bundle id 的平台回退到安装路径，无任何身份时只留名字。
  assert.equal(
    formatAppMentionToken({ name: "Tool", bundleId: "", path: "/opt/tool" }),
    'app "Tool" (/opt/tool)',
  );
  assert.equal(formatAppMentionToken({ name: "Tool", bundleId: "", path: "" }), 'app "Tool"');
});

test("app suggestions ride the @ trigger and are host-gated by the mentionApps prop", () => {
  // 应用候选只来自 prop——composer 自己绝不能去 invoke Tauri（组件是
  // 双端共享的，WebUI 有意不接这条能力）。
  assert.match(composer, /mentionApps = \[\]/);
  assert.doesNotMatch(composer, /invoke\(["']cua_driver/);
  assert.match(composer, /next\.push\(\{ type: "app", app \}\)/);
  assert.match(composer, /insertAppMentionChip\(mentionCtx, suggestion\.app\)/);
  // 弹层为应用行给出可辨识的徽标。
  assert.match(overlays, /suggestion\.type === "app"/);
});

test("the send path serializes appMention segments in both draft pipelines", () => {
  // buildDraft（组件内）与 buildTextFromComposerDraft（发送路径）各有一份
  // 序列化，两边都必须有 app 臂。
  assert.match(composer, /appMentions\.push\(segment\.app\)/);
  const composerDraft = source(agentUiRoot, "lib/chat/composerDraft.ts");
  assert.match(
    composerDraft,
    /if \(segment\.type === "appMention"\) return formatComposerAppMention\(segment\.app\);/,
  );
  assert.match(composerDraft, /appMentions: \[\],/);
  const paneSend = source(guiRoot, "pages/chat/surfaces/paneComposerSend.ts");
  assert.match(paneSend, /appMentions: \[\],/);
});

test("GUI gating reuses the cua-driver identity ruling and stays desktop-only", () => {
  const hook = source(guiRoot, "pages/chat/hooks/useMentionApps.ts");
  // 门控必须走 contracts 的同一份判定（按 id 或 command），不得自己
  // 比较字符串——否则会与审批缺省/自指闸门的裁决错位。
  assert.match(hook, /isCuaDriverServer\(server\)/);
  assert.match(hook, /from "@liveagent\/ui\/contracts\/mcpServerDefaults"/);
  assert.match(hook, /cua_driver_list_installed_apps/);
  const chatPage = source(guiRoot, "pages/ChatPage.tsx");
  assert.match(chatPage, /useMentionApps\(activeWorkspaceResources\.mcpServers, isAgentMode\)/);
  // WebUI 有意不接：网关前端不得出现应用枚举通道。
  const gatewayView = readFileSync(
    new URL("../../../agent-gateway/web/src/app/GatewayAppView.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(gatewayView, /mentionApps/);
});

test("the Rust command excludes the host bundle and is registered", () => {
  const service = source(tauriRoot, "services/cua_driver/installed_apps.rs");
  assert.match(service, /eq_ignore_ascii_case\(exclude_bundle_id\)/);
  const command = source(tauriRoot, "commands/integration/cua_driver.rs");
  assert.match(command, /app\.config\(\)\.identifier\.clone\(\)/);
  const lib = source(tauriRoot, "lib.rs");
  assert.match(lib, /commands::cua_driver::cua_driver_list_installed_apps,/);
});
