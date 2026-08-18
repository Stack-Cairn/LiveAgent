import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gatewayAppViewSource = readFileSync(
  new URL("../src/app/GatewayAppView.tsx", import.meta.url),
  "utf8",
);
const baseChatStyles = readFileSync(
  new URL("../src/styles/base-chat.css", import.meta.url),
  "utf8",
);

test("gateway mounts workbench chrome outside the shared application view", () => {
  assert.match(gatewayAppViewSource, /<main className="gateway-main-shell">/);
  assert.match(
    gatewayAppViewSource,
    /<AppWorkbenchChrome[\s\S]*?<ApplicationView/,
  );
  assert.doesNotMatch(gatewayAppViewSource, /chat=\{\{[\s\S]*?headerOverlay:/);
  assert.match(baseChatStyles, /\.gateway-main-shell \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/);
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
    /if \(!hasConversationReply && activeConversationView !== "conversation"\)/,
  );
  assert.match(
    gatewayAppViewSource,
    /hidden=\{renderedConversationView === "trajectory"\}/,
  );
  assert.match(
    baseChatStyles,
    /\.gateway-composer-layer\.hidden\s*\{\s*display: none;\s*\}/,
  );
});
