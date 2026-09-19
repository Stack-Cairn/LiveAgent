import { Download, ExternalLink, Loader2, RefreshCw } from "@liveagent/ui/components/IconSet";
import { Markdown } from "@liveagent/ui/components/Markdown";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@liveagent/ui/components/settings/SettingsLayout";
import { Button, RefreshButton } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@liveagent/ui/components/ui/dialog";
import { toast } from "@liveagent/ui/components/ui/toast-manager";
import { useLocale } from "@liveagent/ui/i18n/index";
import { AgentActivationSwitch } from "@liveagent/ui/pages/settings/shared";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useId } from "react";
import type { AppUpdateController } from "../../lib/appUpdates";
import type { ReleaseAnnouncementController } from "../../lib/releaseAnnouncement";
import { releaseNotesBody, releaseTitle } from "../../lib/releaseNotes";
import { updateUpdateSettings } from "../../lib/settings";
import { formatReleaseDate } from "./aboutDate";
import type { SettingsSectionProps } from "./types";

type AboutSectionProps = SettingsSectionProps & {
  appUpdate: AppUpdateController;
  releaseAnnouncement: ReleaseAnnouncementController;
};

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message.trim();
  return String(error ?? "").trim();
}

export function AboutSection(props: AboutSectionProps) {
  const { settings, setSettings, appUpdate, releaseAnnouncement } = props;
  const { t } = useLocale();
  const toastScope = useId();
  const includePrereleases = settings.updates.includePrereleases;
  const checkState = appUpdate.state;

  useEffect(() => () => toast.dismiss(`${toastScope}-update`), [toastScope]);

  function showUpdateError(title: string, error: unknown) {
    const description = errorMessage(error);
    toast.error(title, {
      id: `${toastScope}-update`,
      appearance: "notice",
      ...(description && description !== title ? { description } : {}),
    });
  }

  async function handleCheckUpdate() {
    const toastId = `${toastScope}-update`;
    toast.warning(t("settings.aboutChecking"), {
      id: toastId,
      appearance: "notice",
      description: t("settings.aboutCheckingDesc"),
    });

    try {
      const result = await appUpdate.runCheck();
      if (!result) {
        toast.dismiss(toastId);
      } else if (!result.configured) {
        toast.warning(t("settings.aboutUpdaterNotConfigured"), {
          id: toastId,
          appearance: "notice",
          description: result.message || t("settings.aboutUpdaterNotConfiguredDesc"),
        });
      } else if (result.manualDownload) {
        toast.warning(t("settings.aboutManualUpdate"), {
          id: toastId,
          appearance: "notice",
          description: t("settings.aboutManualUpdateDesc"),
        });
      } else if (result.available) {
        const version = result.version || result.releaseTag;
        toast.success(t("settings.aboutUpdateAvailable"), {
          id: toastId,
          appearance: "notice",
          description: version
            ? `${t("settings.aboutUpdateAvailableDesc")} v${version}`
            : t("settings.aboutUpdateAvailableDesc"),
        });
      } else {
        toast.success(t("settings.aboutUpToDate"), {
          id: toastId,
          appearance: "notice",
          description: t("settings.aboutUpToDateDesc"),
        });
      }
    } catch (error) {
      showUpdateError(t("settings.aboutUpdateCheckFailed"), error);
    }
  }

  async function handleOpenAnnouncement() {
    try {
      const announcement = await releaseAnnouncement.openAnnouncement();
      if (!announcement) {
        toast.warning(t("settings.aboutAnnouncementUnavailable"), {
          id: `${toastScope}-announcement`,
          appearance: "notice",
          description: t("settings.aboutAnnouncementUnavailableDesc"),
        });
      }
    } catch (error) {
      const description = errorMessage(error);
      toast.error(t("settings.aboutAnnouncementLoadFailed"), {
        id: `${toastScope}-announcement`,
        appearance: "notice",
        ...(description ? { description } : {}),
      });
    }
  }

  async function handlePreviewAnnouncement() {
    try {
      const announcement = await releaseAnnouncement.openPreviewAnnouncement();
      if (!announcement) {
        toast.warning(t("settings.aboutAnnouncementUnavailable"), {
          id: `${toastScope}-announcement-preview`,
          appearance: "notice",
          description: t("settings.aboutDebugAnnouncementUnavailableDesc"),
        });
      }
    } catch (error) {
      const description = errorMessage(error);
      toast.error(t("settings.aboutAnnouncementLoadFailed"), {
        id: `${toastScope}-announcement-preview`,
        appearance: "notice",
        ...(description ? { description } : {}),
      });
    }
  }

  async function handleInstallUpdate() {
    const toastId = `${toastScope}-update`;
    toast.warning(t("settings.aboutInstalling"), {
      id: toastId,
      appearance: "notice",
      description: t("settings.aboutInstallingDesc"),
    });
    try {
      const result = await appUpdate.installOnly();
      if (!result) {
        toast.dismiss(toastId);
        return;
      }
      toast.success(t("settings.aboutInstalled"), {
        id: toastId,
        appearance: "notice",
        description: t("settings.aboutInstalledDesc"),
      });
    } catch (error) {
      showUpdateError(t("settings.aboutUpdateInstallFailed"), error);
    }
  }

  async function handleRestartApp() {
    if (checkState.status !== "installed") return;
    toast.warning(t("settings.aboutRestarting"), {
      id: `${toastScope}-update`,
      appearance: "notice",
      description: t("settings.aboutRestartingDesc"),
    });
    await appUpdate
      .restart()
      .catch((error) => showUpdateError(t("settings.aboutRestartFailed"), error));
  }

  const latestResult = appUpdate.result;
  const latestReleaseNotes = releaseNotesBody(latestResult);
  const channelLabel = includePrereleases
    ? t("settings.aboutChannelPrerelease")
    : t("settings.aboutChannelStable");
  const currentVersion = latestResult?.currentVersion || __LIVEAGENT_APP_VERSION__;
  const nextVersion = latestResult?.version || latestResult?.releaseTag || "";
  const releaseDate = formatReleaseDate(latestResult?.date);
  const checking = checkState.status === "checking";
  const installing = checkState.status === "installing";
  const installed = checkState.status === "installed";
  const restarting = checkState.status === "restarting";
  const canInstall = appUpdate.canInstall;

  const updateBusy = checking || installing || restarting;
  const showInstallAction = installed || installing || restarting || canInstall;
  const updateActionLabel = restarting
    ? t("settings.aboutRestarting")
    : installing
      ? t("settings.aboutInstalling")
      : installed
        ? t("settings.aboutRestartApp")
        : t("settings.aboutInstallUpdate");
  const releaseMeta = [
    nextVersion ? `${t("settings.aboutLatestVersion")} v${nextVersion}` : null,
    releaseDate ? `${t("settings.aboutReleaseDate")} ${releaseDate}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-8">
      <SettingsSection>
        <SettingsCard>
          <SettingsRow
            title={t("settings.aboutApplication")}
            description={t("settings.aboutApplicationDesc")}
            control={
              <div className="text-right">
                <div className="text-sm font-medium text-foreground">
                  LiveAgent v{currentVersion}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">{channelLabel}</div>
              </div>
            }
          />

          <SettingsRow
            title={t("settings.aboutSoftwareUpdate")}
            description={t("settings.aboutSoftwareUpdateDesc")}
            control={
              <div className="grid min-w-64 grid-cols-2 gap-2">
                {latestReleaseNotes ? (
                  <Dialog>
                    <DialogTrigger
                      render={<Button className="w-full" variant="outline" size="sm" />}
                    >
                      {t("settings.aboutReleaseNotes")}
                    </DialogTrigger>
                    <DialogContent
                      className="max-w-2xl"
                      showCloseButton
                      closeLabel={t("settings.cancel")}
                    >
                      <DialogHeader>
                        <DialogTitle>{releaseTitle(latestResult)}</DialogTitle>
                        {releaseMeta ? <DialogDescription>{releaseMeta}</DialogDescription> : null}
                      </DialogHeader>
                      <DialogBody className="max-h-[70vh]">
                        <Markdown
                          content={latestReleaseNotes}
                          className="release-notes-markdown text-sm leading-relaxed text-muted-foreground"
                        />
                      </DialogBody>
                      {latestResult?.releaseUrl ? (
                        <DialogFooter>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void openUrl(latestResult.releaseUrl || "")}
                          >
                            <ExternalLink className="size-3.5" />
                            {t("settings.aboutOpenRelease")}
                          </Button>
                        </DialogFooter>
                      ) : null}
                    </DialogContent>
                  </Dialog>
                ) : (
                  <Button
                    type="button"
                    className="w-full"
                    variant="outline"
                    size="sm"
                    onClick={() => void openUrl(latestResult?.releaseUrl || "")}
                    disabled={!latestResult?.releaseUrl}
                  >
                    <ExternalLink className="size-3.5" />
                    {t("settings.aboutReleaseNotes")}
                  </Button>
                )}
                {!showInstallAction ? (
                  <RefreshButton
                    aria-busy={checking}
                    type="button"
                    className="w-full"
                    size="sm"
                    onClick={() => void handleCheckUpdate()}
                    disabled={updateBusy}
                  >
                    {checking ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw data-refresh-icon className="size-3.5" />
                    )}
                    {t("settings.aboutCheckUpdate")}
                  </RefreshButton>
                ) : null}
                {showInstallAction ? (
                  <Button
                    type="button"
                    className="w-full"
                    size="sm"
                    onClick={installed ? handleRestartApp : handleInstallUpdate}
                    disabled={updateBusy}
                  >
                    {updateBusy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : installed ? (
                      <RefreshCw className="size-3.5" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                    {updateActionLabel}
                  </Button>
                ) : null}
              </div>
            }
          />

          <SettingsRow
            title={t("settings.aboutUpdateAnnouncement")}
            description={t("settings.aboutUpdateAnnouncementDesc")}
            control={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleOpenAnnouncement()}
                disabled={releaseAnnouncement.loading}
              >
                {releaseAnnouncement.loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t("settings.aboutOpenAnnouncement")}
              </Button>
            }
          />

          {import.meta.env.DEV ? (
            <SettingsRow
              title={t("settings.aboutDebugMode")}
              description={t("settings.aboutDebugModeDesc")}
              control={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handlePreviewAnnouncement()}
                  disabled={releaseAnnouncement.loading}
                >
                  {releaseAnnouncement.loading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : null}
                  {t("settings.aboutPreviewAnnouncement")}
                </Button>
              }
            />
          ) : null}

          <SettingsRow
            title={t("settings.aboutPrereleaseTitle")}
            description={t("settings.aboutPrereleaseDesc")}
            control={
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
            }
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
