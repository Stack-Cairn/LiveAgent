import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Package,
  Plug,
  Settings,
  Shield,
  Terminal,
  Trash2,
  X,
} from "../../components/IconSet";
import { ResourceActivationSwitch } from "../../components/resources/ResourceActivationSwitch";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmActionPopover } from "../../components/ui/confirm-action-popover";
import { useLocale } from "../../i18n/index";
import type { PluginClient, PluginInventoryItem } from "../../lib/plugins/types";
import { useModalMotion } from "../../lib/shared/modalMotion";
import { cn } from "../../lib/shared/utils";
import { PluginSettingsForm } from "./PluginSettingsForm";
import {
  pluginContributionCounts,
  pluginMissingPermissions,
  pluginPhaseTone,
  pluginProblem,
  pluginTrustMeta,
} from "./pluginPresentation";

const RUNTIME_ICONS = {
  "wasi-command": Package,
  process: Terminal,
  declarative: Plug,
} as const;

function Section(props: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/70 bg-muted/20 p-3.5">
      <div className="flex items-start gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground ring-1 ring-border/60">
          {props.icon}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-foreground">{props.title}</h3>
          {props.hint ? (
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{props.hint}</p>
          ) : null}
        </div>
        {props.actions ? <div className="shrink-0">{props.actions}</div> : null}
      </div>
      <div className="mt-3">{props.children}</div>
    </section>
  );
}

function FactRow(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3 py-1">
      <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{props.label}</span>
      <span className="min-w-0 flex-1 text-[11px] text-foreground">{props.children}</span>
    </div>
  );
}

export function PluginDetailModal(props: {
  item: PluginInventoryItem;
  client: PluginClient;
  workspace?: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { item, client, workspace, onClose, onChanged } = props;
  const { t } = useLocale();
  const { modalState, requestClose } = useModalMotion(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const counts = pluginContributionCounts(item);
  const trust = pluginTrustMeta(item, t);
  const problem = pluginProblem(item);
  const missingPermissions = pluginMissingPermissions(item);
  const RuntimeIcon = RUNTIME_ICONS[item.runtime.kind] ?? Plug;
  const readOnly = client.isReadOnly === true;

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const installedAt = useMemo(
    () => new Date(item.installedAt).toLocaleString(),
    [item.installedAt],
  );
  const updatedAt = useMemo(() => new Date(item.updatedAt).toLocaleString(), [item.updatedAt]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={requestClose}
        aria-label={t("pluginHub.close")}
      />
      <div className="settings-modal-panel relative z-10 flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl">
        <div className="settings-modal-header flex items-start gap-3 border-b border-border/70 px-6 py-4">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border",
              trust.danger
                ? "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/15 dark:text-amber-200"
                : "border-sky-500/30 bg-sky-500/12 text-sky-700 dark:border-sky-400/30 dark:bg-sky-400/15 dark:text-sky-200",
            )}
          >
            <RuntimeIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <h2 className="truncate text-base font-semibold">{item.name}</h2>
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                v{item.version}
              </span>
              <Badge variant={pluginPhaseTone(item.phase)} className="h-5 px-1.5 text-[10px]">
                {t(`pluginHub.phase.${item.phase}`)}
              </Badge>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={item.id}>
              {item.publisher.name || item.publisher.id} · {item.id}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ResourceActivationSwitch
              checked={item.enabled}
              disabled={busy || readOnly}
              label={`${t("pluginHub.toggle")}: ${item.name}`}
              onCheckedChange={(checked) =>
                void run(() => client.setEnabled(item.id, checked, workspace))
              }
            />
            <button
              type="button"
              onClick={requestClose}
              title={t("pluginHub.close")}
              aria-label={t("pluginHub.close")}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="settings-modal-body flex-1 space-y-3 overflow-y-auto px-6 py-5">
          {item.description ? (
            <p className="text-sm leading-6 text-muted-foreground">{item.description}</p>
          ) : null}

          {problem ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1 text-xs leading-5 text-destructive">{problem}</div>
            </div>
          ) : null}

          {error ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1 text-xs leading-5 text-destructive">{error}</div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 px-2 text-xs"
                onClick={() => setError(null)}
              >
                {t("pluginHub.dismiss")}
              </Button>
            </div>
          ) : null}

          <Section
            icon={<Shield className="h-3.5 w-3.5" />}
            title={t("pluginHub.permissions")}
            hint={t("pluginHub.permissionsHint")}
            actions={
              !readOnly && missingPermissions.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5 text-xs"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      client.setGrants(
                        item.id,
                        item.permissions.map((permission) => permission.id),
                      ),
                    )
                  }
                >
                  {t("pluginHub.grantAll")}
                </Button>
              ) : null
            }
          >
            {item.permissions.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">{t("pluginHub.noPermissions")}</p>
            ) : (
              <ul className="divide-y divide-border/60 rounded-lg border border-border/60 bg-background">
                {item.permissions.map((permission) => {
                  const granted = item.grantedPermissions.includes(permission.id);
                  const dangerous = permission.id === "process.fullTrust";
                  return (
                    <li key={permission.id} className="flex items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-[12px] font-medium text-foreground">
                            {t(`pluginHub.permission.${permission.id}`)}
                          </span>
                          {dangerous ? (
                            <AlertTriangle className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
                          ) : null}
                        </div>
                        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                          {permission.id}
                        </p>
                      </div>
                      <ResourceActivationSwitch
                        checked={granted}
                        disabled={busy || readOnly}
                        compact
                        label={permission.id}
                        onCheckedChange={(checked) =>
                          void run(() =>
                            client.setGrants(
                              item.id,
                              checked
                                ? [...item.grantedPermissions, permission.id]
                                : item.grantedPermissions.filter(
                                    (value) => value !== permission.id,
                                  ),
                            ),
                          )
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {item.contributes.settings.length > 0 && !readOnly ? (
            <Section
              icon={<Settings className="h-3.5 w-3.5" />}
              title={t("pluginHub.configuration")}
              hint={t("pluginHub.configurationHint")}
            >
              <PluginSettingsForm
                item={item}
                busy={busy}
                onSave={(config) =>
                  run(() =>
                    client.updateConfig({
                      pluginId: item.id,
                      workspace,
                      expectedRevision: item.configRevision,
                      config,
                    }),
                  )
                }
              />
            </Section>
          ) : null}

          <Section
            icon={<Package className="h-3.5 w-3.5" />}
            title={t("pluginHub.identity")}
            hint={t("pluginHub.identityHint")}
          >
            <div className="rounded-lg border border-border/60 bg-background px-3 py-2">
              <FactRow label={t("pluginHub.runtime")}>
                <span className="font-mono">{item.runtime.kind}</span> ·{" "}
                {t(`pluginHub.scope.${item.runtime.scope}`)}
              </FactRow>
              <FactRow label={t("pluginHub.trustLevel")}>
                <Badge variant={trust.variant} className="h-5 gap-1 px-1.5 text-[10px]">
                  {trust.danger ? (
                    <AlertTriangle className="h-2.5 w-2.5" />
                  ) : (
                    <Shield className="h-2.5 w-2.5" />
                  )}
                  {trust.label}
                </Badge>
                <span className="ml-2 text-muted-foreground">{trust.description}</span>
              </FactRow>
              <FactRow label={t("pluginHub.contributions")}>
                {counts.total === 0
                  ? t("pluginHub.noContributions")
                  : [
                      counts.tools ? `${counts.tools} ${t("pluginHub.tools")}` : null,
                      counts.prompts ? `${counts.prompts} ${t("pluginHub.prompts")}` : null,
                      counts.hooks ? `${counts.hooks} ${t("pluginHub.hooks")}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </FactRow>
              <FactRow label={t("pluginHub.generation")}>
                <span className="tabular-nums">{item.generation}</span>
              </FactRow>
              <FactRow label={t("pluginHub.packageHash")}>
                <span className="block break-all font-mono text-[10px]">{item.packageHash}</span>
              </FactRow>
              <FactRow label={t("pluginHub.installedAt")}>
                <span className="text-muted-foreground">
                  {installedAt} · {t("pluginHub.updatedAt")} {updatedAt}
                </span>
              </FactRow>
            </div>
          </Section>
        </div>

        {!readOnly ? (
          <div className="flex items-center justify-between gap-3 border-t border-border/70 px-6 py-3.5">
            {/* 用 ConfirmActionPopover 而非通用删除弹层：卸载会连带清掉配置与授权，
                这条后果值得用插件自己的文案说清楚，而不是复用泛化的删除提示。 */}
            <ConfirmActionPopover
              title={t("pluginHub.uninstall")}
              description={t("pluginHub.uninstallConfirm").replace("{name}", item.name)}
              confirmLabel={t("pluginHub.uninstall")}
              align="start"
              side="top"
              onConfirm={() => void run(() => client.uninstall(item.id).then(requestClose))}
            >
              {(open) => (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={open}
                  className="h-8 gap-1.5 px-2.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("pluginHub.uninstall")}
                </Button>
              )}
            </ConfirmActionPopover>
            <Button type="button" variant="outline" size="sm" onClick={requestClose}>
              {t("pluginHub.close")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
