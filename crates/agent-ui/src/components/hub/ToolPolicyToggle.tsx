// 工具审批策略三态控件(allow/ask/deny)。抽出后供系统工具设置页与 MCP Hub 就地
// 复用,保证各处外观一致。
// 两端直接复用本共享组件。

import type { ToolPolicy } from "@liveagent/app/lib/settings";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "../../lib/shared/utils";

const POLICY_ORDER: readonly ToolPolicy[] = ["allow", "ask", "deny"];

const POLICY_ACTIVE_STYLE: Record<ToolPolicy, string> = {
  allow: "bg-emerald-500 text-white",
  ask: "bg-amber-500 text-white",
  deny: "bg-red-500 text-white",
};

/**
 * 三态审批策略切换。value 为当前生效策略,onChange 回传所选。ariaLabel 给无障碍
 * 定位(工具名 / server id / 组名)。size="sm" 用于内联到卡片旁的紧凑场景。
 */
export function ToolPolicyToggle(props: {
  value: ToolPolicy;
  ariaLabel: string;
  onChange: (next: ToolPolicy) => void;
  size?: "sm" | "md";
}) {
  const { value, ariaLabel, onChange, size = "md" } = props;
  const { t } = useLocale();
  const buttonPad = size === "sm" ? "px-2 py-0.5" : "px-2.5 py-1";
  return (
    <fieldset
      aria-label={ariaLabel}
      className="inline-flex min-w-0 shrink-0 items-center rounded-lg border border-border/60 bg-muted/40 p-0.5"
    >
      {POLICY_ORDER.map((option) => {
        const active = value === option;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option)}
            className={cn(
              "rounded-md text-[11px] font-medium leading-none transition-colors",
              buttonPad,
              active ? POLICY_ACTIVE_STYLE[option] : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`settings.toolPolicy.${option}`)}
          </button>
        );
      })}
    </fieldset>
  );
}
