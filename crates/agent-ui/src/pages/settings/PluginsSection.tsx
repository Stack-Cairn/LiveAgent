// Settings > Plugins (K-brain capability `plugins`): user and workspace plugins with what
// they contribute, enable/disable, reload, install from a folder, remove, load errors, and
// each plugin's settings panels (capability `plugin_ui`). The list follows the backend
// live through the plugin long-poll.

import { useDirectoryPicker } from "@liveagent/adapters/directoryPicker";
import { WorkspaceFolderTrustSection } from "@liveagent/ui/components/chat/workspace-project-settings/WorkspaceFolderTrustSection";
import {
  AlertTriangle,
  ChevronRight,
  FolderOpen,
  Loader2,
  Plug,
  RefreshCw,
  Trash2,
} from "@liveagent/ui/components/IconSet";
import { PluginPanelFrame } from "@liveagent/ui/components/sandboxed-ui/PluginPanelFrame";
import { SettingsSection } from "@liveagent/ui/components/settings/SettingsLayout";
import { SettingsNotice } from "@liveagent/ui/components/settings/SettingsNotice";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { EmptyState } from "@liveagent/ui/components/ui/empty-state";
import type { WorkspaceFolderTrustClient } from "@liveagent/ui/contracts/workspaceFolderTrust";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type PluginInfo,
  type PluginList,
  type PluginsClient,
  PluginsHttpError,
  pluginManifestToolNames,
} from "@liveagent/ui/lib/plugins/types";
import { usePluginList } from "@liveagent/ui/lib/plugins/usePluginList";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { AgentActivationSwitch } from "@liveagent/ui/pages/settings/shared";
import { useCallback, useState } from "react";

const SETTINGS_PANEL_HEIGHT = 360;

export type PluginsSectionProps = {
  client: PluginsClient;
  /** The current project folder: workspace plugins come from <workdir>/.liveagent/plugins. */
  workdir?: string;
  /** Present when the plugin UI capability is advertised: settings panels render. */
  panels: boolean;
  trustClient?: WorkspaceFolderTrustClient;
};

/** User-facing message of a failed plugin action. */
export function describePluginActionError(
  error: unknown,
  t: (key: string) => string,
  action: "remove" | "other",
): string {
  if (error instanceof PluginsHttpError || (error as { status?: unknown })?.status !== undefined) {
    const status = (error as { status?: number }).status;
    if (action === "remove" && status === 409) return t("sandboxedUi.plugins.removeWorkspace");
    if (status === 404) return t("sandboxedUi.plugins.notFound");
  }
  return error instanceof Error && error.message ? error.message : String(error);
}

function ContributesSummary({ plugin }: { plugin: PluginInfo }) {
  const { t } = useLocale();
  const parts: string[] = [];
  const { tools, hooks, prompt, ui } = plugin.contributes;
  if (tools.length)
    parts.push(t("sandboxedUi.plugins.tools").replace("{count}", String(tools.length)));
  if (hooks.length)
    parts.push(t("sandboxedUi.plugins.hooks").replace("{count}", String(hooks.length)));
  if (prompt) parts.push(t("sandboxedUi.plugins.prompt"));
  if (ui.length) parts.push(t("sandboxedUi.plugins.panels").replace("{count}", String(ui.length)));
  if (parts.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {parts.map((part) => (
        <Badge key={part} variant="muted">
          {part}
        </Badge>
      ))}
    </div>
  );
}

function PluginRow(props: {
  plugin: PluginInfo;
  client: PluginsClient;
  workdir?: string;
  panels: boolean;
  busy: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onStale: () => void;
}) {
  const { plugin, client, workdir, panels, busy, onToggle, onRemove, onStale } = props;
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const settingsPanels = panels
    ? plugin.contributes.ui.filter((panel) => panel.placement === "settings")
    : [];
  const toolNames = pluginManifestToolNames(plugin);
  return (
    <div className="rounded-xl bg-settings-tile" data-plugin-id={plugin.id}>
      <div className="flex items-start gap-3 px-4 py-3.5 max-[560px]:flex-col">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight
            className={cn(
              "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">{plugin.name}</span>
              {plugin.version ? (
                <span className="text-xs text-muted-foreground">{plugin.version}</span>
              ) : null}
              <Badge variant={plugin.source === "workspace" ? "outline" : "muted"}>
                {plugin.source === "workspace"
                  ? t("sandboxedUi.plugins.sourceWorkspace")
                  : t("sandboxedUi.plugins.sourceUser")}
              </Badge>
            </div>
            {plugin.description ? (
              <p className="text-xs leading-5 text-muted-foreground">{plugin.description}</p>
            ) : null}
            <ContributesSummary plugin={plugin} />
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={busy}
            title={t("sandboxedUi.plugins.remove")}
            aria-label={t("sandboxedUi.plugins.remove")}
            onClick={onRemove}
          >
            <Trash2 className="size-4" />
          </Button>
          <AgentActivationSwitch
            checked={plugin.enabled}
            disabled={busy}
            title={
              plugin.enabled ? t("sandboxedUi.plugins.disable") : t("sandboxedUi.plugins.enable")
            }
            onToggle={onToggle}
          />
        </div>
      </div>
      {open ? (
        <div className="space-y-3 border-t border-border/40 px-4 py-3 text-xs">
          <div className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted-foreground">
            <span>{t("sandboxedUi.plugins.id")}</span>
            <span className="truncate font-mono text-foreground/85">{plugin.id}</span>
            <span>{t("sandboxedUi.plugins.path")}</span>
            <span className="truncate font-mono text-foreground/85" title={plugin.path}>
              {plugin.path}
            </span>
            {toolNames.length ? (
              <>
                <span>{t("sandboxedUi.plugins.toolList")}</span>
                <span className="font-mono text-foreground/85">
                  {plugin.contributes.toolDetails
                    ? plugin.contributes.toolDetails.map((tool, index) => (
                        <span
                          key={tool.name}
                          // The name the model sees, which permission rules use.
                          title={[tool.modelName, tool.description].filter(Boolean).join(" · ")}
                        >
                          {index > 0 ? ", " : ""}
                          {tool.name}
                        </span>
                      ))
                    : toolNames.join(", ")}
                </span>
              </>
            ) : null}
          </div>
          {settingsPanels.map((panel) =>
            panel.url ? (
              <div
                key={panel.id}
                className="overflow-hidden rounded-lg border border-border/60 bg-background"
              >
                <div className="border-b border-border/50 px-3 py-1.5 font-medium text-foreground/85">
                  {panel.title}
                </div>
                <div className="flex" style={{ height: SETTINGS_PANEL_HEIGHT }}>
                  <PluginPanelFrame
                    client={client}
                    plugin={plugin}
                    panel={{ ...panel, url: panel.url }}
                    workdir={workdir}
                    visible
                    onStale={onStale}
                  />
                </div>
              </div>
            ) : (
              <p key={panel.id} className="text-muted-foreground">
                {t("sandboxedUi.plugins.panelDisabled").replace("{title}", panel.title)}
              </p>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

export function PluginsSection({ client, workdir, panels, trustClient }: PluginsSectionProps) {
  const { t } = useLocale();
  const { list, error, loading, adopt, refresh } = usePluginList(client, workdir);
  const { pickDirectory, directoryPickerElement } = useDirectoryPicker();
  const { confirm, dialog } = useConfirmDialog();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = useCallback(
    async (key: string, action: () => Promise<PluginList>, kind: "remove" | "other" = "other") => {
      setBusyId(key);
      setActionError(null);
      try {
        adopt(await action());
      } catch (failure) {
        setActionError(describePluginActionError(failure, t, kind));
      } finally {
        setBusyId(null);
      }
    },
    [adopt, t],
  );

  const install = async () => {
    const picked = await pickDirectory(workdir ?? "");
    if (!picked) return;
    await run("install", () => client.install(picked, workdir));
  };

  const remove = async (plugin: PluginInfo) => {
    if (plugin.source === "workspace") {
      // The backend refuses (409): workspace plugins belong to the project's files.
      setActionError(t("sandboxedUi.plugins.removeWorkspace"));
      return;
    }
    const ok = await confirm({
      title: t("sandboxedUi.plugins.removeTitle").replace("{name}", plugin.name),
      description: t("sandboxedUi.plugins.removeDescription"),
      confirmLabel: t("sandboxedUi.plugins.remove"),
      cancelLabel: t("sandboxedUi.cancel"),
      tone: "destructive",
    });
    if (ok) await run(plugin.id, () => client.remove(plugin.id, workdir), "remove");
  };

  const plugins = list?.plugins ?? [];
  const workspaceUntrusted = Boolean(list?.workdir && !list.trusted);

  return (
    <SettingsSection
      title={t("sandboxedUi.plugins.title")}
      description={t("sandboxedUi.plugins.description")}
      actions={
        <>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busyId !== null}
            onClick={() => void run("reload", () => client.reload(workdir))}
          >
            {busyId === "reload" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            {t("sandboxedUi.plugins.reload")}
          </Button>
          <Button type="button" size="sm" disabled={busyId !== null} onClick={() => void install()}>
            {busyId === "install" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FolderOpen className="size-4" />
            )}
            {t("sandboxedUi.plugins.install")}
          </Button>
        </>
      }
      data-settings-anchor="plugins"
    >
      {actionError ? (
        <SettingsNotice variant="action-error" role="alert">
          <AlertTriangle className="size-4 shrink-0" />
          <span>{actionError}</span>
        </SettingsNotice>
      ) : null}
      {error && !list ? (
        <SettingsNotice variant="action-error" role="alert">
          <AlertTriangle className="size-4 shrink-0" />
          <span>{error}</span>
        </SettingsNotice>
      ) : null}
      {list?.errors.length ? (
        <SettingsNotice variant="warning" data-plugin-errors="">
          <div className="mb-1 font-medium">{t("sandboxedUi.plugins.errors")}</div>
          <ul className="list-disc space-y-0.5 pl-4">
            {list.errors.map((message) => (
              <li key={message} className="break-words">
                {message}
              </li>
            ))}
          </ul>
        </SettingsNotice>
      ) : null}
      {workspaceUntrusted ? (
        <div className="space-y-2 rounded-xl border border-border/60 p-3" data-plugin-trust="">
          <p className="text-xs leading-5 text-muted-foreground">
            {t("sandboxedUi.plugins.untrusted").replace("{path}", list?.workdir ?? "")}
          </p>
          {trustClient && list?.workdir ? (
            <WorkspaceFolderTrustSection
              path={list.workdir}
              client={trustClient}
              onChange={() => void client.reload(workdir).then(adopt, () => refresh())}
            />
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">
              {t("sandboxedUi.plugins.trustInProject")}
            </p>
          )}
        </div>
      ) : null}
      {loading && !list ? (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("sandboxedUi.loading")}
        </div>
      ) : plugins.length === 0 && list ? (
        <EmptyState variant="settings" size="compact" data-plugin-empty="">
          <Plug className="size-5 text-muted-foreground" />
          <div className="space-y-1">
            <div className="text-sm font-medium text-foreground">
              {t("sandboxedUi.plugins.emptyTitle")}
            </div>
            <p className="max-w-md px-4 text-xs leading-5 text-muted-foreground">
              {t("sandboxedUi.plugins.emptyDescription")}
            </p>
          </div>
        </EmptyState>
      ) : (
        <div className="space-y-1.5">
          {plugins.map((plugin) => (
            <PluginRow
              key={`${plugin.source}:${plugin.id}`}
              plugin={plugin}
              client={client}
              workdir={workdir}
              panels={panels}
              busy={busyId !== null}
              onToggle={() =>
                void run(plugin.id, () => client.setEnabled(plugin.id, !plugin.enabled, workdir))
              }
              onRemove={() => void remove(plugin)}
              onStale={() => void refresh()}
            />
          ))}
        </div>
      )}
      {dialog}
      {directoryPickerElement}
    </SettingsSection>
  );
}
