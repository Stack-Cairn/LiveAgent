import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chatPageSource = readFileSync(
  new URL("../../src/pages/ChatPage.tsx", import.meta.url),
  "utf8",
);
const applicationViewSource = readFileSync(
  new URL("../../../agent-ui/src/application/ApplicationView.tsx", import.meta.url),
  "utf8",
);
const chromeSource = readFileSync(
  new URL("../../../agent-ui/src/application/AppWorkbenchChrome.tsx", import.meta.url),
  "utf8",
);
const headerSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ChatHeader.tsx", import.meta.url),
  "utf8",
);
const conversationViewTabsSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ConversationViewTabs.tsx", import.meta.url),
  "utf8",
);
const commonComponentsCss = readFileSync(
  new URL("../../../agent-ui/src/styles/common-components.css", import.meta.url),
  "utf8",
);
const rightDockPanelSource = readFileSync(
  new URL("../../../agent-ui/src/components/project-tools/RightDockPanel.tsx", import.meta.url),
  "utf8",
);
const rightDockWidthSource = readFileSync(
  new URL(
    "../../../agent-ui/src/components/project-tools/useRightDockPanelWidth.ts",
    import.meta.url,
  ),
  "utf8",
);
const conversationSurfaceSource = readFileSync(
  new URL("../../src/pages/chat/surfaces/ConversationSurface.tsx", import.meta.url),
  "utf8",
);
const conversationPaneHostSource = readFileSync(
  new URL("../../src/pages/chat/surfaces/ConversationPaneHost.tsx", import.meta.url),
  "utf8",
);
const conversationPaneEnvironmentSource = readFileSync(
  new URL(
    "../../src/pages/chat/surfaces/ConversationPaneHostEnvironment.tsx",
    import.meta.url,
  ),
  "utf8",
);
const conversationPaneHarnessSource = readFileSync(
  new URL("../../src/pages/chat/workbench/ConversationPaneHarness.tsx", import.meta.url),
  "utf8",
);
const conversationPaneHarnessModelSource = readFileSync(
  new URL(
    "../../src/pages/chat/workbench/conversationPaneHarnessModel.ts",
    import.meta.url,
  ),
  "utf8",
);

test("application chrome is attached to the center column instead of the right dock", () => {
  assert.match(chatPageSource, /data-app-frame="three-column"/);
  assert.match(
    chatPageSource,
    /data-app-frame-column="main"[\s\S]*?<AppWorkbenchChrome[\s\S]*?<ApplicationView/,
  );
  assert.match(chatPageSource, /<AppWorkbenchChrome/);
  assert.ok(chatPageSource.indexOf("<AppWorkbenchChrome") < chatPageSource.indexOf("<ApplicationView"));
  assert.ok(chatPageSource.indexOf("<ApplicationView") < chatPageSource.indexOf("<RightDockPanel"));
  assert.doesNotMatch(applicationViewSource, /ChatHeader|headerOverlay|headerClassName/);
  assert.match(chromeSource, /layer-panel pointer-events-none relative h-12 shrink-0/);
  assert.doesNotMatch(chromeSource, /absolute inset-x-0 top-0/);
  assert.doesNotMatch(chromeSource, /left-\[272px\]|right-0/);
  assert.match(
    chatPageSource,
    /data-app-frame-column="main"[\s\S]*?className="relative flex flex-col min-h-0/,
  );
  assert.doesNotMatch(chromeSource, /autoHideActions/);
  assert.doesNotMatch(headerSource, /autoHideActions|app-workbench-chrome-actions/);
  assert.doesNotMatch(commonComponentsCss, /\.app-workbench-chrome-actions/);
});

test("conversation view switcher lives in the chrome and waits for an assistant reply", () => {
  const chromeIndex = chatPageSource.indexOf("<AppWorkbenchChrome");
  const tabsIndex = chatPageSource.indexOf("<ConversationViewTabs");
  const applicationViewIndex = chatPageSource.indexOf("<ApplicationView");

  assert.ok(chromeIndex >= 0);
  assert.ok(tabsIndex > chromeIndex);
  assert.ok(tabsIndex < applicationViewIndex);
  assert.equal(chatPageSource.match(/<ConversationViewTabs/g)?.length, 1);
  assert.match(headerSource, /leadingActions\?: ReactNode/);
  assert.match(headerSource, /<PanelLeft[\s\S]*?\{leadingActions\}/);
  assert.match(
    chatPageSource,
    /const hasConversationReply =[\s\S]*?!isDraftConversation &&[\s\S]*?trajectoryMessages\.some\(\(message\) => message\.role === "assistant"\)/,
  );
  assert.match(chatPageSource, /activeView === "chat" && hasConversationReply/);
  assert.match(
    chatPageSource,
    /useConversationViewState\(currentConversationId\)/,
  );
  assert.doesNotMatch(chatPageSource, /useState<ConversationViewId>/);
  assert.match(conversationViewTabsSource, /MessageSquareText, Waypoints/);
  assert.match(conversationViewTabsSource, /icon: MessageSquareText/);
  assert.match(conversationViewTabsSource, /icon: Waypoints/);
});

test("multi-pane conversation panes reveal trajectory and close controls together", () => {
  const paneChromeSource = readFileSync(
    new URL("../../../agent-ui/src/components/workbench/PaneChrome.tsx", import.meta.url),
    "utf8",
  );
  // The toggle is a top-left dot styled exactly like the top-right close dot.
  assert.match(paneChromeSource, /data-workbench-pane-trajectory-toggle/);
  assert.match(
    paneChromeSource,
    /left-1\.5 top-1\/2 flex h-3\.5 w-3\.5 -translate-y-1\/2 items-center justify-center rounded-full/,
  );
  assert.match(
    paneChromeSource,
    /right-1\.5 top-1\/2 flex h-3\.5 w-3\.5 -translate-y-1\/2 items-center justify-center rounded-full/,
  );
  // Both dots share the hover-reveal treatment and palette.
  assert.equal(
    paneChromeSource.match(/bg-muted-foreground\/25 text-background/g)?.length,
    2,
  );
  // Every conversation pane mounts its own toggle. Focus only selects the pane;
  // it must not remove the left control while the right close control remains.
  assert.match(
    chatPageSource,
    /trajectoryToggle=\{[\s\S]*?surface\.kind === "conversation"[\s\S]*?setConversationView\([\s\S]*?surface\.conversationId/,
  );
  assert.doesNotMatch(chatPageSource, /const showTrajectoryToggle/);
  assert.doesNotMatch(
    chatPageSource,
    /trajectoryToggle=\{[\s\S]{0,240}context\.isFocused/,
  );
  // Multi-pane hides the chrome-level tabs; the pane dot owns the switch.
  assert.match(
    chatPageSource,
    /activeView === "chat" && hasConversationReply && !workbenchHasMultiplePanes/,
  );
  assert.match(
    chatPageSource,
    /workbenchHasMultiplePanes =\s*sessionWorkbench\.enabled && Object\.keys\(workbench\.layout\.panes\)\.length >= 2/,
  );
  assert.match(chatPageSource, /viewForConversation\(conversationId\) === "trajectory"/);
  assert.match(chatPageSource, /active: paneTrajectoryActive/);
  assert.match(chatPageSource, /<ConversationTrajectorySurface/);
  assert.match(conversationPaneHostSource, /trajectory\?\.renderContent\(snapshot\)/);
});

test("closing a conversation pane resets its trajectory projection", () => {
  assert.match(
    chatPageSource,
    /const handleWorkbenchClosePane =[\s\S]*?const pane = workbench\.layoutRef\.current\.panes\[paneId\];[\s\S]*?workbench\.closePane\(paneId\);[\s\S]*?pane\?\.surface\.kind === "conversation"[\s\S]*?!workbench\.layoutRef\.current\.panes\[paneId\][\s\S]*?setConversationView\(pane\.surface\.conversationId, "conversation"\)/,
  );
  assert.match(
    chatPageSource,
    /if \(!item && conversationPersistenceCursorRef\.current\.has\(conversationId\)\) \{\s*handleWorkbenchClosePane\(pane\.paneId\);/,
  );
});

test("right dock width moves the center-column chrome with the panel", () => {
  assert.match(
    rightDockPanelSource,
    /transition-\[width,opacity,transform\] duration-200 ease-out/,
  );
  assert.match(
    rightDockWidthSource,
    /setWidthCollapsed\(true\);\s*const timer = window\.setTimeout\(\(\) => \{\s*setShouldRenderContent\(false\);/,
  );
  assert.match(
    rightDockPanelSource,
    /\(isResizing \|\| \(collapseImmediately && !isOpen\)\) && "md:transition-none"/,
  );
});

test("conversation transcript and composer share one stable workbench surface", () => {
  assert.match(chatPageSource, /<ConversationPaneHost/);
  assert.match(chatPageSource, /<ConversationPaneHostEnvironmentProvider/);
  assert.match(chatPageSource, /conversationId=\{currentConversationId\}/);
  assert.match(chatPageSource, /project=\{conversationSurfaceProject\}/);
  assert.doesNotMatch(chatPageSource, /<ChatTranscript|<ChatComposerBar/);
  assert.doesNotMatch(conversationPaneHostSource, /controller:\s*ConversationSurfaceController/);
  assert.match(conversationPaneHostSource, /useConversationPaneBinding/);
  assert.match(conversationPaneEnvironmentSource, /resolvePane\(identity: ConversationPaneIdentity\)/);
  assert.match(conversationSurfaceSource, /useConversationSurfaceSnapshot\(controller\)/);
  assert.match(conversationPaneHostSource, /const composerRef = useRef/);
  assert.match(conversationPaneHostSource, /const scrollFollowRef = useRef/);
  assert.match(conversationPaneHostSource, /controllerRef\.current\.getSnapshot\(\)\.draft/);
  assert.match(conversationPaneHostSource, /controllerRef\.current\.setDraft\(nextDraft\)/);
  assert.match(conversationPaneHostSource, /<ChatTranscript/);
  assert.match(conversationPaneHostSource, /<ChatComposerBar/);
  assert.match(conversationPaneHostSource, /pendingUploadedFiles=\{snapshot\.uploads\}/);
  assert.match(conversationPaneHostSource, /approvals=\{snapshot\.approvals\}/);
  assert.match(conversationPaneHostSource, /snapshot\.queue\.map/);
  assert.match(conversationPaneHostSource, /<ConversationSurface/);
  assert.match(conversationSurfaceSource, /data-workbench-surface="conversation"/);
  assert.match(conversationSurfaceSource, /snapshot\.conversationId/);
  assert.doesNotMatch(conversationSurfaceSource, /data-file-upload-drop-zone/);
  assert.match(conversationSurfaceSource, /data-workbench-surface-id=/);
  assert.match(conversationSurfaceSource, /data-conversation-transcript/);
  assert.match(conversationSurfaceSource, /data-conversation-composer/);
  assert.match(conversationSurfaceSource, /relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden/);
});

test("development harness mounts two identity-only conversation pane hosts", () => {
  assert.match(conversationPaneHarnessSource, /data-conversation-pane-harness="two-pane"/);
  assert.match(conversationPaneHarnessSource, /readonly \[ConversationPaneHarnessSpec, ConversationPaneHarnessSpec\]/);
  assert.match(conversationPaneHarnessSource, /panes\.map/);
  assert.match(conversationPaneHarnessSource, /<ConversationPaneHost/);
  assert.match(conversationPaneHarnessModelSource, /cannot mount one editable conversation twice/);
  assert.doesNotMatch(conversationPaneHarnessSource, /ChatTranscript|ChatComposerBar/);
});
