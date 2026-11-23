// Right dock "Panels" tool: plugin UI panels placed in the side pane (K-brain capability
// `plugin_ui`) and the current conversation's HTML previews (`html_previews`), one at a
// time, each in the shared sandboxed frame.

import "@liveagent/ui/i18n/namespaces/projectTools";
import { AppWindow, Plug, RefreshCw } from "@liveagent/ui/components/IconSet";
import { HtmlPreviewFrame } from "@liveagent/ui/components/sandboxed-ui/HtmlPreviewCard";
import { PluginPanelFrame } from "@liveagent/ui/components/sandboxed-ui/PluginPanelFrame";
import { EmptyState } from "@liveagent/ui/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  listHtmlPreviews,
  readHtmlPreviewSidePanelRequest,
  useHtmlPreviewsVersion,
} from "@liveagent/ui/lib/chat/htmlPreviews";
import {
  listPluginPanels,
  type PluginsClient,
  pluginPanelKey,
} from "@liveagent/ui/lib/plugins/types";
import { usePluginList } from "@liveagent/ui/lib/plugins/usePluginList";
import { useEffect, useMemo, useRef, useState } from "react";

/** What the dock needs to show the current conversation's previews. */
export type RightDockHtmlPreviews = {
  conversationId: string;
  loadPreviewHtml: (url: string) => Promise<string>;
};

export type SandboxedPanelsPanelProps = {
  active: boolean;
  plugins: PluginsClient | null;
  previews: RightDockHtmlPreviews | null;
  workdir: string;
  onOpenFile?: (path: string, line?: number) => void;
};

type PanelOption =
  | { key: string; kind: "plugin"; label: string; group: string }
  | { key: string; kind: "preview"; label: string; group: string };

export function SandboxedPanelsPanel(props: SandboxedPanelsPanelProps) {
  const { active, plugins, previews, workdir, onOpenFile } = props;
  const { t } = useLocale();
  const { list, refresh } = usePluginList(plugins, workdir || undefined);
  const previewsVersion = useHtmlPreviewsVersion(previews?.conversationId);
  const [selected, setSelected] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const handledRequest = useRef(0);

  const pluginPanels = useMemo(() => listPluginPanels(list, "sidePane"), [list]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the version tracks store changes.
  const previewList = useMemo(
    () => (previews ? listHtmlPreviews(previews.conversationId) : []),
    [previews, previewsVersion],
  );

  const options = useMemo<PanelOption[]>(() => {
    const items: PanelOption[] = pluginPanels.map(({ plugin, panel }) => ({
      key: `plugin:${pluginPanelKey(plugin.id, panel.id)}`,
      kind: "plugin",
      label: `${plugin.name} · ${panel.title}`,
      group: t("sandboxedUi.dock.pluginGroup"),
    }));
    for (const preview of [...previewList].reverse()) {
      items.push({
        key: `preview:${preview.previewId}`,
        kind: "preview",
        label:
          preview.title || preview.path?.split(/[\\/]/).pop() || t("sandboxedUi.preview.untitled"),
        group: t("sandboxedUi.dock.previewGroup"),
      });
    }
    return items;
  }, [pluginPanels, previewList, t]);

  // "Open in side panel" from a preview card selects that preview.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the version tracks store changes.
  useEffect(() => {
    if (!previews) return;
    const request = readHtmlPreviewSidePanelRequest(previews.conversationId);
    if (!request || request.nonce === handledRequest.current) return;
    handledRequest.current = request.nonce;
    setSelected(`preview:${request.previewId}`);
  }, [previews, previewsVersion]);

  const current = options.find((option) => option.key === selected) ?? options[0] ?? null;
  const pluginEntry =
    current?.kind === "plugin"
      ? pluginPanels.find(
          ({ plugin, panel }) => `plugin:${pluginPanelKey(plugin.id, panel.id)}` === current.key,
        )
      : undefined;
  const previewEntry =
    current?.kind === "preview"
      ? previewList.find((preview) => `preview:${preview.previewId}` === current.key)
      : undefined;

  if (!current) {
    return (
      <EmptyState data-sandboxed-panels="empty">
        <Plug className="size-5" />
        <div className="max-w-xs text-xs leading-5">{t("sandboxedUi.dock.empty")}</div>
      </EmptyState>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-sandboxed-panels="">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/50 px-2">
        <AppWindow className="size-3.5 shrink-0 text-muted-foreground" />
        <Select value={current.key} onValueChange={(value) => setSelected(String(value))}>
          <SelectTrigger className="h-7 min-w-0 flex-1 justify-between text-xs">
            <SelectValue>{current.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.key} value={option.key}>
                <span className="text-muted-foreground">{option.group} · </span>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          title={t("sandboxedUi.reload")}
          aria-label={t("sandboxedUi.reload")}
          onClick={() => setReloadKey((key) => key + 1)}
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        {pluginEntry && plugins ? (
          <PluginPanelFrame
            key={`${current.key}:${reloadKey}`}
            client={plugins}
            plugin={pluginEntry.plugin}
            panel={pluginEntry.panel}
            workdir={workdir || undefined}
            visible={active}
            onOpenFile={onOpenFile}
            onStale={() => void refresh()}
          />
        ) : previewEntry && previews ? (
          <HtmlPreviewFrame
            key={current.key}
            preview={previewEntry}
            load={previews.loadPreviewHtml}
            reloadKey={reloadKey}
            className="h-full min-h-0 flex-1"
          />
        ) : null}
      </div>
    </div>
  );
}
