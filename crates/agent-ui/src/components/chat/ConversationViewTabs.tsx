import { useLocale } from "../../i18n/index";
import { cn } from "../../lib/shared/utils";
import { MessageSquareText, Waypoints } from "../IconSet";

export type ConversationViewId = "conversation" | "trajectory";

export function ConversationViewTabs(props: {
  active: ConversationViewId;
  onChange: (view: ConversationViewId) => void;
  className?: string;
}) {
  const { t } = useLocale();
  const tabs = [
    {
      id: "conversation",
      labelKey: "trajectory.tab.conversation",
      icon: MessageSquareText,
    },
    { id: "trajectory", labelKey: "trajectory.tab.trajectory", icon: Waypoints },
  ] as const;

  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5",
        props.className,
      )}
    >
      {tabs.map((tab) => {
        const selected = props.active === tab.id;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
              "text-muted-foreground hover:bg-background/70 hover:text-foreground",
              selected && "bg-background font-medium text-foreground shadow-sm",
            )}
            onClick={() => {
              if (!selected) props.onChange(tab.id);
            }}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{t(tab.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}
