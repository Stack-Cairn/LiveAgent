// Retry-error config: let the user define which upstream errors the stream-retry
// loop should treat as retryable.
//
// Background: relay/proxy stations (Cloudflare-fronted) intermittently return
// 520/521/525 and similar transient 5xx. Before #608 these were not retried, so
// the request failed outright. pi-ai's isRetryableAssistantError covers the
// common codes 429/500/502/503/504/524, but not the Cloudflare 5xx relays emit.
//
// This section exposes the "retry-error extension" LiveAgent layers on top of
// pi-ai for the user to configure:
//   1. Preset status code toggles (Cloudflare 520-527) — all on by default, so
//      #608 is fixed out of the box;
//   2. Custom error keywords (case-insensitive substrings) — covers relay/gateway
//      wording pi-ai doesn't recognize, e.g. "SSL handshake failed".
// The runtime layers both onto streamRetry's and providerFailover's retryable
// classification. Local UI preference only (localStorage), not gateway-synced.

import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { Check, Plus, RefreshCw, X } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import { RETRYABLE_PRESET_HTTP_STATUS_CODES } from "@liveagent/ui/lib/settings/types";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState } from "react";
import { DrawerGroupLabel, DrawerSectionHeader } from "./ProviderPresentation";

export function RetryErrorSection(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const retryErrorSettings = settings.retryErrorSettings;
  const [patternDraft, setPatternDraft] = useState("");

  function isPresetEnabled(code: number): boolean {
    return retryErrorSettings.presetStatusCodes.includes(code);
  }

  function togglePresetCode(code: number, enabled: boolean) {
    setSettings((prev) => {
      const current = prev.retryErrorSettings.presetStatusCodes;
      const next = enabled
        ? current.includes(code)
          ? current
          : [...current, code]
        : current.filter((item) => item !== code);
      return {
        ...prev,
        retryErrorSettings: {
          ...prev.retryErrorSettings,
          presetStatusCodes: next,
        },
      };
    });
  }

  function addPattern() {
    const trimmed = patternDraft.trim();
    if (!trimmed) return;
    setPatternDraft("");
    setSettings((prev) => ({
      ...prev,
      retryErrorSettings: {
        ...prev.retryErrorSettings,
        // normalizeSettings de-dupes case-insensitively and drops empties.
        customPatterns: [...prev.retryErrorSettings.customPatterns, trimmed],
      },
    }));
  }

  function removePattern(pattern: string) {
    setSettings((prev) => ({
      ...prev,
      retryErrorSettings: {
        ...prev.retryErrorSettings,
        customPatterns: prev.retryErrorSettings.customPatterns.filter((item) => item !== pattern),
      },
    }));
  }

  return (
    <section className="py-5 last:pb-0">
      <DrawerSectionHeader
        icon={<RefreshCw className="h-3.5 w-3.5" />}
        title={t("settings.retryError")}
        hint={t("settings.retryErrorDesc")}
      />

      <div className="mt-3.5 space-y-5">
        {/* Preset Cloudflare 5xx toggles — compact selectable chips; the full
            Cloudflare wording lives in the title tooltip of each chip. */}
        <div className="space-y-2">
          <DrawerGroupLabel
            label={t("settings.retryErrorPresets")}
            hint={t("settings.retryErrorBuiltinNote")}
          />
          <div className="grid grid-cols-2 gap-1.5">
            {RETRYABLE_PRESET_HTTP_STATUS_CODES.map((code) => {
              const enabled = isPresetEnabled(code);
              return (
                <button
                  key={code}
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  title={t(`settings.retryError.preset.${code}`)}
                  aria-label={t(`settings.retryError.preset.${code}`)}
                  onClick={() => togglePresetCode(code, !enabled)}
                  className={cn(
                    "flex h-8 items-center gap-1.5 rounded-lg border px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    enabled
                      ? "border-primary/25 bg-primary/[0.06] text-foreground"
                      : "border-foreground/[0.07] text-muted-foreground/75 hover:border-foreground/[0.15] hover:text-foreground/80",
                  )}
                >
                  <code
                    className={cn(
                      "flex shrink-0 items-center rounded px-1 py-0.5 font-mono text-[10px] leading-none tabular-nums transition-colors",
                      enabled
                        ? "bg-primary/15 text-primary"
                        : "bg-foreground/[0.06] text-muted-foreground",
                    )}
                  >
                    {code}
                  </code>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">
                    {t(`settings.retryError.presetShort.${code}`)}
                  </span>
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 text-primary transition-opacity",
                      enabled ? "opacity-100" : "opacity-0",
                    )}
                  />
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom error keywords */}
        <div className="space-y-2">
          <DrawerGroupLabel
            label={t("settings.retryErrorCustomPatterns")}
            hint={t("settings.retryErrorCustomPatternsDesc")}
          />
          <div className="flex items-center gap-1.5">
            <Input
              value={patternDraft}
              placeholder={t("settings.retryErrorCustomPatternPlaceholder")}
              onChange={(event) => setPatternDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addPattern();
                }
              }}
              className="h-8 rounded-lg text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1 rounded-lg px-2.5"
              onClick={addPattern}
              disabled={!patternDraft.trim()}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("settings.retryErrorAddPattern")}
            </Button>
          </div>
          {retryErrorSettings.customPatterns.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {retryErrorSettings.customPatterns.map((pattern) => (
                <button
                  key={pattern}
                  type="button"
                  onClick={() => removePattern(pattern)}
                  className="group flex items-center gap-1 rounded-full border border-border/60 bg-background/60 py-1 pl-2.5 pr-1.5 text-xs text-foreground/90 transition-colors hover:border-destructive/40 hover:bg-destructive/5"
                  title={t("settings.retryErrorRemovePattern")}
                  aria-label={`${t("settings.retryErrorRemovePattern")} ${pattern}`}
                >
                  <span className="font-mono text-[11px] leading-none">{pattern}</span>
                  <span className="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors group-hover:text-destructive">
                    <X className="h-3 w-3" />
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
