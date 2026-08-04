// 系统工具设置:展示 Agent 模式下自动注册的内置工具,并为每个工具设置审批策略
//(allow 直接执行 / ask 执行前询问 / deny 直接拒绝)。纯设置读写
//(settings.system.toolPolicies),经 settings sync 自然同步到 WebUI;裁决在桌面端
// resolveToolPolicy。本文件在 agent-gui 与 agent-gateway/web 之间逐字节镜像。
//
// 说明:MCP 工具按 server、插件工具按工具的策略已就地内联到各自 Hub 卡片旁
//(需运行时数据),不在本节;本节聚焦内置工具,补上内置工具此前不可管控的缺口。
import { useMemo } from "react";
import { ToolPolicyToggle } from "../../components/hub/ToolPolicyToggle";
import { Wrench } from "../../components/icons";
import { useLocale } from "../../i18n";
import { type ToolPolicy, updateSystem } from "../../lib/settings";
import { BUILTIN_TOOL_CATALOG, BUILTIN_TOOL_CATEGORIES } from "../../lib/tools/builtinToolCatalog";
import type { SettingsSectionProps } from "./types";

// 交互式应答超时（分钟）档位表：60 分钟内档位密（细调），超过 60 分钟直接跳最大档
// 99999（≈ 超长等待）。滑块只在这些档位上取整，保证时间始终是常见可读的分钟数。
const TIMEOUT_STOPS = [
  1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 99999,
];

export function SystemToolsSection(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();

  const policies = settings.system.toolPolicies ?? {};

  const groups = useMemo(
    () =>
      BUILTIN_TOOL_CATEGORIES.map((category) => ({
        category,
        entries: BUILTIN_TOOL_CATALOG.filter((entry) => entry.categoryId === category.id),
      })).filter((group) => group.entries.length > 0),
    [],
  );

  // 只读工具无副作用,恒定放行(与 resolveToolPolicy 的缺省一致),不提供切换。
  function effectivePolicy(toolName: string, isReadOnly: boolean): ToolPolicy {
    if (isReadOnly) return "allow";
    return policies[toolName] ?? "allow";
  }

  function setPolicy(toolName: string, next: ToolPolicy) {
    setSettings((prev) => {
      const current = { ...(prev.system.toolPolicies ?? {}) };
      // allow 是内置工具的缺省,显式写入无意义 → 删除该键保持配置精简。
      if (next === "allow") {
        delete current[toolName];
      } else {
        current[toolName] = next;
      }
      return updateSystem(prev, {
        toolPolicies: Object.keys(current).length > 0 ? current : undefined,
      });
    });
  }

  const overriddenCount = Object.keys(policies).length;

  // 交互式应答超时（分钟）：AskUserQuestion 提问卡与工具审批栏共用同一等待窗口。
  // 滑块按档位表映射（TIMEOUT_STOPS，见文件头），最右档 = 99999。
  const timeoutMinutes = settings.system.interactiveTimeoutMinutes;
  const timeoutStopIndex = TIMEOUT_STOPS.reduce(
    (best, stop, i) =>
      Math.abs(stop - timeoutMinutes) < Math.abs(TIMEOUT_STOPS[best] - timeoutMinutes) ? i : best,
    0,
  );
  const onTimeoutStopChange = (index: number) => {
    const next = TIMEOUT_STOPS[index];
    if (next !== timeoutMinutes) {
      setSettings((prev) => updateSystem(prev, { interactiveTimeoutMinutes: next }));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Wrench className="h-[18px] w-[18px] text-primary" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("settings.systemTools")}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {t("settings.systemToolsDesc")}
          </p>
        </div>
        {overriddenCount > 0 ? (
          <span className="ml-auto shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium leading-none text-primary">
            {t("settings.toolPermissionsOverridden").replace("{count}", String(overriddenCount))}
          </span>
        ) : null}
      </div>

      <div className="space-y-4">
        {groups.map(({ category, entries }) => (
          <div key={category.id} className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {t(category.labelKey)}
            </div>
            <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/50 bg-background/60">
              {entries.map((entry) => {
                const policy = effectivePolicy(entry.toolName, entry.isReadOnly);
                return (
                  <div key={entry.id} className="flex items-start gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-sm font-medium">
                          {t(`settings.builtinTool.${entry.id}.name`)}
                        </span>
                        <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
                          {entry.toolName}
                        </code>
                        {entry.isReadOnly ? (
                          <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] leading-none text-emerald-500">
                            {t("settings.toolDetailReadOnly")}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 truncate text-xs leading-relaxed text-muted-foreground">
                        {t(`settings.builtinTool.${entry.id}.desc`)}
                      </div>
                    </div>
                    {entry.isReadOnly && entry.id === "ask_user_question" ? (
                      <div className="w-52 shrink-0">
                        <input
                          type="range"
                          min={0}
                          max={TIMEOUT_STOPS.length - 1}
                          step={1}
                          value={timeoutStopIndex}
                          aria-label={t("settings.interactiveTimeout.title")}
                          onChange={(event) => onTimeoutStopChange(Number(event.currentTarget.value))}
                          className="w-full accent-primary"
                        />
                        <div className="mt-1 text-right text-xs text-muted-foreground">
                          <span className="font-medium tabular-nums">{timeoutMinutes}</span>{" "}
                          {t("settings.interactiveTimeout.unit")}
                        </div>
                      </div>
                    ) : entry.isReadOnly ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground/60">
                        {t("settings.toolPolicy.allow")}
                      </span>
                    ) : (
                      <ToolPolicyToggle
                        value={policy}
                        ariaLabel={entry.toolName}
                        onChange={(next) => setPolicy(entry.toolName, next)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
