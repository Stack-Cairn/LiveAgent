import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { GATEWAY_WEBUI_MARKER } from "./lib/runtimeEnv";
import { DevicesAdminPage } from "./pages/DevicesAdminPage";
import { StatusDashboardPage } from "./pages/StatusDashboardPage";
import "./index.css";
import "katex/dist/katex.min.css";
import "react-complex-tree/lib/style-modern.css";
import "streamdown/styles.css";
import "./styles.css";

// 渲染前写入 WebUI 运行时标记（isGatewayWebuiRuntime 的唯一权威写入点）。
document.documentElement.dataset.liveagentWebui = GATEWAY_WEBUI_MARKER;

const dashboardPaths = new Set(["/dashboard", "/status-board", "/observatory"]);
// 独立管理页：/admin/devices（Agent 凭证管理，REST + 网关 Token）。
const Root = dashboardPaths.has(window.location.pathname)
  ? StatusDashboardPage
  : window.location.pathname === "/admin/devices"
    ? DevicesAdminPage
    : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
