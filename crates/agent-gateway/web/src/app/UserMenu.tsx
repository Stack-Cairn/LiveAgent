import { ChevronDown, LogOut, User } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type UserMenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userMenuLabel: string;
  userAvatarLabel: string;
  sessionId?: string | null;
  onLogout: () => void;
};

export function UserMenu(props: UserMenuProps) {
  const { open, onOpenChange, userMenuLabel, userAvatarLabel, sessionId, onLogout } = props;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="h-8 gap-1 rounded-full border border-border/60 bg-background/70 px-1.5 text-foreground shadow-sm hover:bg-muted/70"
            title="用户菜单"
          />
        }
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500/90 to-sky-500/90 text-[calc(11px*var(--zone-font-scale,1))] font-semibold text-white">
          {userAvatarLabel || <User className="h-3.5 w-3.5" />}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="min-w-[12rem] rounded-xl border-border/70 bg-popover/95 backdrop-blur supports-[backdrop-filter]:bg-popover/90"
      >
        <DropdownMenuLabel className="px-3 py-2">
          <div className="text-sm font-medium text-foreground">{userMenuLabel}</div>
          <div className="mt-0.5 text-xs font-normal text-muted-foreground">
            Session {sessionId || "N/A"}
          </div>
        </DropdownMenuLabel>
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
