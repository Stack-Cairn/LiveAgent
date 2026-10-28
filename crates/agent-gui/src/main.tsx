import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import { installReactDevTimelineLimit } from "@liveagent/ui/lib/system/reactDevTimeline";
import {
  connectKBrainBackendWithRetry,
  createKBrainBootstrapRunner,
  notifyFrontendReady,
} from "./lib/kbrain/bootstrap";
import { migrateAllHistoryOnce } from "./lib/kbrain/historyMigration";
import { inferRuntimePlatform } from "./lib/runtimePlatform";
import { createStartupRenderer } from "./lib/startup/render";
import { installWebviewNavigationGuard } from "./lib/system/webviewNavigationGuard";

if (import.meta.env.DEV) {
  const stopReactTimelineLimit = installReactDevTimelineLimit();
  import.meta.hot?.dispose(stopReactTimelineLimit);
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

let currentBootstrap: Promise<void> | undefined;

const bootstrap = createKBrainBootstrapRunner(async () => {
  const screen = createStartupRenderer();
  try {
    await connectKBrainBackendWithRetry();
    // Startup skips conversations that already failed deterministically with unchanged
    // content; they are listed in Settings and in the app notice instead of re-uploaded.
    screen.phase("checking");
    const migration = await migrateAllHistoryOnce({ onProgress: screen.progress });
    const newFailures = migration.failures.filter((failure) => !failure.skipped);
    if (newFailures.length > 0) {
      console.warn("Legacy history migration incomplete", newFailures);
    }
    screen.phase("opening");
    const { default: App } = await import("./App");
    screen.dispose();
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  } catch (error) {
    console.error("Application startup failed", error);
    screen.fail(() => {
      void (currentBootstrap ?? Promise.resolve()).then(() => {
        currentBootstrap = bootstrap();
      });
    });
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
