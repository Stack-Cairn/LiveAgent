import { SettingsRow } from "@liveagent/ui/components/settings/SettingsLayout";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { KBrainHealth } from "@liveagent/ui/lib/kbrain/health";
import { useEffect, useState } from "react";

type HealthState =
  | { status: "loading" }
  | { status: "ready"; health: KBrainHealth }
  | { status: "error"; message: string };

export function kbrainHealthDetails(
  health: KBrainHealth,
  labels: { protocol: string; capabilityRevision: string; instance: string },
): string {
  const { name, major, minor } = health.protocol;
  return [
    `${labels.protocol} ${name} ${major}.${minor}`,
    health.build?.revision ? health.build.revision.slice(0, 12) : null,
    health.capabilityRevision === null
      ? null
      : `${labels.capabilityRevision} ${health.capabilityRevision}`,
    health.instanceId ? `${labels.instance} ${health.instanceId.slice(0, 8)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Read-only K-brain identity for compatibility troubleshooting; the updater stays disabled. */
export function KBrainBackendRow({ loadHealth }: { loadHealth: () => Promise<KBrainHealth> }) {
  const { t } = useLocale();
  const [state, setState] = useState<HealthState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadHealth()
      .then((health) => {
        if (!cancelled) setState({ status: "ready", health });
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setState({
            status: "error",
            message: reason instanceof Error ? reason.message : String(reason),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [loadHealth]);

  let primary: string;
  let secondary: string | null = null;
  if (state.status === "loading") {
    primary = t("settings.aboutKbrainLoading");
  } else if (state.status === "error") {
    primary = t("settings.aboutKbrainUnavailable");
    secondary = state.message;
  } else {
    const { health } = state;
    primary = health.legacy
      ? t("settings.aboutKbrainLegacy")
      : `K-brain ${health.build?.version ?? "?"}${health.build?.channel ? ` (${health.build.channel})` : ""}`;
    secondary = kbrainHealthDetails(health, {
      protocol: t("settings.aboutKbrainProtocol"),
      capabilityRevision: t("settings.aboutKbrainCapabilityRevision"),
      instance: t("settings.aboutKbrainInstance"),
    });
  }

  return (
    <SettingsRow
      title={t("settings.aboutKbrain")}
      description={t("settings.aboutKbrainDesc")}
      control={
        <div className="max-w-full text-right sm:max-w-sm">
          <div
            className={`break-words text-sm font-medium ${
              state.status === "error" ? "text-destructive" : "text-foreground"
            }`}
          >
            {primary}
          </div>
          {secondary ? (
            <div className="mt-0.5 break-words text-xs text-muted-foreground">{secondary}</div>
          ) : null}
        </div>
      }
    />
  );
}
