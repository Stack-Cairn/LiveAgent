import { Popover } from "@base-ui/react";
import { ChevronDown, Plug } from "@liveagent/ui/components/IconSet";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { useLocale } from "@liveagent/ui/i18n/LocaleContext";
import {
  type AppliedPluginPromptContext,
  pluginPromptDisplayId,
  summarizeAppliedPromptPlugins,
} from "@liveagent/ui/lib/plugins/provenance";
import { memo, useMemo } from "react";

function ProvenanceRow(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="w-20 shrink-0 text-[10px] text-muted-foreground">{props.label}</span>
      <span
        className={`min-w-0 flex-1 break-all text-[10px] text-foreground ${props.mono ? "font-mono" : ""}`}
      >
        {props.value}
      </span>
    </div>
  );
}

/**
 * 弹层正文单独导出：Popover 只在打开时挂载，把这段做成独立组件才能被直接渲染断言，
 * 也让"注入证据"这件事有一个明确的组件边界。
 */
export function PluginContextProvenance(props: { context: AppliedPluginPromptContext }) {
  const { t } = useLocale();
  const plugins = useMemo(() => summarizeAppliedPromptPlugins(props.context), [props.context]);
  return (
    <>
      <p className="text-[11px] leading-4 text-muted-foreground">
        {t("chat.pluginContextExplain")}
      </p>
      <div className="mt-2.5 border-t border-border/60 pt-2.5">
        <ProvenanceRow
          label={t("chat.pluginContextSnapshot")}
          value={props.context.snapshotRevision}
          mono
        />
      </div>
      <ul className="mt-2 grid gap-2">
        {plugins.map((plugin) => (
          <li
            key={`${plugin.pluginId}:${plugin.pluginVersion}:${plugin.generation}`}
            className="rounded-lg border border-border/60 bg-background px-2.5 py-2"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[11px] font-semibold text-foreground">
                {pluginPromptDisplayId(plugin.pluginId)}
              </span>
              <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                v{plugin.pluginVersion}
              </span>
              {plugin.truncated ? (
                <Badge variant="muted" className="h-4 shrink-0 px-1 text-[9px]">
                  {t("chat.pluginContextTruncated")}
                </Badge>
              ) : null}
            </div>
            <div className="mt-1.5 grid gap-0.5">
              <ProvenanceRow label={t("chat.pluginContextPluginId")} value={plugin.pluginId} />
              <ProvenanceRow
                label={t("chat.pluginContextGeneration")}
                value={String(plugin.generation)}
              />
              <ProvenanceRow
                label={t("chat.pluginContextContributions")}
                value={plugin.contributionIds.join(", ")}
              />
              <ProvenanceRow
                label={t("chat.pluginContextPackage")}
                value={plugin.packageHash}
                mono
              />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

export const PluginContextBadge = memo(function PluginContextBadge(props: {
  context: AppliedPluginPromptContext;
}) {
  const { t } = useLocale();
  const plugins = useMemo(() => summarizeAppliedPromptPlugins(props.context), [props.context]);
  if (plugins.length === 0) return null;

  return (
    <Popover.Root>
      {/* Base UI 的 render 元素自带 children 会覆盖组件 children：可见内容必须写在
          元素内部，不能作为 Popover.Trigger 的子节点传入。 */}
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={t("chat.pluginContextApplied")}
            data-liveagent-plugin-context={props.context.snapshotRevision}
            className="group flex min-w-0 max-w-full flex-wrap items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground outline-hidden transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
          >
            <Plug aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-sky-500" />
            <span>{t("chat.pluginContextApplied")}</span>
            {plugins.map((plugin) => (
              <Badge
                key={`${plugin.pluginId}:${plugin.pluginVersion}:${plugin.generation}`}
                variant="outline"
                className="h-5 max-w-full px-1.5 font-mono text-[10px] text-foreground/80"
              >
                <span className="truncate">
                  {pluginPromptDisplayId(plugin.pluginId)} v{plugin.pluginVersion}
                </span>
              </Badge>
            ))}
            <ChevronDown
              aria-hidden="true"
              className="h-3 w-3 shrink-0 opacity-50 transition-transform group-data-[popup-open]:rotate-180"
            />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-[9999]">
          <Popover.Popup className="confirm-action-popover-popup w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-3 shadow-lg outline-none">
            <PluginContextProvenance context={props.context} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});
