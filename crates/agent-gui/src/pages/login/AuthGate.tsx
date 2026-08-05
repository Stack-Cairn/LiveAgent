/**
 * 登录门禁：决定先渲染 App 还是先渲染登录页。
 *
 * 桌面壳里这个组件是透明的——`isDesktopShell()` 为真就直接渲染 App，一次
 * 网络探测都不做，没有闪屏，没有登录页。这是决策 8 的「桌面版开箱体验不能
 * 退化」落地的地方。
 *
 * 浏览器里才有门禁：存档里没有凭据就直接进登录页；有凭据则先探一次，
 * 把「密码过期」「填成了旧 Gateway 的地址」「后端没起来」三种情况在这里
 * 分辨清楚——否则用户看到的是应用加载后满屏失败的请求。
 */

import { useEffect, useState } from "react";
import {
  clearStoredEndpoint,
  hasStoredCredentials,
  isDesktopShell,
  peekStoredEndpoint,
} from "../../lib/backend/endpoint";
import { LoginPage } from "./LoginPage";
import { probeEndpoint } from "./probeEndpoint";

type GateState =
  | { status: "checking" }
  | { status: "login"; message?: string }
  | { status: "ready" };

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>(() =>
    isDesktopShell() || !hasStoredCredentials()
      ? { status: isDesktopShell() ? "ready" : "login" }
      : { status: "checking" },
  );

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

  return <LoginPage initialMessage={state.message} onAuthenticated={() => setState({ status: "ready" })} />;
}
