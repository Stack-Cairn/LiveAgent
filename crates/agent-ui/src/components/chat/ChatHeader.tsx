import { isDesktopChatHeaderInset } from "@liveagent/adapters/chatHeaderChrome";
import { type AppSettings, getNextTheme, type Theme } from "@liveagent/app/lib/settings";
import {
  MonitorSmartphone,
  Moon,
  PanelLeft,
  Settings,
  Sun,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo, type ReactNode } from "react";

function ThemeToggleIcon(props: { theme: Theme }) {
  if (props.theme === "light") return <Sun className="size-4" />;
  if (props.theme === "dark") return <Moon className="size-4" />;
  return <MonitorSmartphone className="size-4" />;
}

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
  const nextTheme = getNextTheme(settings.theme);
  const themeToggleTitle =
    nextTheme === "light"
      ? t("tooltip.switchToLight")
      : nextTheme === "dark"
        ? t("tooltip.switchToDark")
        : t("tooltip.switchToAuto");
  const desktopTitleBarInset = isDesktopChatHeaderInset();

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
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenSidebar}
            title={t(sidebarOpen ? "sidebar.closeSidebar" : "tooltip.openSidebar")}
            aria-expanded={sidebarOpen}
            aria-label={t(sidebarOpen ? "sidebar.closeSidebar" : "tooltip.openSidebar")}
            className={cn(
              "rounded-lg text-muted-foreground hover:text-foreground",
              // web 端侧栏打开时折叠入口在侧栏品牌行（搜索右侧），顶部只保留收起态的展开入口；桌面端不变。
              sidebarOpen && "web:hidden",
            )}
          >
            <PanelLeft className="size-4.5" />
          </Button>
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
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleTheme}
          title={themeToggleTitle}
          aria-label={themeToggleTitle}
          className="rounded-lg text-muted-foreground hover:text-foreground"
        >
          <ThemeToggleIcon theme={nextTheme} />
        </Button>
        {!sidebarOpen && !desktopTitleBarInset ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onOpenSettings()}
            title={t("tooltip.settings")}
            className="rounded-lg text-muted-foreground hover:text-foreground"
          >
            <Settings className="size-4" />
          </Button>
        ) : null}
        {trailingActions}
      </div>
      {windowControls}
    </header>
  );
});
