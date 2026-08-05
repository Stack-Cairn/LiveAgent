import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle2,
  ClaudeIcon,
  GrokIcon,
  History,
  Loader2,
  OpenaiChatgptIcon,
  RefreshCw,
  Waypoints,
  X,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import {
  CLI_IDENTITY_METADATA,
  type CliIdentityMode,
  type CliIdentityProfile,
  compareCliVersions,
  followLatestCliIdentityVersion,
  formatCliIdentityUserAgent,
  getAppliedCliIdentityVersion,
  MANAGED_CLI_IDENTITY_PROVIDER_IDS,
  type ManagedCliIdentityProviderId,
  rollbackCliIdentityVersion,
  setCliIdentityMode,
} from "../../lib/providers/cliIdentityCore";
import {
  checkCliIdentityVersions,
  cliIdentityProvidersNeedingCheck,
  mergeCliIdentityCheckResults,
} from "../../lib/providers/cliIdentityUpdates";
import { isAnthropicOAuthApiKey, readCustomHeaderValue } from "../../lib/providers/customHeaders";
import { type AppSettings, updateCustomSettings } from "../../lib/settings";
import { cn } from "../../lib/shared/utils";
import type { SettingsSectionProps } from "./types";

const CHECK_TIMEOUT_MS = 8_000;

const PROVIDER_LABELS: Record<ManagedCliIdentityProviderId, string> = {
  claude_code: "Anthropic",
  codex: "OpenAI",
  xai: "Grok",
};

function ProviderIdentityIcon({ providerId }: { providerId: ManagedCliIdentityProviderId }) {
  if (providerId === "claude_code") return <ClaudeIcon className="h-4 w-4" />;
  if (providerId === "xai") return <GrokIcon className="h-4 w-4" />;
  return <OpenaiChatgptIcon className="h-4 w-4 fill-current dark:text-white" />;
}

function customUserAgent(
  customHeaders: AppSettings["customProviders"][number]["customHeaders"],
): string | undefined {
  return readCustomHeaderValue(customHeaders, "User-Agent");
}

function cliIdentityDisabled(
  providerId: ManagedCliIdentityProviderId,
  apiKey: string,
  requestFormat: AppSettings["customProviders"][number]["requestFormat"],
): boolean {
  return (
    (providerId === "claude_code" && isAnthropicOAuthApiKey(apiKey)) ||
    (providerId === "codex" && requestFormat === "openai-completions")
  );
}

function checkedAtLabel(timestamp: number | undefined, locale: string): string {
  return timestamp ? new Date(timestamp).toLocaleString(locale) : "-";
}

function IdentityModeControl(props: {
  value: CliIdentityMode;
  onChange: (mode: CliIdentityMode) => void;
}) {
  const { value, onChange } = props;
  const { t } = useLocale();
  const modes: CliIdentityMode[] = ["builtin", "auto"];
  return (
    <div className="grid grid-cols-2 rounded-lg bg-muted p-1">
      {modes.map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          className={cn(
            "min-h-9 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === mode && "bg-background text-foreground shadow-sm",
          )}
          onClick={() => onChange(mode)}
        >
          {t(`settings.cliIdentityMode.${mode}`)}
        </button>
      ))}
    </div>
  );
}

function IdentityRow(props: {
  providerId: ManagedCliIdentityProviderId;
  profile: CliIdentityProfile;
  providers: AppSettings["customProviders"];
  checking: boolean;
  error?: string;
  onModeChange: (mode: CliIdentityMode) => void;
  onRollback: () => void;
}) {
  const { providerId, profile, providers, checking, error, onModeChange, onRollback } = props;
  const { locale, t } = useLocale();
  const currentVersion = getAppliedCliIdentityVersion(providerId, profile);
  const effectiveUserAgent = formatCliIdentityUserAgent(providerId, currentVersion);
  const relatedProviders = providers.filter((provider) => provider.type === providerId);
  const overrideCount = relatedProviders.filter(
    (provider) => customUserAgent(provider.customHeaders) !== undefined,
  ).length;
  const disabledCount = relatedProviders.filter(
    (provider) =>
      customUserAgent(provider.customHeaders) === undefined &&
      cliIdentityDisabled(providerId, provider.apiKey, provider.requestFormat),
  ).length;
  const upToDate = Boolean(
    profile.latestVersion && compareCliVersions(currentVersion, profile.latestVersion) >= 0,
  );

  return (
    <section className="rounded-xl border border-border/70 bg-background/80 p-4 shadow-sm dark:bg-foreground/[0.025] dark:shadow-none">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          <ProviderIdentityIcon providerId={providerId} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{PROVIDER_LABELS[providerId]}</span>
            {upToDate ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3" />
                {t("settings.cliIdentityUpToDate")}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {CLI_IDENTITY_METADATA[providerId].packageName} ·{" "}
            {CLI_IDENTITY_METADATA[providerId].distTag}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-muted/55 px-3 py-2.5">
          <div className="text-[10px] font-medium text-muted-foreground">
            {t("settings.cliIdentityCurrent")}
          </div>
          <div className="mt-1 font-mono text-sm font-semibold tabular-nums">v{currentVersion}</div>
        </div>
        <div className="rounded-lg bg-muted/55 px-3 py-2.5">
          <div className="text-[10px] font-medium text-muted-foreground">
            {t("settings.cliIdentityLatest")}
          </div>
          <div className="mt-1 font-mono text-sm font-semibold tabular-nums">
            {checking ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : profile.latestVersion ? (
              `v${profile.latestVersion}`
            ) : (
              "-"
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-lg bg-muted/35 px-3 py-2.5">
        <div className="text-[10px] font-medium text-muted-foreground">
          {t("settings.cliIdentityEffectiveUserAgent")}
        </div>
        <div className="mt-1 break-all font-mono text-[11px] leading-relaxed text-foreground/85">
          {effectiveUserAgent}
        </div>
      </div>

      <div className="mt-3">
        <IdentityModeControl value={profile.mode} onChange={onModeChange} />
      </div>

      <div className="mt-3 flex min-h-10 items-center gap-2">
        <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
          {error
            ? t("settings.cliIdentityCheckFailed")
            : t("settings.cliIdentityLastChecked").replace(
                "{time}",
                checkedAtLabel(profile.lastCheckedAt, locale),
              )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0"
          disabled={profile.mode === "builtin" || !profile.previousVersion}
          onClick={onRollback}
          title={t("settings.cliIdentityRollback")}
          aria-label={t("settings.cliIdentityRollback")}
        >
          <History className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="mt-2 text-[10px] text-muted-foreground">
        {t("settings.cliIdentityImpact")
          .replace("{count}", String(relatedProviders.length - overrideCount - disabledCount))
          .replace("{overrides}", String(overrideCount))
          .replace("{disabled}", String(disabledCount))}
      </div>
    </section>
  );
}

export function ProviderIdentityDrawer(props: SettingsSectionProps & { onClose: () => void }) {
  const { settings, setSettings, onClose } = props;
  const { t } = useLocale();
  const [closing, setClosing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<ManagedCliIdentityProviderId, string>>>({});
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkAbortRef = useRef<AbortController | null>(null);
  const autoCheckStartedRef = useRef(false);
  const profiles = settings.customSettings.providerIdentities;

  const runCheck = useCallback(
    async (force: boolean) => {
      if (checking) return;
      const providerIds = force
        ? [...MANAGED_CLI_IDENTITY_PROVIDER_IDS]
        : cliIdentityProvidersNeedingCheck(profiles);
      if (providerIds.length === 0) return;
      checkAbortRef.current?.abort();
      const controller = new AbortController();
      checkAbortRef.current = controller;
      const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
      setChecking(true);
      setErrors({});
      try {
        const results = await checkCliIdentityVersions(providerIds, controller.signal);
        setSettings((previous) => {
          const merged = mergeCliIdentityCheckResults(
            previous.customSettings.providerIdentities,
            results,
          );
          return merged.changed
            ? updateCustomSettings(previous, { providerIdentities: merged.identities })
            : previous;
        });
        setErrors(
          Object.fromEntries(
            results
              .filter((result) => result.status === "error")
              .map((result) => [result.providerId, result.message]),
          ),
        );
      } finally {
        clearTimeout(timeout);
        if (checkAbortRef.current === controller) checkAbortRef.current = null;
        setChecking(false);
      }
    },
    [checking, profiles, setSettings],
  );

  useEffect(() => {
    if (autoCheckStartedRef.current) return;
    autoCheckStartedRef.current = true;
    void runCheck(false);
  }, [runCheck]);

  useEffect(
    () => () => {
      checkAbortRef.current?.abort();
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  function updateProfile(
    providerId: ManagedCliIdentityProviderId,
    updater: (profile: CliIdentityProfile) => CliIdentityProfile,
  ) {
    setSettings((previous) =>
      updateCustomSettings(previous, {
        providerIdentities: {
          ...previous.customSettings.providerIdentities,
          [providerId]: updater(previous.customSettings.providerIdentities[providerId]),
        },
      }),
    );
  }

  function requestClose() {
    if (closing) return;
    setClosing(true);
    closeTimerRef.current = setTimeout(onClose, 220);
  }

  return createPortal(
    <div
      className={`${closing ? "skills-drawer-backdrop-closing" : "skills-drawer-backdrop"} fixed inset-0 z-50 flex justify-end bg-foreground/[0.06] backdrop-blur-md dark:bg-background/40`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="provider-identity-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <aside
        className={`${closing ? "skills-drawer-panel-closing" : "skills-drawer-panel"} relative flex h-full w-full flex-col overflow-hidden border-l border-border/60 bg-background/95 shadow-[-32px_0_80px_-28px_rgba(15,23,42,0.22)] sm:max-w-[460px]`}
      >
        <div className="flex items-start gap-3 border-b border-border/60 px-6 pb-4 pt-[22px]">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Waypoints className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div id="provider-identity-title" className="text-[17px] font-semibold leading-tight">
              {t("settings.cliIdentityTitle")}
            </div>
            <div className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              {t("settings.cliIdentityDescription")}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-full"
            onClick={requestClose}
            title={t("settings.cliIdentityClose")}
            aria-label={t("settings.cliIdentityClose")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5 max-[480px]:px-4">
          <div className="space-y-3">
            {MANAGED_CLI_IDENTITY_PROVIDER_IDS.map((providerId) => (
              <IdentityRow
                key={providerId}
                providerId={providerId}
                profile={profiles[providerId]}
                providers={settings.customProviders}
                checking={checking}
                error={errors[providerId]}
                onModeChange={(mode) =>
                  updateProfile(providerId, (profile) =>
                    followLatestCliIdentityVersion(setCliIdentityMode(providerId, profile, mode)),
                  )
                }
                onRollback={() =>
                  updateProfile(providerId, (profile) => rollbackCliIdentityVersion(profile))
                }
              />
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-border/60 px-6 py-4 max-[480px]:px-4">
          <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
            {t("settings.cliIdentitySafetyNote")}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 shrink-0 gap-1.5"
            disabled={checking}
            onClick={() => void runCheck(true)}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} />
            {t("settings.cliIdentityCheck")}
          </Button>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

export function ProviderIdentitySummary(props: {
  providerId: AppSettings["customProviders"][number]["type"];
  apiKey: string;
  requestFormat?: AppSettings["customProviders"][number]["requestFormat"];
  customHeaders: AppSettings["customProviders"][number]["customHeaders"];
  identities: AppSettings["customSettings"]["providerIdentities"];
}) {
  const { providerId, apiKey, requestFormat, customHeaders, identities } = props;
  const { t } = useLocale();
  if (providerId === "gemini") return null;
  const custom = customUserAgent(customHeaders);
  const identityDisabled = cliIdentityDisabled(providerId, apiKey, requestFormat);
  const version = getAppliedCliIdentityVersion(providerId, identities[providerId]);
  const userAgent =
    custom ?? (identityDisabled ? "-" : formatCliIdentityUserAgent(providerId, version));
  const source =
    custom !== undefined
      ? t("settings.cliIdentitySourceCustom")
      : identityDisabled
        ? t("settings.cliIdentitySourceDisabled")
        : t("settings.cliIdentitySourceGlobal");

  return (
    <div className="mb-5 rounded-lg bg-muted/45 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t("settings.cliIdentityEffective")}
        </span>
        <span className="text-[10px] font-medium text-foreground/75">{source}</span>
      </div>
      <div className="mt-1 break-all font-mono text-[11px] leading-relaxed text-foreground/85">
        {userAgent}
      </div>
    </div>
  );
}
