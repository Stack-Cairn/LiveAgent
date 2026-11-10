import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import { installReactDevTimelineLimit } from "@liveagent/ui/lib/system/reactDevTimeline";
import { watchHostBridgeStatus } from "@liveagent/ui/lib/tools/hostBridgeStatus";
import { isTauriHost } from "./lib/host";
import {
  connectKBrainBackendWithRetry,
  createKBrainBootstrapRunner,
  notifyFrontendReady,
  restartKBrainBackend,
} from "./lib/kbrain/bootstrap";
import { migrateAllHistoryOnce } from "./lib/kbrain/historyMigration";
import { inferRuntimePlatform } from "./lib/runtimePlatform";
import { createStartupRenderer } from "./lib/startup/render";
import { installWebviewNavigationGuard } from "./lib/system/webviewNavigationGuard";
import { listen } from "./shims/tauriEvent";

if (import.meta.env.DEV) {
  const stopReactTimelineLimit = installReactDevTimelineLimit();
  import.meta.hot?.dispose(stopReactTimelineLimit);
}

// The desktop re-registers its host bridge on every K-brain restart; follow its status so
// run options and Settings see which bridge tools K-brain has.
if (isTauriHost()) void watchHostBridgeStatus(listen);

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

let currentBootstrap: Promise<void> | undefined;

function runBootstrapAgain() {
  void (currentBootstrap ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => {
      currentBootstrap = bootstrap();
    });
}

const bootstrap = createKBrainBootstrapRunner(async () => {
  const screen = createStartupRenderer();
  // Settles when the user leaves this attempt: "skip" opens the app now, "retry" ends the
  // attempt so a fresh one runs against a restarted backend. The history check races it, so a
  // step that never answers can no longer hold the startup screen forever.
  let leave: (choice: "skip" | "retry") => void = () => {};
  const left = new Promise<"skip" | "retry">((resolve) => {
    leave = resolve;
  });
  const attempt = new AbortController();
  const restartAndRetry = () => {
    leave("retry");
    attempt.abort(new Error("Startup restarted by the user"));
    screen.dispose();
    // A stuck backend would only keep the next attempt waiting: replace it first.
    void restartKBrainBackend()
      .catch((error) => console.error("Restarting the local service failed", error))
      .finally(runBootstrapAgain);
  };
  const openApp = async () => {
    screen.phase("opening");
    const { default: App } = await import("./App");
    screen.dispose();
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  };
  try {
    await connectKBrainBackendWithRetry();
    // Connected: from here on the user may skip the history check (it continues in the
    // background) or restart the local service once a step stops making progress.
    screen.offerEscapes({ skip: () => leave("skip"), retry: restartAndRetry });
    // Startup skips conversations that already failed deterministically with unchanged
    // content; they are listed in Settings and in the app notice instead of re-uploaded.
    screen.phase("checking");
    const migration = migrateAllHistoryOnce({
      onProgress: screen.progress,
      signal: attempt.signal,
    }).then((result) => {
      const newFailures = result.failures.filter((failure) => !failure.skipped);
      if (newFailures.length > 0) {
        console.warn("Legacy history migration incomplete", newFailures);
      }
    });
    const outcome = await Promise.race([migration.then(() => "done" as const), left]);
    if (outcome === "retry") return;
    if (outcome === "skip") {
      // Every step is time-bounded, so the remaining work ends on its own; whatever it does
      // not finish is retried on the next launch.
      void migration.catch((error) => console.error("Background history migration failed", error));
    }
    await openApp();
  } catch (error) {
    console.error("Application startup failed", error);
    screen.fail(restartAndRetry);
    // Wait for the user's choice; "skip" is offered here only after K-brain connected.
    if ((await left) === "skip") {
      await openApp().catch((openError) => console.error("Opening LiveAgent failed", openError));
    }
  } finally {
    await notifyFrontendReady().catch(() => undefined);
  }
});

// F5/Ctrl+R 等 webview 内置浏览器行为会把整个应用当网页刷新/导航走——在 React
// 挂载前安装守卫。dev 下放行刷新组合键，保留本地整页重载的调试手段。
installWebviewNavigationGuard({
  isMac: inferRuntimePlatform() === "macos",
  allowReloadChords: import.meta.env.DEV,
});

if (import.meta.env.DEV) {
  // Dev console hook for transcript perf work: window.__seedLongConversation()
  void import("./lib/debug/seedLongConversation").then(({ seedLongConversation }) => {
    const devWindow = window as Window & { __seedLongConversation?: typeof seedLongConversation };
    devWindow.__seedLongConversation = seedLongConversation;
  });
}

currentBootstrap = bootstrap();
