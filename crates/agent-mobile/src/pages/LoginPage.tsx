import {
  ArrowRight,
  Globe,
  History,
  Key,
  Lock,
  MessageSquareText,
  Shield,
  Timer,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState } from "react";

type LoginPageProps = {
  gatewayUrl: string;
  token: string;
  error: string | null;
  isSubmitting: boolean;
  onGatewayUrlChange: (gatewayUrl: string) => void;
  onTokenChange: (token: string) => void;
  onSubmit: () => void;
};

const features = [
  {
    icon: MessageSquareText,
    title: "Remote Chat",
    desc: "按桌面端式样查看 token、thinking、tool_call 与 tool_result。",
    accent: "login-feat--blue",
  },
  {
    icon: History,
    title: "History Resume",
    desc: "从远程历史回填会话并继续对话，而不是只看原始 JSON。",
    accent: "login-feat--violet",
  },
  {
    icon: Timer,
    title: "Cron Control",
    desc: "在浏览器里完成任务查看、创建、更新与删除的转发调试。",
    accent: "login-feat--amber",
  },
];

export function LoginPage({
  gatewayUrl,
  token,
  error,
  isSubmitting,
  onGatewayUrlChange,
  onTokenChange,
  onSubmit,
}: LoginPageProps) {
  const [isUrlFocused, setIsUrlFocused] = useState(false);
  const [isTokenFocused, setIsTokenFocused] = useState(false);

  return (
    <main className="login-shell">
      {/* Subtle mesh gradient backdrop */}
      <div className="login-backdrop" aria-hidden="true" />
      <div className="login-backdrop-orb login-backdrop-orb--1" aria-hidden="true" />
      <div className="login-backdrop-orb login-backdrop-orb--2" aria-hidden="true" />

      <div className="login-container login-entrance">
        {/* Left: branding + features */}
        <div className="login-hero login-entrance-d1">
          <div className="login-hero-title-row">
            <div className="login-logo-mark">
              <Shield size={18} strokeWidth={2} />
            </div>
            <h1 className="login-hero-title">LiveAgent Gateway</h1>
          </div>
          <p className="login-hero-desc">
            安全连接到远程代理会话，在浏览器中获得完整的控制台体验。
          </p>

          <div className="login-feat-list login-entrance-d2">
            {features.map((f) => (
              <div key={f.title} className={cn("login-feat", f.accent)}>
                <div className="login-feat-icon">
                  <f.icon size={16} strokeWidth={2} />
                </div>
                <div className="login-feat-text">
                  <strong>{f.title}</strong>
                  <span>{f.desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: auth form */}
        <div className="login-form-panel login-entrance-d2">
          <div className="login-form-card">
            <div className="login-form-header">
              <div className="login-form-title-row">
                <div className="login-form-icon">
                  <Lock size={16} strokeWidth={2} />
                </div>
                <h2 className="login-form-title">连接控制台</h2>
              </div>
              <p className="login-form-sub">输入 Gateway 地址与 Access Token 以验证身份</p>
            </div>

            <div className={cn("login-input-wrap", isUrlFocused && "login-input-wrap--focus")}>
              <label htmlFor="gateway-url" className="login-input-label">
                <Globe size={12} strokeWidth={2.5} />
                Gateway 地址
              </label>
              <Input
                id="gateway-url"
                name="gateway_url"
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={gatewayUrl}
                placeholder="https://gateway.example.com"
                disabled={isSubmitting}
                aria-invalid={error ? "true" : "false"}
                onChange={(e) => onGatewayUrlChange(e.target.value)}
                onFocus={() => setIsUrlFocused(true)}
                onBlur={() => setIsUrlFocused(false)}
                className="login-input"
              />
            </div>

            <div className={cn("login-input-wrap", isTokenFocused && "login-input-wrap--focus")}>
              <label htmlFor="access-token" className="login-input-label">
                <Key size={12} strokeWidth={2.5} />
                Access Token
              </label>
              <Textarea
                id="access-token"
                name="access_token"
                rows={3}
                value={token}
                placeholder=""
                disabled={isSubmitting}
                aria-invalid={error ? "true" : "false"}
                onChange={(e) => onTokenChange(e.target.value)}
                onFocus={() => setIsTokenFocused(true)}
                onBlur={() => setIsTokenFocused(false)}
                className="login-input"
              />
            </div>

            {error && <p className="login-form-error">{error}</p>}

            <Button
              type="button"
              size="lg"
              disabled={token.trim() === "" || gatewayUrl.trim() === "" || isSubmitting}
              onClick={onSubmit}
              className="login-btn"
            >
              {isSubmitting ? (
                <span className="login-btn-loading" />
              ) : (
                <>
                  进入 Gateway
                  <ArrowRight size={15} strokeWidth={2.2} />
                </>
              )}
            </Button>

            <p className="login-form-footer">Token 验证通过后将本地保存，下次自动登录</p>
          </div>
        </div>
      </div>
    </main>
  );
}
