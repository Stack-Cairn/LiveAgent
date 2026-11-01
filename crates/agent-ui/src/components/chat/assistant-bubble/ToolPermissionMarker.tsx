import { useLocale } from "@liveagent/ui/i18n/index";
import type { ToolPermissionAutoResolved } from "@liveagent/ui/lib/chat/toolApprovalArgs";

/** 后端没有询问就放行的工具调用(只读操作或命中已记住的规则)在工具行上的小标记。 */
export function ToolPermissionMarker({ marker }: { marker: ToolPermissionAutoResolved | null }) {
  const { t } = useLocale();
  if (!marker) return null;
  const label =
    marker.source === "rule" ? t("chat.toolPermission.rule") : t("chat.toolPermission.readOnly");
  const title =
    marker.source === "rule" && marker.rule
      ? t("chat.toolPermission.ruleTitle").replace("{rule}", marker.rule)
      : label;
  return (
    <span
      data-permission-auto-resolved={marker.source}
      title={title}
      className="shrink-0 whitespace-nowrap text-tiny text-foreground/40"
    >
      {label}
    </span>
  );
}
