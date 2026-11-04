import { isDesktopChatHeaderInset } from "@liveagent/adapters/chatHeaderChrome";
import type { AppSettings } from "@liveagent/app/lib/settings";
import { PanelLeft, Settings } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { ShortcutTooltip } from "@liveagent/ui/components/ui/shortcut-tooltip";
import { useSidebarToggleShortcut } from "@liveagent/ui/components/ui/sidebar";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo, type ReactNode } from "react";
import { ThemeToggleButton } from "../ThemeToggleButton";

export type ChatHeaderProps = {
  settings: AppSettings;
  sidebarOpen: boolean;
  onOpenSettings: (section?: "providers", providerId?: string) => void;
  onToggleTheme: () => void;
  onOpenSidebar: () => void;
  navigationActions?: ReactNode;
  leadingActions?: ReactNode;
  preThemeActions?: ReactNode;
  trailingActions?: ReactNode;
  windowControls?: ReactNode;
  className?: string;
};

export const ChatHeader = memo(function ChatHeader(props: ChatHeaderProps) {
  const {
    settings,
    sidebarOpen,
    onOpenSettings,
    onToggleTheme,
    onOpenSidebar,
    navigationActions,
    leadingActions,
    preThemeActions,
    trailingActions,
    windowControls,
    className,
  } = props;
  const { t } = useLocale();
  const sidebarToggleShortcut = useSidebarToggleShortcut();
  const desktopTitleBarInset = isDesktopChatHeaderInset();
  const sidebarToggleLabel = t(sidebarOpen ? "sidebar.closeSidebar" : "tooltip.openSidebar");

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex items-center gap-4 pl-4 pr-4 has-[[data-windows-window-controls]]:pr-0",
        className,
      )}
    >
      <div
        data-app-header-navigation=""
        className={cn(
          "flex min-w-0 shrink-0 items-center gap-1.5 transition-[min-width] duration-200 ease-out motion-reduce:transition-none",
          sidebarOpen &&
            "desktop:min-[768px]:min-w-[calc(var(--sidebar-width)-1rem)] web:min-[821px]:min-w-[calc(var(--sidebar-width)-1rem)]",
        )}
      >
        {navigationActions}
        {!desktopTitleBarInset ? (
          <ShortcutTooltip
            label={sidebarToggleLabel}
            shortcut={sidebarToggleShortcut}
            side="bottom"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onOpenSidebar}
              aria-expanded={sidebarOpen}
              aria-label={sidebarToggleLabel}
              className={cn(
                "rounded-lg text-muted-foreground hover:text-foreground",
                // web 端侧栏打开时折叠入口在侧栏品牌行（搜索右侧），顶部只保留收起态的展开入口；桌面端不变。
                sidebarOpen && "web:hidden",
              )}
            >
              <PanelLeft className="size-4.5" />
            </Button>
          </ShortcutTooltip>
        ) : null}
      </div>
      <div
        data-conversation-header=""
        data-tauri-drag-region
        className="flex h-full min-w-0 flex-1 items-center gap-1.5"
      >
        {leadingActions}
      </div>

      <div
        data-app-workbench-actions=""
        className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      >
        {preThemeActions}
        <ThemeToggleButton theme={settings.theme} onToggle={onToggleTheme} />
        {!sidebarOpen && !desktopTitleBarInset ? (
          <ShortcutTooltip label={t("tooltip.settings")} side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onOpenSettings()}
              aria-label={t("tooltip.settings")}
              className="rounded-lg text-muted-foreground hover:text-foreground"
            >
              <Settings className="size-4" />
            </Button>
          </ShortcutTooltip>
        ) : null}
        {trailingActions}
      </div>
      {windowControls}
    </header>
  );
});
