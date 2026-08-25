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

import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useState } from "react";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { RETRYABLE_PRESET_HTTP_STATUS_CODES } from "@liveagent/ui/lib/settings/types";

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
        customPatterns: prev.retryErrorSettings.customPatterns.filter(
          (item) => item !== pattern,
        ),
      },
    }));
  }

  return (
    <section className="py-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label className="text-[12.5px] font-medium text-foreground/85">
            {t("settings.retryError")}
          </Label>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/80">
            {t("settings.retryErrorDesc")}
          </p>
        </div>
      </div>

      {/* Preset Cloudflare 5xx toggles */}
      <div className="mt-4 space-y-1.5">
        <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {t("settings.retryErrorPresets")}
        </Label>
        <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/50 bg-background/60">
          {RETRYABLE_PRESET_HTTP_STATUS_CODES.map((code) => (
            <div key={code} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] leading-none text-foreground/90">
                    {code}
                  </code>
                  <span className="text-sm font-medium">
                    {t(`settings.retryError.preset.${code}`)}
                  </span>
                </div>
              </div>
              <Switch
                checked={isPresetEnabled(code)}
                aria-label={t(`settings.retryError.preset.${code}`)}
                onCheckedChange={(checked) => togglePresetCode(code, checked === true)}
              />
            </div>
          ))}
        </div>
        <p className="px-1 text-[11px] leading-relaxed text-muted-foreground/70">
          {t("settings.retryErrorBuiltinNote")}
        </p>
      </div>

      {/* Custom error patterns */}
      <div className="mt-4 space-y-1.5">
        <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {t("settings.retryErrorCustomPatterns")}
        </Label>
        <p className="px-1 text-[11px] leading-relaxed text-muted-foreground/70">
          {t("settings.retryErrorCustomPatternsDesc")}
        </p>
        <div className="flex items-center gap-2">
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
          />
          <Button variant="outline" size="sm" onClick={addPattern} disabled={!patternDraft.trim()}>
            {t("settings.retryErrorAddPattern")}
          </Button>
        </div>
        {retryErrorSettings.customPatterns.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {retryErrorSettings.customPatterns.map((pattern) => (
              <button
                key={pattern}
                type="button"
                onClick={() => removePattern(pattern)}
                className="group flex items-center gap-1 rounded-full border border-border/60 bg-background/60 py-1 pl-2.5 pr-1.5 text-xs text-foreground/90 transition-colors hover:border-destructive/40 hover:bg-destructive/5"
                title={t("settings.retryErrorRemovePattern")}
              >
                <span className="font-mono">{pattern}</span>
                <span className="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors group-hover:text-destructive">
                  ×
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="px-1 text-[11px] leading-relaxed text-muted-foreground/60">
            {t("settings.retryErrorCustomPatternEmpty")}
          </p>
        )}
      </div>
    </section>
  );
}
