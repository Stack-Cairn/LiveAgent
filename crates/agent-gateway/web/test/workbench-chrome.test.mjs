import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gatewayAppViewSource = readFileSync(
  new URL("../src/app/GatewayAppView.tsx", import.meta.url),
  "utf8",
);
const webStyleClassesSource = readFileSync(
  new URL("../src/lib/webStyleClasses.ts", import.meta.url),
  "utf8",
);
const composerSource = readFileSync(
  new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url),
  "utf8",
);
const sidebarSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ChatHistorySidebar.tsx", import.meta.url),
  "utf8",
);

test("gateway mounts workbench chrome outside the shared application view", () => {
  assert.match(gatewayAppViewSource, /<main className=\{GATEWAY_MAIN_SHELL_CLASS\}>/);
  const mainClass = webStyleClassesSource.match(/GATEWAY_MAIN_SHELL_CLASS\s*=\s*\n?\s*"([^"]+)"/);
  assert.ok(mainClass, "gateway-main-shell class constant not found");
  const mainClassNames = new Set(mainClass[1].split(/\s+/));
  for (const className of [
    "relative",
    "flex",
    "h-full",
    "min-w-0",
    "flex-1",
    "flex-col",
    "items-stretch",
    "overflow-hidden",
  ]) {
    assert.ok(
      mainClassNames.has(className),
      `gateway-main-shell is missing ${className}`,
    );
  }
  assert.match(
    gatewayAppViewSource,
    /<AppWorkbenchChrome[\s\S]*?<ApplicationView/,
  );
  assert.doesNotMatch(gatewayAppViewSource, /chat=\{\{[\s\S]*?headerOverlay:/);
});

test("gateway shows the conversation view switcher in chrome only after an assistant reply", () => {
  const chromeIndex = gatewayAppViewSource.indexOf("<AppWorkbenchChrome");
  const tabsIndex = gatewayAppViewSource.indexOf("<ConversationViewTabs");
  const applicationViewIndex = gatewayAppViewSource.indexOf("<ApplicationView");

  assert.ok(chromeIndex >= 0);
  assert.ok(tabsIndex > chromeIndex);
  assert.ok(tabsIndex < applicationViewIndex);
  assert.equal(gatewayAppViewSource.match(/<ConversationViewTabs/g)?.length, 1);
  assert.match(
    gatewayAppViewSource,
    /const hasConversationReply =[\s\S]*?displayedConversationId !== "" &&[\s\S]*?!isLocalDraftConversationId\(displayedConversationId\)[\s\S]*?trajectoryMessages\.some\(\(message\) => message\.role === "assistant"\)/,
  );
  assert.match(gatewayAppViewSource, /activeView === "chat" && hasConversationReply/);
  assert.match(
    gatewayAppViewSource,
    /useConversationViewState\(displayedConversationId\)/,
  );
  assert.doesNotMatch(gatewayAppViewSource, /useState<ConversationViewId>/);
  assert.match(
    gatewayAppViewSource,
    /hidden=\{renderedConversationView === "trajectory"\}/,
  );
  assert.match(
    composerSource,
    /hidden && "hidden"/,
  );
});

test("web composer column clamps the clarify panel so new turns scroll inside it", () => {
  // 输入层 absolute 贴底、聊天区 overflow-hidden：面板 max-h-[40vh] 在矮 Pane
  // 里可能还没触顶就被外层裁掉，内部 overflow-y-auto 永不生效。列必须是
  // 有上限的 flex 列，并允许 [data-clarify-panel] 收缩。
  assert.match(
    composerSource,
    /gateway-composer-layer[^"\n]*max-h-full/,
  );
  assert.match(
    composerSource,
    /gateway-chat-column[^"\n]*flex[^"\n]*min-w-0[^"\n]*max-h-full[^"\n]*flex-col[^"\n]*justify-end/,
  );
  assert.match(
    composerSource,
    /\[&_\[data-clarify-panel\]\]:min-h-0[^"\n]*\[&_\[data-clarify-panel\]\]:shrink/,
  );
});

test("mobile sidebar stays above the interactive workbench header", () => {
  assert.match(
    webStyleClassesSource,
    /max-820:\[&_\[data-app-workbench-chrome\]\]:z-\(--layer-raised\)/,
  );
  assert.match(
    sidebarSource,
    /web:max-820:z-\(--layer-panel\)/,
  );
});
