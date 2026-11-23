import "@liveagent/ui/i18n/namespaces/diagnostics";
import { Archive, Sparkles } from "@liveagent/ui/components/IconSet";
import { SettingsRow } from "@liveagent/ui/components/settings/SettingsLayout";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import { requestDiagnosticsExport } from "@liveagent/ui/lib/diagnostics/exportRequests";
import { requestOnboarding } from "@liveagent/ui/lib/onboarding/onboardingState";

/** Settings-search target; hosts write it as a literal so the index test can find it. */
type AnchorProps = { "data-settings-anchor": string };

/** Settings > About: re-open the first-run guide. */
export function OnboardingReopenRow(props: AnchorProps) {
  const { t } = useLocale();
  return (
    <SettingsRow
      data-settings-anchor={props["data-settings-anchor"]}
      title={t("onboarding.reopen")}
      description={t("onboarding.reopenDesc")}
      control={
        <Button type="button" variant="outline" size="sm" onClick={requestOnboarding}>
          <Sparkles className="size-3.5" />
          {t("onboarding.reopenAction")}
        </Button>
      }
    />
  );
}

/** Settings > About: opens the diagnostics export preview. */
export function DiagnosticsExportRow(props: AnchorProps) {
  const { t } = useLocale();
  return (
    <SettingsRow
      data-settings-anchor={props["data-settings-anchor"]}
      title={t("diagnostics.export")}
      description={t("diagnostics.exportDesc")}
      control={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={requestDiagnosticsExport}
          data-testid="settings-export-diagnostics"
        >
          <Archive className="size-3.5" />
          {t("diagnostics.exportAction")}
        </Button>
      }
    />
  );
}
