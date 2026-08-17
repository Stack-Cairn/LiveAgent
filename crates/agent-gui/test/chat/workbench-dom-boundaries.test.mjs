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
  assert.match(chatPageSource, /<ConversationSurface/);
  assert.match(conversationSurfaceSource, /data-workbench-surface="conversation"/);
  assert.doesNotMatch(conversationSurfaceSource, /data-file-upload-drop-zone/);
  assert.match(conversationSurfaceSource, /data-workbench-surface-id=/);
  assert.match(conversationSurfaceSource, /data-conversation-transcript/);
  assert.match(conversationSurfaceSource, /data-conversation-composer/);
  assert.match(conversationSurfaceSource, /relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden/);
});
