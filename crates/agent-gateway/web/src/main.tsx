import { installDiagnosticsCapture } from "@liveagent/ui/lib/diagnostics/recentErrors";
import { GATEWAY_WEBUI_MARKER } from "@liveagent/ui/lib/runtimeEnv";
import { installReactDevTimelineLimit } from "@liveagent/ui/lib/system/reactDevTimeline";
import React, { type ComponentType, lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "katex/dist/katex.min.css";
import "react-complex-tree/lib/style-modern.css";
import "streamdown/styles.css";

// 渲染前写入 WebUI 运行时标记（isGatewayWebuiRuntime 的唯一权威写入点）。
document.documentElement.dataset.liveagentWebui = GATEWAY_WEBUI_MARKER;

// Recent warnings/errors, kept in memory for the diagnostics export.
installDiagnosticsCapture();

if (import.meta.env.DEV) {
  const stopReactTimelineLimit = installReactDevTimelineLimit();
  import.meta.hot?.dispose(stopReactTimelineLimit);
}

const dashboardPaths = new Set(["/dashboard", "/status-board", "/observatory"]);
// The standalone pages are separate routes: load them only on their own path so
// the chat app's startup bundle does not carry them.
const StatusDashboardPage = lazy(async () => ({
  default: (await import("./pages/StatusDashboardPage")).StatusDashboardPage,
}));
// 独立管理页：/admin/devices（Agent 凭证管理，REST + 网关 Token）。
const DevicesAdminPage = lazy(async () => ({
  default: (await import("./pages/DevicesAdminPage")).DevicesAdminPage,
}));
const standalonePage: ComponentType | null = dashboardPaths.has(window.location.pathname)
  ? StatusDashboardPage
  : window.location.pathname === "/admin/devices"
    ? DevicesAdminPage
    : null;

function Root() {
  if (!standalonePage) return <App />;
  const Page = standalonePage;
  return (
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
