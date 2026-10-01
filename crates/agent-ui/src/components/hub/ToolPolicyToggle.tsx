import type { ToolPolicy } from "@liveagent/app/lib/settings";
import { useLocale } from "@liveagent/ui/i18n/index";
import { SettingsToggleGroup, SettingsToggleGroupItem } from "../settings/SettingsToggleGroup";

const POLICY_ORDER: readonly ToolPolicy[] = ["allow", "ask", "deny"];

/**
 * 三态审批策略切换。value 为当前生效策略,onChange 回传所选。ariaLabel 给无障碍
 * 定位(工具名 / server id / 组名)。
 */
export function ToolPolicyToggle(props: {
  value: ToolPolicy;
  ariaLabel: string;
  onChange: (next: ToolPolicy) => void;
}) {
  const { value, ariaLabel, onChange } = props;
  const { t } = useLocale();
  return (
    <SettingsToggleGroup
      value={[value]}
      aria-label={ariaLabel}
      onValueChange={(values) => {
        const next = values[0];
        if (next === "allow" || next === "ask" || next === "deny") onChange(next);
      }}
    >
      {POLICY_ORDER.map((option) => (
        <SettingsToggleGroupItem key={option} value={option}>
          {t(`settings.toolPolicy.${option}`)}
        </SettingsToggleGroupItem>
      ))}
    </SettingsToggleGroup>
  );
}
