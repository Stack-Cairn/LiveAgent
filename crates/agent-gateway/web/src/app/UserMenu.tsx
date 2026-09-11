import { ChevronDown, LogOut, User } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ReactNode } from "react";

type UserMenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userMenuLabel: string;
  userAvatarLabel: string;
  agentStatus: "online" | "offline" | "unknown";
  agentSelector?: ReactNode;
  onLogout: () => void;
};

export function UserMenu(props: UserMenuProps) {
  const {
    open,
    onOpenChange,
    userMenuLabel,
    userAvatarLabel,
    agentStatus,
    agentSelector,
    onLogout,
  } = props;
  const { t } = useLocale();
  const statusLabel =
    agentStatus === "online"
      ? t("settings.devicesOnlineStatus")
      : agentStatus === "offline"
        ? t("settings.devicesOfflineStatus")
        : t("settings.devicesUnknownStatus");
  const statusDotClass =
    agentStatus === "online"
      ? "bg-emerald-500"
      : agentStatus === "offline"
        ? "bg-rose-500"
        : "bg-muted-foreground/50";

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className={cn(
              "h-8 gap-1 rounded-full border border-border/60 bg-background/70 px-1.5",
              "text-foreground shadow-sm hover:bg-muted/70",
            )}
            title={`${userMenuLabel} · ${statusLabel}`}
          />
        }
      >
        <span
          className={cn(
            "relative flex size-6 items-center justify-center rounded-full bg-gradient-to-br",
            "from-emerald-500/90 to-sky-500/90 text-xs font-semibold text-white",
          )}
        >
          {userAvatarLabel || <User className="size-3.5" />}
          <span
            className={cn(
              "absolute -bottom-1 -right-1 size-3 rounded-full shadow-sm ring-2 ring-background",
              statusDotClass,
            )}
          >
            <span className="sr-only">{statusLabel}</span>
          </span>
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="min-w-48 rounded-xl border-border/70 bg-popover/95 backdrop-blur supports-[backdrop-filter]:bg-popover/90"
      >
        {agentSelector}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onLogout}
          className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
        >
          <LogOut className="size-3.5" />
          {t("common.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
