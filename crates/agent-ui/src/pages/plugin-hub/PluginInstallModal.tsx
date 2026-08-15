import { useDirectoryPicker } from "@liveagent/adapters/directoryPicker";
import { useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, FolderOpen, Package, X } from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { useLocale } from "../../i18n/index";
import type { PluginClient } from "../../lib/plugins/types";
import { useModalMotion } from "../../lib/shared/modalMotion";
import { cn } from "../../lib/shared/utils";

function InstallOption(props: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  hint: string;
  danger?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
        props.checked
          ? props.danger
            ? "border-amber-500/40 bg-amber-500/8"
            : "border-foreground/20 bg-muted/40"
          : "border-border/60 hover:bg-muted/30",
      )}
    >
      <Checkbox
        checked={props.checked}
        onCheckedChange={(checked) => props.onCheckedChange(checked === true)}
        className="mt-0.5"
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "flex items-center gap-1 text-[12px] font-medium",
            props.danger ? "text-amber-700 dark:text-amber-300" : "text-foreground",
          )}
        >
          {props.danger ? <AlertTriangle className="h-3 w-3 shrink-0" /> : null}
          {props.label}
        </span>
        <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
          {props.hint}
        </span>
      </span>
    </label>
  );
}

export function PluginInstallModal(props: {
  client: PluginClient;
  workspace?: string;
  onClose: () => void;
  onInstalled: () => Promise<void>;
}) {
  const { client, workspace, onClose, onInstalled } = props;
  const { t } = useLocale();
  const { modalState, requestClose } = useModalMotion(onClose);
  const { pickDirectory, directoryPickerElement } = useDirectoryPicker();
  const [sourcePath, setSourcePath] = useState("");
  const [allowUnsigned, setAllowUnsigned] = useState(false);
  const [allowFullTrust, setAllowFullTrust] = useState(false);
  const [grantRequested, setGrantRequested] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = async () => {
    const path = sourcePath.trim();
    if (!path) return;
    setInstalling(true);
    setError(null);
    try {
      const installed = await client.install(path, {
        allowUnsigned,
        allowFullTrust,
        grantedPermissions: [],
      });
      if (grantRequested) {
        await client.setGrants(
          installed.id,
          installed.permissions.map((permission) => permission.id),
        );
      }
      if (grantRequested || installed.permissions.length === 0) {
        await client.setEnabled(installed.id, true, workspace);
      }
      await onInstalled();
      requestClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setInstalling(false);
    }
  };

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
      role="dialog"
      aria-modal="true"
      aria-label={t("pluginHub.installTitle")}
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={requestClose}
        aria-label={t("pluginHub.close")}
      />
      <div className="settings-modal-panel relative z-10 flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl">
        <div className="settings-modal-header flex items-center gap-3 border-b border-border/70 px-6 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border/70 bg-muted/50 text-foreground shadow-xs">
            <Package className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{t("pluginHub.installTitle")}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("pluginHub.installDescription")}
            </p>
          </div>
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

        <div className="settings-modal-body flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              autoFocus
              value={sourcePath}
              onChange={(event) => setSourcePath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && sourcePath.trim() && !installing) void install();
              }}
              placeholder={t("pluginHub.sourcePlaceholder")}
              aria-label={t("pluginHub.sourcePlaceholder")}
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                const selected = await pickDirectory(sourcePath || workspace || "");
                if (selected) setSourcePath(selected);
              }}
            >
              <FolderOpen className="mr-2 h-4 w-4" />
              {t("pluginHub.browse")}
            </Button>
          </div>

          <div className="grid gap-2">
            <InstallOption
              checked={grantRequested}
              onCheckedChange={setGrantRequested}
              label={t("pluginHub.grantRequested")}
              hint={t("pluginHub.grantRequestedHint")}
            />
            <InstallOption
              checked={allowUnsigned}
              onCheckedChange={setAllowUnsigned}
              label={t("pluginHub.allowUnsigned")}
              hint={t("pluginHub.allowUnsignedHint")}
            />
            <InstallOption
              checked={allowFullTrust}
              onCheckedChange={setAllowFullTrust}
              label={t("pluginHub.allowFullTrust")}
              hint={t("pluginHub.allowFullTrustHint")}
              danger
            />
          </div>

          {error ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1 text-xs leading-5 text-destructive">{error}</div>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/70 px-6 py-3.5">
          <Button type="button" variant="outline" size="sm" onClick={requestClose}>
            {t("settings.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!sourcePath.trim() || installing}
            onClick={() => void install()}
          >
            {installing ? t("pluginHub.installing") : t("pluginHub.install")}
          </Button>
        </div>
      </div>
      {directoryPickerElement}
    </div>,
    document.body,
  );
}
