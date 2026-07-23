import type { ReactNode } from "react";
import { ChevronDown, LogOut, User } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLocale } from "@/i18n";

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
            className="h-8 gap-1 rounded-full border border-border/60 bg-background/70 px-1.5 text-foreground shadow-sm hover:bg-muted/70"
            title={`${userMenuLabel} · ${statusLabel}`}
          />
        }
      >
        <span className="relative flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500/90 to-sky-500/90 text-[calc(11px*var(--zone-font-scale,1))] font-semibold text-white">
          {userAvatarLabel || <User className="h-3.5 w-3.5" />}
          <span
            className={`absolute -bottom-1 -right-1 h-3 w-3 rounded-full shadow-sm ring-2 ring-background ${statusDotClass}`}
          >
            <span className="sr-only">{statusLabel}</span>
          </span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="min-w-[12rem] rounded-xl border-border/70 bg-popover/95 backdrop-blur supports-[backdrop-filter]:bg-popover/90"
      >
        {agentSelector}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onLogout}
          className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
        >
          <LogOut className="h-3.5 w-3.5" />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
