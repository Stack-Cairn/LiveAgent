/**
 * 转录区上方的「对话 / 轨迹」切换。
 *
 * 两端共用同一个组件，各自传自己的转录节点与轨迹节点——GUI 与 WebUI 的数据控制器
 * 不同，但视图切换的语义必须完全一致。
 */

import { useLocale } from "../../i18n/index";
import { cn } from "../../lib/shared/utils";

export type ConversationViewId = "conversation" | "trajectory";

export function ConversationViewTabs(props: {
  active: ConversationViewId;
  onChange: (view: ConversationViewId) => void;
  className?: string;
}) {
  const { t } = useLocale();
  const tabs: readonly { id: ConversationViewId; labelKey: string }[] = [
    { id: "conversation", labelKey: "trajectory.tab.conversation" },
    { id: "trajectory", labelKey: "trajectory.tab.trajectory" },
  ];

  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      className={cn(
        "flex shrink-0 items-center gap-1 border-b border-border/60 px-3",
        props.className,
      )}
    >
      {tabs.map((tab) => {
        const selected = props.active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            className={cn(
              "relative -mb-px px-3 py-1.5 text-[13px] transition-colors",
              "border-b-2 border-transparent text-muted-foreground hover:text-foreground",
              selected && "border-primary font-medium text-foreground",
            )}
            onClick={() => {
              if (!selected) props.onChange(tab.id);
            }}
          >
            {t(tab.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
