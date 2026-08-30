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
  // Windows（autocrlf=true）检出下源码行尾是 CRLF，统一成 LF，保证
  // extractFunction 的 indexOf("\n}\n") 等基于 LF 的切片在任何平台可复现。
  return readFileSync(new URL(relativePath, root), "utf8").replace(/\r\n/g, "\n");
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
  // token 序列化只有 lib/chat/mentionReferences 一份实现，组件内序列化与
  // 发送路径（composerDraft）都从这里导入——不允许再出现第二份拷贝。
  const references = source(agentUiRoot, "lib/chat/mentionReferences.ts");
  assert.doesNotMatch(internals, /function formatAppMentionToken/);
  assert.match(internals, /formatAppMentionToken,/);
  const composerDraftSrc = source(agentUiRoot, "lib/chat/composerDraft.ts");
  assert.doesNotMatch(composerDraftSrc, /function formatComposerAppMention/);
  const body = extractFunction(references, "formatAppMentionToken").replace(
    /\(app: AppMentionReference\)/,
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
});

test("the popup renders apps and files as two labelled sections with real app icons", () => {
  // 应用在前、文件在后，各自独立封顶——应用分组只留一小撮（3 条），
  // 既保证 @ 首先看到应用，又不把文件结果推出视野。分组标题按第一条
  // 文件行的边界插入（仅当上方有应用行）。
  const appsLoopFirst =
    composer.indexOf("of orderedApps") < composer.indexOf("of mentionSessionSearchIndex");
  assert.ok(appsLoopFirst, "app suggestions must precede file suggestions");
  assert.match(model, /MAX_APP_SUGGESTIONS = 3/);
  assert.match(composer, /appCount >= MAX_APP_SUGGESTIONS/);
  assert.match(overlays, /firstFileIndex/);
  assert.match(overlays, /i === firstFileIndex && hasAppRows/);
  // 应用行优先渲染宿主提供的真实图标（data URL），缺失时回退占位图标。
  assert.match(overlays, /app\?\.iconDataUrl \?/);
  assert.match(overlays, /img src=\{app\.iconDataUrl\}/);
  assert.match(overlays, /<AppWindow className/);
});

test("selecting an app records it and the next @ popup ranks recents first", () => {
  // 选中即落榜单（localStorage 版本化键），下次 @ 会话开启时重读并把
  // 最近使用的应用排到分组最前；未上榜的保持宿主的字母序。
  assert.match(composer, /recordAppMentionUse\(suggestion\.app\)/);
  assert.match(composer, /sortAppsByMentionRecency\(mentionApps, readAppMentionRecents\(\)\)/);
  const recency = source(agentUiRoot, "lib/chat/appMentionRecency.ts");
  assert.match(recency, /"liveagent\.app-mention-recents\.v1"/);
  // 身份键必须复用图标注册表的同一份裁决（bundle id > path > name），
  // 不允许在 recency 里再维护一份优先级。
  assert.match(recency, /identityKeys\(identity\)\[0\] \?\? ""/);

  // 执行式覆盖：身份键优先级 + 最近使用排序（上榜按榜单序在前，未上榜
  // 保持入参原序）。类型注解在求值前剥掉。
  const icons = source(agentUiRoot, "lib/chat/appMentionIcons.ts");
  const identityKeysFn = extractFunction(icons, "identityKeys")
    .replace(/\(identity: AppMentionIconIdentity\): string\[\]/, "(identity)")
    .replace(/const keys: string\[\] = \[\];/, "const keys = [];");
  const keyFn = extractFunction(recency, "appMentionRecencyKey").replace(
    /\(identity: AppMentionRecencyIdentity\): string/,
    "(identity)",
  );
  const sortStart = recency.indexOf("function sortAppsByMentionRecency");
  assert.notEqual(sortStart, -1, "missing function sortAppsByMentionRecency");
  const sortEnd = recency.indexOf("\n}\n", sortStart);
  const sortFn = recency
    .slice(sortStart, sortEnd + 3)
    .replace(
      /function sortAppsByMentionRecency[\s\S]*?\{/,
      "function sortAppsByMentionRecency(apps, recentKeys) {",
    )
    .replace(/\(app: T\)/, "(app)");
  const { appMentionRecencyKey, sortAppsByMentionRecency } = new Function(
    `${identityKeysFn}\n${keyFn}\n${sortFn}\nreturn { appMentionRecencyKey, sortAppsByMentionRecency };`,
  )();

  assert.equal(
    appMentionRecencyKey({
      name: "Safari",
      bundleId: "com.apple.Safari",
      path: "/Applications/Safari.app",
    }),
    "bundle:com.apple.safari",
  );
  assert.equal(appMentionRecencyKey({ name: "Tool", path: "/opt/tool" }), "path:/opt/tool");
  assert.equal(appMentionRecencyKey({ name: "Tool" }), "name:tool");
  assert.equal(appMentionRecencyKey({}), "");

  const apps = [
    { name: "Arc" },
    { name: "Mail" },
    { name: "Safari", bundleId: "com.apple.Safari" },
    { name: "Terminal" },
  ];
  const sorted = sortAppsByMentionRecency(apps, ["bundle:com.apple.safari", "name:mail"]);
  assert.deepEqual(
    sorted.map((app) => app.name),
    ["Safari", "Mail", "Arc", "Terminal"],
  );
  // 入参不被就地修改。
  assert.deepEqual(
    apps.map((app) => app.name),
    ["Arc", "Mail", "Safari", "Terminal"],
  );
});

test("the chip shows the real app logo via the icon registry, never via DOM attributes", () => {
  // 图标是几 KB 的 data URL：进 chip 属性会跟着进剪贴板 JSON 与草稿序列
  // 化。所以 chip 渲染时按身份（name/bundleId/path）从进程级注册表查图，
  // 序列化载荷保持只有身份三元组；chip 重建（setDraft/粘贴）重查即复原。
  assert.match(internals, /getAppMentionIconDataUrl\(app\)/);
  assert.match(internals, /createAppMentionIcon\(app\)/);
  // 属性面固定为身份三元组——不得新增 icon 属性。
  const chipFactory = extractFunction(internals, "createAppMentionChip");
  const setAttrs = [...chipFactory.matchAll(/setAttribute\((APP_MENTION_[A-Z_]+)/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(setAttrs, [
    "APP_MENTION_NAME_ATTR",
    "APP_MENTION_BUNDLE_ID_ATTR",
    "APP_MENTION_PATH_ATTR",
  ]);
  // 注册表登记发生在宿主拉到列表时（GUI 与 WebUI 共用同一个 hook）。
  const hook = source(agentUiRoot, "lib/chat/useMentionApps.ts");
  assert.match(hook, /registerAppMentionIcons\(mapped\)/);
});

test("user bubbles tokenize app mention tokens back into chips", () => {
  const bubble = source(agentUiRoot, "lib/chat/userMessageContent.tsx");
  assert.match(bubble, /\{ type: "app"; app: AppDisplayReference \}/);
  assert.match(bubble, /<AppMentionChip key=\{key\} app=\{part\.app\} \/>/);
  assert.match(bubble, /useAppMentionIcon\(app\)/);
  // hasChip 少了 app 臂时，纯 app 提及的消息会整体走无 chip 快捷路径。
  assert.match(bubble, /part\.type === "app" \|\|/);

  // token 逆变换的语义：完整形态才识别，身份按 path 分隔符分类。
  const stripTypes = (src) =>
    src
      .replace(/\(text: string, index: number\)/g, "(text, index)")
      .replace(/ satisfies AppDisplayReference/g, "");
  const helpers = [
    stripTypes(extractFunction(bubble, "isTokenBoundary")),
    stripTypes(extractFunction(bubble, "inlineAppReferenceAt")),
  ].join("\n");
  const inlineAppReferenceAt = new Function(`${helpers}; return inlineAppReferenceAt;`)();
  assert.deepEqual(inlineAppReferenceAt('app "Safari" (com.apple.Safari)', 0)?.app, {
    name: "Safari",
    bundleId: "com.apple.Safari",
    path: undefined,
  });
  assert.deepEqual(inlineAppReferenceAt('app "Tool" (/opt/tool)', 0)?.app, {
    name: "Tool",
    bundleId: undefined,
    path: "/opt/tool",
  });
  // 裸 `app "Name"` 是自然语言常见形态，不作 token。
  assert.equal(inlineAppReferenceAt('app "Safari" is great', 0), null);
  // 非词边界不触发（避免把 "myapp \"x\" (y)" 切碎）。
  assert.equal(inlineAppReferenceAt('myapp "Safari" (com.apple.Safari)', 2), null);

  // 纯文本粘贴（剪贴板第三层）也经同一 token 还原成 chip。
  assert.match(internals, /segment\.type === "app"/);
  assert.match(internals, /type: "appMention",\s*app: normalizeAppMention\(/);
});

test("the send path serializes appMention segments in both draft pipelines", () => {
  // buildDraft（组件内）与 buildTextFromComposerDraft（发送路径）各有一份
  // 序列化，两边都必须有 app 臂。
  assert.match(composer, /appMentions\.push\(segment\.app\)/);
  const composerDraft = source(agentUiRoot, "lib/chat/composerDraft.ts");
  assert.match(
    composerDraft,
    /if \(segment\.type === "appMention"\) return formatAppMentionToken\(segment\.app\);/,
  );
  assert.match(composerDraft, /appMentions: \[\],/);
  const paneSend = source(guiRoot, "pages/chat/surfaces/paneComposerSend.ts");
  assert.match(paneSend, /appMentions: \[\],/);
});

test("both hosts gate apps by the cua-driver identity ruling via the shared hook", () => {
  const hook = source(agentUiRoot, "lib/chat/useMentionApps.ts");
  // 门控必须走 contracts 的同一份判定（按 id 或 command），不得自己
  // 比较字符串——否则会与审批缺省/自指闸门的裁决错位。
  assert.match(hook, /isCuaDriverServer\(server\)/);
  assert.match(hook, /from "@liveagent\/ui\/contracts\/mcpServerDefaults"/);
  assert.match(hook, /cua_driver_list_installed_apps/);
  // invoke 必须经 @liveagent/app shim 解析：GUI 直连 Tauri 命令，WebUI
  // 由 shim 把同名命令经 Gateway 直通中继到桌面宿主。hook 自身不得
  // import @tauri-apps——那会把共享包焊死在桌面端。
  assert.match(hook, /from "@liveagent\/app\/shims\/tauriCore"/);
  assert.doesNotMatch(hook, /@tauri-apps/);
  const chatPage = source(guiRoot, "pages/ChatPage.tsx");
  assert.match(chatPage, /useMentionApps\(activeWorkspaceResources\.mcpServers, isAgentMode\)/);
  // WebUI 接线：门控入参同源（agent 模式 + 工作区 mcpServers），列表
  // 传入 composer；列出的是已连接桌面宿主的应用（cua 工具操作桌面）。
  const gatewayApp = readFileSync(
    new URL("../../../agent-gateway/web/src/app/GatewayApp.tsx", import.meta.url),
    "utf8",
  );
  assert.match(gatewayApp, /useMentionApps\(workspaceResources\.mcpServers, isAgentMode\)/);
  const gatewayView = readFileSync(
    new URL("../../../agent-gateway/web/src/app/GatewayAppView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(gatewayView, /mentionApps=\{mentionApps\}/);
});

test("the gateway relays installed apps as a vetted pass-through frame", () => {
  // 直通链路：proto 臂（编号只增不改）→ Go 白名单 → 桌面分发与 bridge
  // → WebUI shim 复用 GUI 的同名 invoke 命令。少一环 WebUI 的应用分组
  // 就静默消失，所以每一环都铺点。
  const proto = readFileSync(
    new URL("../../../agent-gateway/proto/v2/gateway.proto", import.meta.url),
    "utf8",
  );
  assert.match(proto, /InstalledAppsListRequest installed_apps_list = 100;/);
  assert.match(proto, /InstalledAppsListResponse installed_apps_list_resp = 105;/);
  const guard = readFileSync(
    new URL("../../../agent-gateway/internal/protocol/pbws/guard.go", import.meta.url),
    "utf8",
  );
  assert.match(guard, /GatewayEnvelope_InstalledAppsList/);
  const envelope = source(tauriRoot, "services/gateway/envelope_handler.rs");
  assert.match(envelope, /Payload::InstalledAppsList/);
  assert.match(envelope, /InstalledAppsListResp/);
  const bridge = source(tauriRoot, "services/gateway_bridge.rs");
  assert.match(bridge, /handle_installed_apps_list/);
  const shim = readFileSync(
    new URL("../../../agent-gateway/web/src/shims/tauriCore.ts", import.meta.url),
    "utf8",
  );
  assert.match(shim, /case "cua_driver_list_installed_apps":/);
  assert.match(shim, /listInstalledApps\(\)/);
});

test("the Rust command excludes the host on every platform and is registered", () => {
  const service = source(tauriRoot, "services/cua_driver/installed_apps.rs");
  // macOS 按宿主 bundle id 剔除；Windows 没有 bundle id，按当前进程的
  // exe 路径剔除——两条路都必须在，缺一条宿主就会出现在自己的候选里。
  assert.match(service, /eq_ignore_ascii_case\(exclude_bundle_id\)/);
  assert.match(service, /std::env::current_exe\(\)/);
  assert.match(service, /list_windows_apps/);
  // Windows 身份由 path 承担：bundle_id 留空，经前端映射为 undefined。
  assert.match(service, /bundle_id: String::new\(\)/);
  const command = source(tauriRoot, "commands/integration/cua_driver.rs");
  assert.match(command, /app\.config\(\)\.identifier\.clone\(\)/);
  const lib = source(tauriRoot, "lib.rs");
  assert.match(lib, /commands::cua_driver::cua_driver_list_installed_apps,/);
});
