import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const workbench = loader.loadModule("@liveagent/ui/lib/workbench/index.ts");

function pane(paneId, conversationId) {
  return {
    paneId,
    surface: {
      kind: "conversation",
      conversationId,
      project: { projectId: `p-${conversationId}`, projectPathKey: `/w/${conversationId}` },
    },
    view: {},
  };
}

function terminalPane(paneId, surfaceId) {
  return {
    paneId,
    surface: {
      kind: "localTerminal",
      surfaceId,
      project: { projectId: `p-${surfaceId}`, projectPathKey: `/w/${surfaceId}` },
      launchSpec: { cwd: `/w/${surfaceId}` },
    },
    view: {},
  };
}

function unsupportedPane(paneId) {
  return {
    paneId,
    surface: {
      kind: "unsupported",
      originalKind: "future-kind",
      raw: { kind: "future-kind" },
    },
    view: {},
  };
}

function threePaneLayout() {
  return {
    schemaVersion: workbench.WORKBENCH_LAYOUT_SCHEMA_VERSION,
    revision: 7,
    root: {
      type: "split",
      splitId: "s1",
      axis: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "pane-a" },
      second: {
        type: "split",
        splitId: "s2",
        axis: "vertical",
        ratio: 0.5,
        first: { type: "leaf", paneId: "pane-b" },
        second: { type: "leaf", paneId: "pane-c" },
      },
    },
    panes: {
      "pane-a": pane("pane-a", "conv-a"),
      "pane-b": pane("pane-b", "conv-b"),
      "pane-c": pane("pane-c", "conv-c"),
    },
    focusedPaneId: "pane-b",
  };
}

function mixedLayout() {
  const layout = threePaneLayout();
  layout.panes["pane-b"] = terminalPane("pane-b", "term-b");
  layout.panes["pane-c"] = unsupportedPane("pane-c");
  return layout;
}

test("layout validation reports a terminal cwd outside its project", () => {
  const layout = mixedLayout();
  layout.panes["pane-b"].surface.launchSpec.cwd = "/w/term-b/../../etc";
  const issues = workbench.collectWorkbenchLayoutIssues(layout);
  assert.equal(
    issues.some((entry) => entry.code === "terminal-cwd-outside-project"),
    true,
  );
  assert.equal(workbench.isWorkbenchLayoutValid(layout), false);
});

test("startup paints theme and shell before progressively hydrating pane contents", () => {
  const htmlSource = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const appStyles = readFileSync(new URL("../../src/index.css", import.meta.url), "utf8");
  const paneLoadingSource = readFileSync(
    new URL("../../src/components/app/PaneLoadingSkeleton.tsx", import.meta.url),
    "utf8",
  );
  const tauriConfigSource = readFileSync(
    new URL("../../src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  );
  const tauriMacConfigSource = readFileSync(
    new URL("../../src-tauri/tauri.macos.conf.json", import.meta.url),
    "utf8",
  );
  const appCommandSource = readFileSync(
    new URL("../../src-tauri/src/commands/app/app.rs", import.meta.url),
    "utf8",
  );
  const tauriLibSource = readFileSync(
    new URL("../../src-tauri/src/lib.rs", import.meta.url),
    "utf8",
  );
  const chatSource = readFileSync(
    new URL("../../src/pages/ChatPage.tsx", import.meta.url),
    "utf8",
  );
  const transcriptLoadingSource = readFileSync(
    new URL("../../src/pages/chat/transcript/TranscriptLoadingStates.tsx", import.meta.url),
    "utf8",
  );
  const transcriptSource = readFileSync(
    new URL("../../src/pages/chat/transcript/ChatTranscript.tsx", import.meta.url),
    "utf8",
  );
  const transcriptListSource = readFileSync(
    new URL("../../src/pages/chat/transcript/TranscriptList.tsx", import.meta.url),
    "utf8",
  );
  const historyActionsSource = readFileSync(
    new URL("../../src/pages/chat/history/useConversationHistoryActions.ts", import.meta.url),
    "utf8",
  );
  const settingsDbSource = readFileSync(
    new URL("../../src-tauri/src/commands/config/settings/db.rs", import.meta.url),
    "utf8",
  );
  const chatRuntimeHostSource = readFileSync(
    new URL("../../src/pages/chat/runtime/ChatRuntimeHost.ts", import.meta.url),
    "utf8",
  );
  const sendChatTurnSource = readFileSync(
    new URL("../../src/pages/chat/runtime/useSendChatTurn.ts", import.meta.url),
    "utf8",
  );
  const extractionControllerSource = readFileSync(
    new URL("../../src/lib/chat/memory/extractionController.ts", import.meta.url),
    "utf8",
  );
  const conversationPaneHostSource = readFileSync(
    new URL("../../src/pages/chat/surfaces/ConversationPaneHost.tsx", import.meta.url),
    "utf8",
  );

  const themeScript = htmlSource.indexOf('localStorage.getItem("liveagent.ui-settings.v1")');
  const staticShell = htmlSource.indexOf('data-static-boot-shell=""');
  const frontendReady = htmlSource.indexOf('invoke("app_frontend_ready")');
  const appScript = htmlSource.indexOf('src="/src/main.tsx"');
  assert.ok(themeScript >= 0 && themeScript < appScript);
  assert.ok(staticShell >= 0 && staticShell < appScript);
  assert.ok(frontendReady >= 0 && frontendReady < appScript);
  assert.match(htmlSource, /--liveagent-boot-background/);
  assert.match(
    htmlSource,
    /requestAnimationFrame\(\(\) => \{\s*window\.requestAnimationFrame\(\(\) => \{/,
  );
  assert.match(htmlSource, /setTimeout\(revealOnce, 250\)/);
  assert.match(tauriConfigSource, /"visible": false/);
  assert.match(tauriMacConfigSource, /"visible": false/);
  assert.match(appCommandSource, /pub fn app_frontend_ready/);
  assert.match(appCommandSource, /ready_state\.0\.store\(true, Ordering::SeqCst\)/);
  assert.match(tauriLibSource, /commands::app::app_frontend_ready/);
  assert.match(tauriLibSource, /FrontendReadyState::default/);
  assert.match(tauriLibSource, /if !ready_state\.0\.load\(Ordering::SeqCst\)/);
  assert.match(tauriLibSource, /PageLoadEvent::Started/);
  assert.match(tauriLibSource, /ready_state\.0\.store\(false, Ordering::SeqCst\)/);
  assert.match(tauriLibSource, /window\.hide\(\)/);
  assert.match(appSource, /chatPageModule \?\?= import\("\.\/pages\/ChatPage"\)/);
  assert.match(
    appSource,
    /const persistedSettingsPromise = loadPersistedSettingsWithDefaults\(\);[\s\S]{0,320}void loadChatPage\(\);[\s\S]{0,160}await persistedSettingsPromise/,
  );
  assert.match(appSource, /getBootAlignedDefaultSettings/);
  assert.match(appSource, /document\.documentElement\.classList\.contains\("dark"\)/);
  assert.doesNotMatch(appSource, /\nvoid loadChatPage\(\);/);
  assert.match(appSource, /import\("\.\/lib\/shortcuts\/globalShortcuts"\)/);
  assert.match(appSource, /import\("@liveagent\/ui\/lib\/automation\/index"\)/);
  assert.match(appSource, /backgroundHostsReady/);
  assert.match(appSource, /requestIdleCallback\(revealBackgroundHosts/);
  assert.match(chatRuntimeHostSource, /import\("\.\.\/turns\/runAgentConversationTurn"\)/);
  assert.match(chatRuntimeHostSource, /import\("\.\.\/turns\/runTextConversationTurn"\)/);
  assert.doesNotMatch(
    chatRuntimeHostSource,
    /import \{[\s\S]{0,100}runAgentConversationTurn[\s\S]{0,100}\} from/,
  );
  assert.match(sendChatTurnSource, /import\("\.\.\/\.\.\/\.\.\/lib\/memory\/prompts\/injection"\)/);
  assert.match(
    sendChatTurnSource,
    /import\("\.\.\/\.\.\/\.\.\/lib\/chat\/memory\/injectionController"\)/,
  );
  assert.match(extractionControllerSource, /import\("\.\/extractionEngine"\)/);
  assert.doesNotMatch(extractionControllerSource, /runMemoryExtraction,\s*\} from/);
  assert.doesNotMatch(appSource, /import \{ ChatPage \} from "\.\/pages\/ChatPage"/);
  assert.match(appSource, /if \(!settingsReady\)[\s\S]{0,220}<AppBootShell/);
  assert.ok(chatSource.indexOf("useWorkspaceProjects({") < chatSource.indexOf("sidebarStore.start()"));
  assert.match(chatSource, /import\("\.\/chat\/surfaces\/ConversationPaneHost"\)/);
  assert.doesNotMatch(chatSource, /from "\.\/chat";/);
  assert.match(
    chatSource,
    /<Suspense fallback=\{<PaneLoadingSkeleton label=\{t\("app\.loading"\)\} \/>\}>/,
  );
  assert.match(chatSource, /deferHydration=\{!paneContext\.isFocused\}/);
  assert.match(conversationPaneHostSource, /window\.requestIdleCallback\(hydrate/);
  assert.match(historyActionsSource, /await backgroundHydration/);
  assert.match(settingsDbSource, /SCHEMA_INITIALIZED\.get\(\)\.is_none\(\)/);
  assert.match(transcriptLoadingSource, /<PaneLoadingSkeleton/);
  assert.doesNotMatch(transcriptLoadingSource, /LoaderCircle/);
  assert.match(paneLoadingSource, /data-pane-loading-motion="static"/);
  assert.doesNotMatch(paneLoadingSource, /animate-|shimmer|pulse|workbench-pane-restoring/);
  assert.doesNotMatch(appStyles, /workbench(?:PaneLoadingIn|RestoreThread)/);
  assert.match(transcriptSource, /DEFER_REVEAL_HISTORY_ITEM_THRESHOLD = 120/);
  assert.match(
    transcriptSource,
    /shouldDeferTranscriptReveal \? handleFirstLayoutSettled : undefined/,
  );
  assert.match(transcriptListSource, /stableFrames >= 1/);
  assert.match(transcriptListSource, /performance\.now\(\) - startedAt > 240/);
});
