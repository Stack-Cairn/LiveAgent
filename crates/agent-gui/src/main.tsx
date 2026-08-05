// 必须最先 import：浏览器环境下安装 __TAURI_INTERNALS__ 网络 shim
import "./lib/backend/tauriShim";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import { inferRuntimePlatform } from "./lib/runtimePlatform";
import { installWebviewNavigationGuard } from "./lib/system/webviewNavigationGuard";

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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
