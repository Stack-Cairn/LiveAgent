import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useCallback, useEffect, useState } from "react";
import type {
  KBrainComputerConfig,
  KBrainComputerStatus,
  KBrainSettingsAdapter,
} from "./kbrainSettingsAdapter";

export function KBrainComputerSection({ kbrain }: { kbrain: KBrainSettingsAdapter }) {
  const { t } = useLocale();
  const [config, setConfig] = useState<KBrainComputerConfig | null>(null);
  const [status, setStatus] = useState<KBrainComputerStatus | null>(null);
  const [command, setCommand] = useState("[]");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const document = await kbrain.getSettings();
      if (!document.computer) throw new Error(t("settings.cuaBackend.upgrade"));
      setConfig(document.computer);
      setCommand(JSON.stringify(document.computer.command ?? []));
      setStatus(kbrain.getComputerStatus ? await kbrain.getComputerStatus() : null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [kbrain, t]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function save() {
    if (!config) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const argv: unknown = JSON.parse(command);
      if (!Array.isArray(argv) || argv.some((item) => typeof item !== "string"))
        throw new Error(t("settings.cuaBackend.commandError"));
      const document = await kbrain.updateSettings({ computer: { ...config, command: argv } });
      if (!document.computer) throw new Error(t("settings.cuaBackend.upgrade"));
      setConfig(document.computer);
      setCommand(JSON.stringify(document.computer.command ?? []));
      setSaved(true);
      window.dispatchEvent(new Event("kbrain:settings-changed"));
      if (kbrain.getComputerStatus) setStatus(await kbrain.getComputerStatus());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4"
      data-testid="kbrain-computer-settings"
    >
      <h2 className="text-lg font-semibold">{t("settings.cuaDriver.title")}</h2>
      <p className="text-sm text-muted-foreground">{t("settings.cuaBackend.description")}</p>
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {saved && <p role="status">{t("settings.saved")}</p>}
      {status && (
        <div className="rounded-lg border p-3 text-sm break-words">
          <p>
            K-brain · {status.platform} ·{" "}
            {status.driverVersion ??
              (status.installed
                ? t("settings.cuaDriver.detected")
                : t("settings.cuaDriver.notInstalledTitle"))}
          </p>
          {status.message && <p>{status.message}</p>}
          <p>{t("settings.cuaBackend.permissions")}</p>
        </div>
      )}
      {config && (
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4 disabled:opacity-60">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.enabled !== false}
              onChange={(event) => setConfig({ ...config, enabled: event.target.checked })}
            />
            {t("settings.cuaBackend.enabled")}
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("settings.cuaBackend.backend")}
            <select
              className="rounded border bg-background p-2"
              value={config.backend || "cua"}
              onChange={(event) => setConfig({ ...config, backend: event.target.value })}
            >
              <option value="cua">Cua Driver</option>
              <option value="legacy">K-brain legacy</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("settings.cuaBackend.policy")}
            <select
              className="rounded border bg-background p-2"
              value={config.approvalPolicy || "ask"}
              onChange={(event) =>
                setConfig({
                  ...config,
                  approvalPolicy: event.target.value as KBrainComputerConfig["approvalPolicy"],
                })
              }
            >
              <option value="ask">{t("settings.cuaBackend.ask")}</option>
              <option value="allow">{t("settings.cuaBackend.allow")}</option>
              <option value="deny">{t("settings.cuaBackend.deny")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("settings.cuaBackend.command")}
            <textarea
              className="min-h-20 w-full rounded border bg-background p-2 font-mono"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              spellCheck={false}
            />
          </label>
          <p className="text-sm text-muted-foreground">{t("settings.cuaBackend.legacy")}</p>
        </fieldset>
      )}
      <div className="flex gap-2">
        <Button disabled={busy || !config} onClick={() => void save()}>
          {t("settings.save")}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
          {t("settings.cuaBackend.refresh")}
        </Button>
      </div>
    </section>
  );
}
