import { useLocale } from "@liveagent/ui/i18n/index";

export type UnsupportedPaneSurfaceProps = {
  paneId: string;
  originalKind: string;
};

/** 前向兼容占位:布局中来自更新版本的未知 Surface,只展示、可移动/关闭。 */
export function UnsupportedPaneSurface(props: UnsupportedPaneSurfaceProps) {
  const { paneId, originalKind } = props;
  const { t } = useLocale();

  return (
    <div
      data-workbench-pane-id={paneId}
      data-workbench-surface="unsupported"
      className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-1.5 p-6 text-center"
    >
      <p className="text-sm text-muted-foreground">{t("workbench.unsupportedPane")}</p>
      <p className="font-mono text-xs text-muted-foreground/70">{originalKind}</p>
    </div>
  );
}
