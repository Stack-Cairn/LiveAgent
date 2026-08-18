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
  if (props.theme === "light") return <Sun className="h-4 w-4" />;
  if (props.theme === "dark") return <Moon className="h-4 w-4" />;
  return <MonitorSmartphone className="h-4 w-4" />;
}

export type ChatHeaderProps = {
  settings: AppSettings;
  sidebarOpen: boolean;
  onOpenSettings: (section?: "providers", providerId?: string) => void;
  onToggleTheme: () => void;
  onOpenSidebar: () => void;
  leadingActions?: ReactNode;
  preThemeActions?: ReactNode;
  trailingActions?: ReactNode;
  className?: string;
};

export const ChatHeader = memo(function ChatHeader(props: ChatHeaderProps) {
  const {
    settings,
    sidebarOpen,
    onOpenSettings,
    onToggleTheme,
    onOpenSidebar,
    leadingActions,
    preThemeActions,
    trailingActions,
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
        "flex items-center justify-between gap-2 py-2.5 pr-4",
        !sidebarOpen && desktopTitleBarInset ? "pl-[232px]" : "pl-4",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {!sidebarOpen && !desktopTitleBarInset ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenSidebar}
            title={t("tooltip.openSidebar")}
            className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
          >
            <PanelLeft className="h-4.5 w-4.5" />
          </Button>
        ) : null}
        {leadingActions}
      </div>

      <div
        data-app-workbench-actions=""
        className="flex shrink-0 -translate-y-px items-center gap-1"
      >
        {preThemeActions}
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleTheme}
          title={themeToggleTitle}
          aria-label={themeToggleTitle}
          className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
        >
          <ThemeToggleIcon theme={nextTheme} />
        </Button>
        {!sidebarOpen && !desktopTitleBarInset ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenSettings()}
            title={t("tooltip.settings")}
            className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
          >
            <Settings className="h-4 w-4" />
          </Button>
        ) : null}
        {trailingActions}
      </div>
    </header>
  );
});
