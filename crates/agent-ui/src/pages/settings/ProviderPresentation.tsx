import type { UsagePlanDisplay, UsageRelativeTime } from "@liveagent/app/lib/providers/usageQuery";
import type { PromptCacheHintMode, ProviderId } from "@liveagent/app/lib/settings";
import {
  ClaudeIcon,
  DeepseekIcon,
  GeminiIcon,
  GrokIcon,
  Info,
  OpenaiChatgptIcon,
} from "@liveagent/ui/components/IconSet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@liveagent/ui/components/ui/tooltip";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  isReservedCustomHeaderKey,
  isValidCustomHeaderKey,
  isValidCustomHeaderValue,
} from "@liveagent/ui/lib/providers/customHeaders";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ReactNode } from "react";

// 脚本编写说明里的示例代码(纯代码,locale 无关);语义须与 Rust 沙箱执行
// 契约一致:声明式单请求 + extractor 接收响应 JSON。
export const USAGE_QUERY_SCRIPT_HELP_EXAMPLE = `({
  request: {
    url: "{{baseUrl}}/api/usage",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}"
    }
  },
  extractor: function (response) {
    return {
      planName: "Pro",
      remaining: response.balance,
      total: response.quota,
      unit: "USD"
    };
  }
})`;

function usagePlanTitleText(
  t: (key: string) => string,
  title: UsagePlanDisplay["title"],
): string | null {
  if (title.kind === "window") return t(`settings.providerUsageWindow.${title.token}`);
  if (title.kind === "text") return title.text;
  return null;
}

export function usageRelativeTimeText(t: (key: string) => string, time: UsageRelativeTime): string {
  switch (time.kind) {
    case "justNow":
      return t("settings.providerUsageUpdated.justNow");
    case "minutesAgo":
      return t("settings.providerUsageUpdated.minutesAgo").replace("{count}", String(time.value));
    case "hoursAgo":
      return t("settings.providerUsageUpdated.hoursAgo").replace("{count}", String(time.value));
    case "daysAgo":
      return t("settings.providerUsageUpdated.daysAgo").replace("{count}", String(time.value));
  }
}

// 单个套餐/余额行:失效红、余量 <10% 橙、正常绿(对齐 cc-switch UsageFooter 分级)。
export function UsagePlanLine({ plan }: { plan: UsagePlanDisplay }) {
  const { t } = useLocale();
  const title = usagePlanTitleText(t, plan.title);
  if (plan.invalid) {
    return (
      <span className="flex min-w-0 items-baseline gap-1.5 text-destructive">
        {title ? <span className="truncate">{title}</span> : null}
        <span className="truncate">
          {plan.invalidMessage ?? t("settings.providerUsageInvalid")}
        </span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      {title ? <span className="truncate">{title}</span> : null}
      <span
        className={cn(
          "whitespace-nowrap font-medium",
          plan.severity === "low"
            ? "text-amber-500 dark:text-amber-400"
            : "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {plan.amount ?? "—"}
        {plan.total ? ` / ${plan.total}` : ""}
        {plan.unit ? ` ${plan.unit}` : ""}
      </span>
      {plan.percent !== null && plan.unit !== "%" ? (
        <span className="whitespace-nowrap text-muted-foreground">{plan.percent}%</span>
      ) : null}
      {plan.extra ? <span className="truncate text-muted-foreground">{plan.extra}</span> : null}
    </span>
  );
}

export const PROVIDER_TABS: ProviderId[] = ["claude_code", "codex", "gemini", "xai", "deepseek"];

const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude_code: "Anthropic",
  codex: "OpenAI",
  gemini: "Gemini",
  xai: "Grok",
  deepseek: "DeepSeek",
};

export const PROMPT_CACHE_HINT_LABEL_KEYS: Record<PromptCacheHintMode, string> = {
  auto: "settings.promptCacheHintMode.auto",
  "openai-key": "settings.promptCacheHintMode.openaiKey",
  "openrouter-session": "settings.promptCacheHintMode.openrouterSession",
  none: "settings.promptCacheHintMode.none",
};

export function getProviderLabel(type: ProviderId) {
  return PROVIDER_LABELS[type];
}

export function ProviderBrandIcon({ type }: { type: ProviderId }) {
  if (type === "claude_code") return <ClaudeIcon height="1em" />;
  if (type === "gemini") return <GeminiIcon height="1em" />;
  if (type === "xai") return <GrokIcon height="1em" />;
  if (type === "deepseek") return <DeepseekIcon height="1em" />;
  return <OpenaiChatgptIcon height="1em" className="fill-current dark:text-white" />;
}

/**
 * 悬停/聚焦即显的说明气泡：替代抽屉里成段的描述性文字，仅在需要时展开。
 */
export function HintTip(props: { text: string; label?: string }) {
  const { text, label } = props;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={0}
        render={
          <button
            type="button"
            aria-label={label ?? text}
            className="inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full text-muted-foreground/55 transition-colors hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        }
      >
        <Info className="h-3 w-3" />
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        className="max-w-60 px-2.5 py-2 text-[11px] font-normal leading-relaxed text-popover-foreground/90"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

/** 抽屉字段标签：小号标签 + 可选的说明气泡。 */
export function DrawerFieldLabel(props: { label: string; hint?: string }) {
  const { label, hint } = props;
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs font-medium text-foreground/75">{label}</span>
      {hint ? <HintTip text={hint} label={label} /> : null}
    </div>
  );
}

/**
 * 抽屉分组标题：微型弱化标题 + 向右延伸的发丝线。
 * 与字段标签（DrawerFieldLabel）拉开层级：分组标题更小、更淡、带字距，
 * 视觉上作为"类别分隔"存在，避免与紧随其后的字段标签混为一谈。
 */
export function DrawerGroupLabel(props: { label: string; hint?: string }) {
  const { label, hint } = props;
  return (
    <div className="flex items-center gap-2">
      <span className="flex shrink-0 items-center gap-1 text-[10.5px] font-semibold uppercase leading-none tracking-[0.08em] text-muted-foreground/65">
        {label}
        {hint ? <HintTip text={hint} label={label} /> : null}
      </span>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-foreground/[0.07]" />
    </div>
  );
}

/** 抽屉分区头：图标块 + 标题 + 说明气泡 + 右侧控件插槽。 */
export function DrawerSectionHeader(props: {
  icon: ReactNode;
  title: string;
  hint?: string;
  badge?: ReactNode;
  action?: ReactNode;
}) {
  const { icon, title, hint, badge, action } = props;
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-foreground/[0.05] bg-foreground/[0.04] text-foreground/70">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <h3 className="truncate text-[13px] font-semibold tracking-tight text-foreground/90">
          {title}
        </h3>
        {hint ? <HintTip text={hint} label={title} /> : null}
        {badge}
      </div>
      {action}
    </div>
  );
}

export function DialogSwitch(props: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  const { checked, onCheckedChange, ariaLabel } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      onClick={() => onCheckedChange(!checked)}
    >
      <span
        className={cn(
          "relative block h-5 w-9 rounded-full bg-muted-foreground/35 transition-colors",
          checked && "bg-primary",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-background shadow-sm transition-transform",
            checked && "translate-x-4",
          )}
        />
      </span>
    </button>
  );
}

export type CustomHeaderIssue = "reserved" | "invalid-key" | "invalid-value";

export function customHeaderIssueMessage(
  issue: CustomHeaderIssue,
  t: (key: string) => string,
): string {
  if (issue === "reserved") return t("settings.customHeaderReservedTitle");
  if (issue === "invalid-value") return t("settings.invalidCustomHeaderValue");
  return t("settings.invalidCustomHeaderKey");
}

export function getCustomHeaderIssue(
  header: { key: string; value: string },
  includeEmpty = false,
): CustomHeaderIssue | null {
  if (!header.key && !includeEmpty) return null;
  if (isReservedCustomHeaderKey(header.key)) return "reserved";
  if (!isValidCustomHeaderKey(header.key)) return "invalid-key";
  return isValidCustomHeaderValue(header.value) ? null : "invalid-value";
}

export function itemsByIdOrder<T extends { id: string }>(
  items: readonly T[],
  order: readonly string[],
) {
  const byId = new Map(items.map((item) => [item.id, item]));
  return order.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}
