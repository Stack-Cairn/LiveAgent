import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  Shield,
  Sparkles,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import { updateUpdateSettings } from "../../lib/settings";
import { AgentActivationSwitch } from "./shared";
import type { SettingsSectionProps } from "./types";

type AppUpdateChannel = "stable" | "prerelease";

type AppUpdateCheckResult = {
  configured: boolean;
  available: boolean;
  currentVersion: string;
  version?: string | null;
  date?: string | null;
  body?: string | null;
  channel: AppUpdateChannel;
  releaseTag?: string | null;
  releaseName?: string | null;
  releaseUrl?: string | null;
  repository: string;
  message?: string | null;
};

type CheckState =
  | { status: "checking"; result?: AppUpdateCheckResult }
  | { status: "ready"; result: AppUpdateCheckResult }
  | { status: "installing"; result: AppUpdateCheckResult }
  | { status: "installed"; result: AppUpdateCheckResult }
  | { status: "error"; result?: AppUpdateCheckResult; message: string };

function formatReleaseDate(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function releaseTitle(result?: AppUpdateCheckResult) {
  if (!result) return "";
  return result.releaseName?.trim() || result.releaseTag?.trim() || result.version || "";
}

export function AboutSection(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const includePrereleases = settings.updates.includePrereleases;
  const [checkState, setCheckState] = useState<CheckState>({ status: "checking" });

  const runCheck = useCallback(async () => {
    setCheckState((prev) => ({
      status: "checking",
      result: "result" in prev ? prev.result : undefined,
    }));

    try {
      const result = await invoke<AppUpdateCheckResult>("app_update_check", {
        include_prerelease: includePrereleases,
      });
      setCheckState({ status: "ready", result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCheckState((prev) => ({
        status: "error",
        result: "result" in prev ? prev.result : undefined,
        message: message || t("settings.aboutUpdateCheckFailed"),
      }));
    }
  }, [includePrereleases, t]);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  async function handleInstallUpdate() {
    if (checkState.status !== "ready" || !checkState.result.available) return;

    setCheckState({ status: "installing", result: checkState.result });
    try {
      const result = await invoke<AppUpdateCheckResult>("app_update_install", {
        include_prerelease: includePrereleases,
      });
      setCheckState({ status: "installed", result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCheckState({
        status: "error",
        result: checkState.result,
        message: message || t("settings.aboutUpdateInstallFailed"),
      });
    }
  }

  const latestResult = "result" in checkState ? checkState.result : undefined;
  const channelLabel =
    latestResult?.channel === "prerelease"
      ? t("settings.aboutChannelPrerelease")
      : t("settings.aboutChannelStable");
  const currentVersion = latestResult?.currentVersion || "0.1.0";
  const nextVersion = latestResult?.version || latestResult?.releaseTag || "";
  const releaseDate = formatReleaseDate(latestResult?.date);
  const checking = checkState.status === "checking";
  const installing = checkState.status === "installing";
  const canInstall =
    checkState.status === "ready" &&
    checkState.result.configured &&
    checkState.result.available;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Info className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{t("settings.aboutTitle")}</h3>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              {t("settings.aboutDescription")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {latestResult?.releaseUrl ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void openUrl(latestResult.releaseUrl || "")}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t("settings.aboutOpenRelease")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={runCheck}
            disabled={checking || installing}
          >
            {checking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t("settings.aboutCheckUpdate")}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="space-y-4 rounded-2xl border border-border/60 bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("settings.aboutCurrentVersion")}
              </div>
              <div className="mt-1 text-2xl font-semibold leading-none tabular-nums">
                v{currentVersion}
              </div>
            </div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/45 px-2.5 py-1 text-xs font-medium">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              {channelLabel}
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-background/70 p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                {checkState.status === "error" ? (
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                ) : latestResult?.available ? (
                  <Download className="h-4 w-4 text-primary" />
                ) : checking ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">
                  {checkState.status === "error"
                    ? t("settings.aboutUpdateError")
                    : checking
                      ? t("settings.aboutChecking")
                      : installing
                        ? t("settings.aboutInstalling")
                        : checkState.status === "installed"
                          ? t("settings.aboutInstalled")
                          : latestResult?.available
                            ? t("settings.aboutUpdateAvailable")
                            : latestResult?.configured
                              ? t("settings.aboutUpToDate")
                              : t("settings.aboutUpdaterNotConfigured")}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {checkState.status === "error"
                    ? checkState.message
                    : checking
                      ? t("settings.aboutCheckingDesc")
                      : installing
                        ? t("settings.aboutInstallingDesc")
                        : checkState.status === "installed"
                          ? t("settings.aboutInstalledDesc")
                          : latestResult?.available
                            ? t("settings.aboutUpdateAvailableDesc")
                            : latestResult?.configured
                              ? t("settings.aboutUpToDateDesc")
                              : latestResult?.message ||
                                t("settings.aboutUpdaterNotConfiguredDesc")}
                </p>

                {nextVersion ? (
                  <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                    <div className="rounded-lg bg-muted/45 px-3 py-2">
                      <div className="text-muted-foreground">
                        {t("settings.aboutLatestVersion")}
                      </div>
                      <div className="mt-0.5 font-medium tabular-nums">v{nextVersion}</div>
                    </div>
                    <div className="rounded-lg bg-muted/45 px-3 py-2">
                      <div className="text-muted-foreground">
                        {t("settings.aboutReleaseDate")}
                      </div>
                      <div className="mt-0.5 truncate font-medium">{releaseDate || "N/A"}</div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={handleInstallUpdate}
                disabled={!canInstall || installing}
              >
                {installing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {t("settings.aboutInstallUpdate")}
              </Button>
              <div className="text-xs text-muted-foreground">
                {latestResult?.repository || "Stack-Cairn/LiveAgent"}
              </div>
            </div>
          </div>

          {latestResult?.body ? (
            <div className="space-y-2 rounded-xl border border-border/60 bg-background/70 p-4">
              <div className="text-sm font-semibold">{releaseTitle(latestResult)}</div>
              <div className="max-h-48 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                {latestResult.body}
              </div>
            </div>
          ) : null}
        </section>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-border/60 bg-card p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  {t("settings.aboutPrereleaseTitle")}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {t("settings.aboutPrereleaseDesc")}
                </p>
              </div>
              <AgentActivationSwitch
                checked={includePrereleases}
                title={t("settings.aboutPrereleaseToggle")}
                onToggle={() =>
                  setSettings((prev) =>
                    updateUpdateSettings(prev, {
                      includePrereleases: !prev.updates.includePrereleases,
                    }),
                  )
                }
              />
            </div>
          </section>

          <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
            <div className="text-sm font-semibold">{t("settings.aboutNotesTitle")}</div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("settings.aboutNotesBody")}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("settings.aboutSecurityBody")}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
