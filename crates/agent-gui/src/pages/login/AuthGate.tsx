/**
 * 登录门禁：决定先渲染 App 还是先渲染连接页。
 *
 * 三条初始路径，壳与浏览器共用同一条状态机：
 *   - URL 带 `?connect`（设置页「切换后端服务器」入口）：直接进连接页。
 *   - 存档里有端点（用户手填过远程地址）：先探一次再放行，无论壳还是浏览器。
 *   - 什么都没有：桌面壳直接放行（内嵌后端，零配置零闪屏，决策 8）；
 *     浏览器进登录页。
 */

import { useEffect, useState } from "react";
import {
  clearStoredEndpoint,
  isDesktopShell,
  peekStoredEndpoint,
} from "../../lib/backend/endpoint";
import { LoginPage } from "./LoginPage";
import { probeEndpoint } from "./probeEndpoint";

type GateState =
  | { status: "checking" }
  | { status: "login"; message?: string }
  | { status: "ready" };

/** 摘掉 `?connect`，免得下次整页刷新又回到连接页。 */
function stripConnectParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("connect")) return;
  url.searchParams.delete("connect");
  window.history.replaceState(null, "", url);
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>(() => {
    if (new URLSearchParams(window.location.search).has("connect")) return { status: "login" };
    if (peekStoredEndpoint()) return { status: "checking" };
    return { status: isDesktopShell() ? "ready" : "login" };
  });

  useEffect(() => {
    if (state.status !== "checking") return;
    const stored = peekStoredEndpoint();
    if (!stored) {
      setState({ status: "login" });
      return;
    }

    let cancelled = false;
    void probeEndpoint(stored).then((result) => {
      if (cancelled) return;
      if (result.kind === "ok") {
        setState({ status: "ready" });
        return;
      }
      // 密码不对就别再留着它，免得下次开机重复同样的失败。
      if (result.kind === "unauthorized") clearStoredEndpoint();
      setState({ status: "login", message: result.message });
    });

    return () => {
      cancelled = true;
    };
  }, [state.status]);

  if (state.status === "ready") return <>{children}</>;

  if (state.status === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        正在连接后端…
      </div>
    );
  }

  return (
    <LoginPage
      initialMessage={state.message}
      onAuthenticated={() => {
        stripConnectParam();
        setState({ status: "ready" });
      }}
    />
  );
}
