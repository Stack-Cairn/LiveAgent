import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useLocale } from "../../i18n";
import { cn } from "../../lib/shared/utils";
import { PanelLeft } from "../icons";
import { isMacOsTauri, MacOsTitleBarSpacer } from "../MacOsTitleBarSpacer";
import { Button } from "../ui/button";

export function HubBackdrop(props: { tone?: "amber" | "violet" | "neutral" }) {
  const { tone = "neutral" } = props;
  // Cool monochrome wash; tone only shifts temperature slightly.
  // Dark canvas sits below --background so glass panels read elevated.
  const haloClass =
    tone === "amber"
      ? "bg-[radial-gradient(circle_at_top_left,hsl(40_30%_98%/0.9),transparent_58%)] dark:bg-[radial-gradient(circle_at_top_left,hsl(36_18%_14%/0.45),transparent_58%)]"
      : tone === "violet"
        ? "bg-[radial-gradient(circle_at_top_left,hsl(250_28%_98%/0.9),transparent_58%)] dark:bg-[radial-gradient(circle_at_top_left,hsl(250_18%_14%/0.45),transparent_58%)]"
        : "bg-[radial-gradient(circle_at_top_left,hsl(240_12%_98%/0.88),transparent_58%)] dark:bg-[radial-gradient(circle_at_top_left,hsl(240_12%_14%/0.4),transparent_58%)]";
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
          "pointer-events-none absolute -right-24 bottom-0 h-[360px] w-[360px] rounded-full opacity-55 blur-3xl",
          haloClass,
        )}
      />
    </>
  );
}

export function HubHeader(props: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  tone?: "amber" | "violet" | "neutral";
  actions?: ReactNode;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
}) {
  const { icon, title, subtitle, actions, sidebarOpen, onOpenSidebar } = props;
  const { t } = useLocale();
  const isMacTitleBarOverlay = isMacOsTauri();
  const showSidebarButton = !sidebarOpen && !isMacTitleBarOverlay;
  return (
    <>
      <MacOsTitleBarSpacer />
      <div className="hub-header relative z-10 px-5 pb-3 pt-5 sm:px-6 lg:px-8 xl:px-10">
        {showSidebarButton ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onOpenSidebar}
            title={t("tooltip.openSidebar")}
            className="absolute left-3 top-4 h-9 w-9 rounded-full text-muted-foreground hover:bg-background/70 hover:text-foreground"
          >
            <PanelLeft className="h-4.5 w-4.5" />
          </Button>
        ) : null}
        <div
          className={cn(
            "mx-auto flex w-full max-w-[1320px] items-center gap-3.5",
            showSidebarButton && "pl-11 lg:pl-0",
          )}
        >
          <div className="hub-header-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] text-foreground/80">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[calc(22px*var(--zone-font-scale,1))] font-semibold leading-[1.15] tracking-[-0.022em] text-foreground">
              {title}
            </h1>
            {subtitle ? (
              <p
                className="mt-0.5 truncate text-[12.5px] leading-snug tracking-[-0.005em] text-muted-foreground"
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
  return (
    <div
      data-tone={tone}
      data-active={active || undefined}
      className={cn("hub-glass-panel", className)}
    >
      {children}
    </div>
  );
}

/** Status strip under HubHeader (Skills enabled / MCP ready). */
export function HubStatusBanner(props: {
  ready?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const { ready = false, children, className } = props;
  return (
    <div
      data-ready={ready || undefined}
      className={cn("hub-status-banner hub-panel-enter", className)}
    >
      {children}
    </div>
  );
}

/** Segmented tab track (Installed / Store / Import). */
export function HubSegmentedTrack(props: { children: ReactNode; className?: string }) {
  return <div className={cn("hub-segmented-track", props.className)}>{props.children}</div>;
}

export function HubSegmentButton(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    active?: boolean;
    icon?: ReactNode;
    count?: number | null;
  },
) {
  const { active, icon, count, className, children, type = "button", ...rest } = props;
  return (
    <button
      type={type}
      data-active={active || undefined}
      className={cn("hub-segment-button", className)}
      {...rest}
    >
      {icon}
      <span>{children}</span>
      {count != null && count > 0 ? (
        <span className="hub-segment-count" data-active={active || undefined}>
          {count}
        </span>
      ) : null}
    </button>
  );
}
