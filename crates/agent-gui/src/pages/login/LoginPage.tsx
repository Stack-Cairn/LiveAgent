/**
 * 后端连接页。
 *
 * 浏览器里是登录页：必须填地址和密码。桌面壳里是可选的「切换后端服务器」
 * 页：地址留空提交即回到本机内嵌后端（决策 8 的零配置路径），填了就和
 * 浏览器走完全相同的远程连接代码。
 */

import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  type BackendEndpoint,
  clearStoredEndpoint,
  hasLegacyGatewayLeftovers,
  isDesktopShell,
  peekStoredEndpoint,
  resetEndpoint,
} from "../../lib/backend/endpoint";
import { probeEndpoint } from "./probeEndpoint";

type LoginPageProps = {
  /** 门禁预校验失败时带进来的提示（比如存档里的密码已经失效）。 */
  initialMessage?: string;
  /** 远程连接成功带 endpoint；壳内选择内嵌后端时为 null。 */
  onAuthenticated: (endpoint: BackendEndpoint | null) => void;
};

export function LoginPage({ initialMessage, onAuthenticated }: LoginPageProps) {
  const stored = peekStoredEndpoint();
  const shell = isDesktopShell();
  const [host, setHost] = useState(stored?.host ?? (shell ? "" : "127.0.0.1"));
  const [port, setPort] = useState(String(stored?.port ?? 8443));
  const [password, setPassword] = useState("");
  const [secure, setSecure] = useState(stored?.secure ?? window.location.protocol === "https:");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialMessage ?? "");

  const legacyLeftovers = hasLegacyGatewayLeftovers();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    // 壳内地址留空 = 用回内嵌后端：清掉存档，端点解析链自然落回壳注入。
    if (shell && !host.trim()) {
      clearStoredEndpoint();
      resetEndpoint();
      onAuthenticated(null);
      return;
    }

    const parsedPort = Number(port);
    if (!host.trim() || !Number.isFinite(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      setError("请填写有效的地址和端口。");
      return;
    }

    const endpoint: BackendEndpoint = {
      host: host.trim(),
      port: parsedPort,
      password,
      secure,
    };

    setBusy(true);
    setError("");
    const result = await probeEndpoint(endpoint);
    setBusy(false);

    if (result.kind === "ok") {
      // 写进存档并热更端点，之后所有 invoke/WS 立刻用新凭据。
      resetEndpoint(endpoint);
      onAuthenticated(endpoint);
      return;
    }
    setError(result.message);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">连接到 LiveAgent 后端</h1>
          <p className="text-sm text-muted-foreground">
            {shell
              ? "填写远程后端的服务器地址和访问密码；留空地址则使用本机内嵌后端。"
              : "填写后端服务的地址和访问密码。密码保存在本机浏览器里。"}
          </p>
        </div>

        {legacyLeftovers ? (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            检测到这台机器上有 v1 Gateway 的残留配置。v2 不再需要 Gateway
            ——请直接填后端地址。迁移步骤见 README 的 v2 迁移指南。
          </p>
        ) : null}

        <div className="flex gap-2">
          <div className="flex-1 space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="login-host">
              {shell ? "服务器地址（留空用本机）" : "地址"}
            </label>
            <Input
              id="login-host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder={shell ? "留空使用内嵌后端" : "127.0.0.1"}
              autoComplete="off"
            />
          </div>
          <div className="w-24 space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="login-port">
              端口
            </label>
            <Input
              id="login-port"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              inputMode="numeric"
              placeholder="8443"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="login-password">
            密码
          </label>
          <Input
            id="login-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={secure}
            onChange={(event) => setSecure(event.target.checked)}
          />
          使用 HTTPS / WSS
        </label>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "连接中…" : "连接"}
        </Button>
      </form>
    </div>
  );
}
