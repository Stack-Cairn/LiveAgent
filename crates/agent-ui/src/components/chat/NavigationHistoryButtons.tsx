import { ArrowLeft, ArrowRight } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { ShortcutTooltip } from "@liveagent/ui/components/ui/shortcut-tooltip";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { NavigationHistoryControls } from "@liveagent/ui/lib/navigation/navigationHistory";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  getShortcutBinding,
  useShortcutOverrides,
} from "@liveagent/ui/lib/shortcuts/shortcutCommands";

/** Back / forward buttons for the title bar. */
export function NavigationHistoryButtons({
  history,
  className,
}: {
  history: NavigationHistoryControls;
  className?: string;
}) {
  const { t } = useLocale();
  const overrides = useShortcutOverrides();
  const buttons = [
    {
      key: "back",
      label: t("shortcuts.command.navigateBack"),
      shortcut: getShortcutBinding("navigateBack", overrides) || null,
      enabled: history.canGoBack,
      run: history.goBack,
      Icon: ArrowLeft,
    },
    {
      key: "forward",
      label: t("shortcuts.command.navigateForward"),
      shortcut: getShortcutBinding("navigateForward", overrides) || null,
      enabled: history.canGoForward,
      run: history.goForward,
      Icon: ArrowRight,
    },
  ];
  return (
    <div
      data-navigation-history=""
      className={cn(
        // Leave room for the hit areas of the touch-sized buttons beside it.
        "flex shrink-0 items-center [-webkit-app-region:no-drag] [@media(pointer:coarse)]:mx-1.5",
        className,
      )}
    >
      {buttons.map(({ key, label, shortcut, enabled, run, Icon }) => (
        <ShortcutTooltip key={key} label={label} shortcut={shortcut} side="bottom">
          <Button
            variant="ghost"
            size="icon-sm"
            data-navigation-history-button={key}
            aria-label={label}
            // aria-disabled keeps the tooltip reachable while there is nowhere to go.
            aria-disabled={!enabled}
            onClick={() => {
              if (enabled) run();
            }}
            className={cn(
              "rounded-lg text-muted-foreground hover:text-foreground",
              !enabled &&
                "cursor-default opacity-40 hover:bg-transparent hover:text-muted-foreground",
            )}
          >
            <Icon className="size-4" />
          </Button>
        </ShortcutTooltip>
      ))}
    </div>
  );
}
