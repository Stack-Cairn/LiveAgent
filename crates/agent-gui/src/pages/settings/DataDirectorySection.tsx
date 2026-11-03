import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@liveagent/ui/components/settings/SettingsLayout";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useCallback, useEffect, useState } from "react";
import { useDirectoryPicker } from "../../agent-ui-adapters/directoryPicker";
import {
  type DataDirStatus,
  dataDirTargetFor,
  loadDataDirStatus,
  migrateDataDir,
  restartApp,
} from "../../lib/system/dataDir";

type Phase =
  | { kind: "idle" }
  | { kind: "migrating"; target: string }
  | { kind: "error"; message: string }
  | { kind: "done"; previous: string };

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Relocates the whole LiveAgent data root (desktop config + K-brain sessions). */
export function DataDirectorySection() {
  const { t } = useLocale();
  const { confirm, dialog } = useConfirmDialog();
  const { pickDirectory } = useDirectoryPicker();
  const [status, setStatus] = useState<DataDirStatus | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    loadDataDirStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setPhase({ kind: "error", message: errorText(reason) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const migrate = useCallback(
    async (target: string) => {
      if (!status) return;
      const confirmed = await confirm({
        title: t("settings.dataDirConfirmTitle"),
        subtitle: target,
        description: t("settings.dataDirConfirmDesc"),
        confirmLabel: t("settings.dataDirConfirmAction"),
        cancelLabel: t("settings.backupCancel"),
      });
      if (!confirmed) return;
      setPhase({ kind: "migrating", target });
      try {
        const result = await migrateDataDir(target);
        setPhase({ kind: "done", previous: result.previous });
        await restartApp();
      } catch (reason) {
        setPhase({ kind: "error", message: errorText(reason) });
      }
    },
    [confirm, status, t],
  );

  const choose = useCallback(async () => {
    if (!status) return;
    const picked = await pickDirectory(status.current);
    if (!picked) return;
    await migrate(dataDirTargetFor(picked, status.default));
  }, [migrate, pickDirectory, status]);

  const busy = phase.kind === "migrating" || phase.kind === "done";
  const locked = Boolean(status?.envOverride);

  return (
    <div className="space-y-8">
      <SettingsSection description={t("settings.dataDirDesc")}>
        <SettingsCard>
          <SettingsRow
            title={t("settings.dataDirCurrent")}
            description={
              status?.custom
                ? t("settings.dataDirCustomHint").replace("{path}", status.default)
                : t("settings.dataDirDefaultHint")
            }
            control={
              <div className="flex max-w-full flex-col items-end gap-2 sm:max-w-md">
                <code className="break-all text-right text-xs text-foreground">
                  {status?.current ?? "…"}
                </code>
                <div className="flex gap-2">
                  {status?.custom ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || locked}
                      onClick={() => void migrate(status.default)}
                    >
                      {t("settings.dataDirRestoreDefault")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    disabled={!status || busy || locked}
                    onClick={() => void choose()}
                  >
                    {t("settings.dataDirChange")}
                  </Button>
                </div>
              </div>
            }
          />
        </SettingsCard>
        {locked ? (
          <p className="text-xs text-muted-foreground">
            {t("settings.dataDirEnvLocked").replace("{name}", status?.envOverride ?? "")}
          </p>
        ) : null}
        {phase.kind === "migrating" ? (
          <p className="text-xs text-muted-foreground">
            {t("settings.dataDirMigrating").replace("{path}", phase.target)}
          </p>
        ) : null}
        {phase.kind === "done" ? (
          <p className="text-xs text-muted-foreground">
            {t("settings.dataDirDone").replace("{path}", phase.previous)}
          </p>
        ) : null}
        {phase.kind === "error" ? (
          <p className="break-words text-xs text-destructive">
            {t("settings.dataDirFailed").replace("{message}", phase.message)}
          </p>
        ) : null}
      </SettingsSection>
      {dialog}
    </div>
  );
}
