import type { ReactNode } from "react";
import { cn } from "../../lib/shared/utils";

export function HubBackdrop(props: { tone?: "amber" | "violet" | "neutral" }) {
  const { tone = "neutral" } = props;
  const haloClass =
    tone === "amber"
      ? "bg-surface-glow-1 dark:bg-surface-glow-2"
      : tone === "violet"
        ? "bg-surface-glow-3 dark:bg-surface-glow-4"
        : "bg-surface-glow-5 dark:bg-surface-glow-6";
  return (
    <>
      <div className="pointer-events-none absolute inset-0 bg-[hsl(var(--hub-canvas))]" />
      <div
        className={cn(
          "pointer-events-none absolute -left-32 -top-24 size-420px rounded-full opacity-90 blur-3xl",
          haloClass,
        )}
      />
      <div
        className={cn(
          "pointer-events-none absolute -right-24 bottom-0 size-360px rounded-full opacity-60 blur-3xl",
          haloClass,
        )}
      />
    </>
  );
}

// 侧栏开关不在这里渲染：AppWorkbenchChrome(ChatHeader)常驻于所有视图之上，
// 侧栏收起时已经提供了同一个按钮。Hub 自己再画一个就会在窄屏上叠出两枚
// PanelLeft(#501 之前 Hub 页面没有顶栏，才需要自带一枚)。
// 顶栏也已预留 macOS 窗口控件空间，Hub 内容无需再次添加标题栏占位。
export function HubHeader(props: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  tone?: "amber" | "violet" | "neutral";
  actions?: ReactNode;
  prominent?: boolean;
  embedded?: boolean;
}) {
  const { icon, title, subtitle, actions, prominent = false, embedded = false } = props;
  return (
    <div
      className={cn(
        "hub-header relative z-10",
        embedded ? "pb-5" : "px-5 sm:px-6 lg:px-8 xl:px-10",
        !embedded && (prominent ? "pb-5 pt-4" : "pb-3 pt-4"),
      )}
    >
      <div
        className={cn(
          "mx-auto flex w-full max-w-1320px gap-4",
          prominent ? "items-end" : "items-center",
        )}
      >
        {icon ? (
          <div
            className={cn(
              "hub-header-icon flex size-11 shrink-0 items-center justify-center",
              "rounded-xl border border-border bg-background text-foreground shadow-xs",
            )}
          >
            {icon}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          {!embedded ? (
            <h1
              className={cn(
                "font-semibold leading-tight tracking-tight text-foreground",
                prominent ? "text-3xl" : "text-xl",
              )}
            >
              {title}
            </h1>
          ) : null}
          {subtitle ? (
            <p
              className={cn(
                "truncate text-muted-foreground",
                prominent ? "mt-1.5 text-sm" : "mt-0.5 text-xs",
              )}
              title={subtitle}
            >
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function GlassPanel(props: {
  children: ReactNode;
  tone?: "default" | "muted" | "error" | "amber" | "violet" | "neutral";
  active?: boolean;
  className?: string;
}) {
  const { children, tone = "default", active = false, className } = props;
  const toneClass = (() => {
    switch (tone) {
      case "muted":
        return "border-border/40 bg-muted/40";
      case "error":
        return "border-destructive/30 bg-destructive/5";
      case "amber":
      case "violet":
      case "neutral":
        return active
          ? "border-border/55 bg-background/80 shadow-ui-hubchrome-24 dark:border-white/[0.09] dark:bg-white/[0.06] dark:shadow-ui-hubchrome-25"
          : "border-border/40 bg-background/60";
      default:
        return "border-border/40 bg-background/60";
    }
  })();
  return (
    <div
      className={cn(
        "hub-glass-panel rounded-2xl border px-4 py-3.5 backdrop-blur-xl",
        toneClass,
        className,
      )}
    >
      {children}
    </div>
  );
}
