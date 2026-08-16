import { HubTitleBar, usesOverlayTitleBar } from "@liveagent/adapters/hubChrome";
import { PanelLeft } from "@liveagent/ui/components/IconSet";
import type { ReactNode } from "react";
import { useLocale } from "../../i18n";
import { cn } from "../../lib/shared/utils";
import { Button } from "../ui/button";

export function HubBackdrop(props: { tone?: "amber" | "violet" | "neutral" }) {
  const { tone = "neutral" } = props;
  const haloClass =
    tone === "amber"
      ? "bg-[radial-gradient(circle_at_top_left,hsl(0_0%_100%/0.85),transparent_60%)] dark:bg-[radial-gradient(circle_at_top_left,hsl(222_18%_14%/0.55),transparent_60%)]"
      : tone === "violet"
        ? "bg-[radial-gradient(circle_at_top_left,hsl(220_18%_98%/0.85),transparent_60%)] dark:bg-[radial-gradient(circle_at_top_left,hsl(224_20%_14%/0.55),transparent_60%)]"
        : "bg-[radial-gradient(circle_at_top_left,hsl(0_0%_100%/0.8),transparent_60%)] dark:bg-[radial-gradient(circle_at_top_left,hsl(224_18%_14%/0.5),transparent_60%)]";
  return (
    <>
      <div className="pointer-events-none absolute inset-0 bg-[hsl(var(--hub-canvas))]" />
      <div
        className={cn(
          "pointer-events-none absolute -left-32 -top-24 h-[420px] w-[420px] rounded-full opacity-90 blur-3xl",
          haloClass,
        )}
      />
      <div
        className={cn(
          "pointer-events-none absolute -right-24 bottom-0 h-[360px] w-[360px] rounded-full opacity-60 blur-3xl",
          haloClass,
        )}
      />
    </>
  );
}

export function HubHeader(props: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  tone?: "amber" | "violet" | "neutral";
  actions?: ReactNode;
  prominent?: boolean;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
}) {
  const { icon, title, subtitle, actions, prominent = false, sidebarOpen, onOpenSidebar } = props;
  const { t } = useLocale();
  const showSidebarButton = !sidebarOpen && !usesOverlayTitleBar;
  return (
    <>
      <HubTitleBar />
      <div
        className={cn(
          "hub-header relative z-10 px-5 sm:px-6 lg:px-8 xl:px-10",
          prominent ? "pb-5 pt-8" : "pb-3 pt-6",
        )}
      >
        {showSidebarButton ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onOpenSidebar}
            title={t("tooltip.openSidebar")}
            className="absolute left-3 top-5 h-9 w-9 rounded-lg text-muted-foreground hover:bg-background/70 hover:text-foreground"
          >
            <PanelLeft className="h-4.5 w-4.5" />
          </Button>
        ) : null}
        <div
          className={cn(
            "mx-auto flex w-full max-w-[1320px] gap-4",
            prominent ? "items-end" : "items-center",
            showSidebarButton && "pl-11 lg:pl-0",
          )}
        >
          {icon ? (
            <div className="hub-header-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-foreground shadow-xs">
              {icon}
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <h1
              className={cn(
                "font-semibold leading-tight tracking-tight text-foreground",
                prominent ? "text-[28px]" : "text-[21px]",
              )}
            >
              {title}
            </h1>
            {subtitle ? (
              <p
                className={cn(
                  "truncate text-muted-foreground",
                  prominent ? "mt-1.5 text-sm" : "mt-0.5 text-[12px]",
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
    </>
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
          ? "border-border/55 bg-background/80 shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_6px_22px_-14px_rgba(15,23,42,0.18)] dark:border-white/[0.09] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_6px_22px_-14px_rgba(0,0,0,0.55)]"
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
