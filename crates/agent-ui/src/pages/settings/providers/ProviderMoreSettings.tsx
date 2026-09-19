// "更多设置"（设计文档 7 中栏第 5 条）：流内重试、缓存、原生搜索、系统代理。
// 控件沿用旧对话框"请求配置"面板，写入即生效。思考强度不再在供应商级暴露
// （旧存档里的 provider.reasoning 由归一化保留，模型默认档见"编辑模型"）。

import {
  type CustomProvider,
  PROMPT_CACHE_HINT_MODES,
  PROVIDER_RETRY_DEFAULT_MAX_RETRIES,
  PROVIDER_RETRY_MAX_RETRIES_LIMITS,
  type PromptCacheHintMode,
} from "@liveagent/app/lib/settings";
import { Label } from "@liveagent/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { PROMPT_CACHE_HINT_LABEL_KEYS } from "../ProviderPresentation";
import { CommittedInput } from "./providerChips";

function clampRetries(raw: number): number {
  if (!Number.isFinite(raw)) return PROVIDER_RETRY_DEFAULT_MAX_RETRIES;
  return Math.min(
    PROVIDER_RETRY_MAX_RETRIES_LIMITS.max,
    Math.max(PROVIDER_RETRY_MAX_RETRIES_LIMITS.min, Math.round(raw)),
  );
}

function ToggleRow(props: {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { label, hint, checked, onCheckedChange } = props;
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 rounded-lg border px-3 py-1.5">
      <span className="min-w-0">
        <span className="block text-xs text-foreground/90">{label}</span>
        {hint ? (
          <span className="block text-[10.5px] leading-relaxed text-muted-foreground/70">
            {hint}
          </span>
        ) : null}
      </span>
      <Switch
        size="sm"
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        aria-label={label}
      />
    </div>
  );
}

export function ProviderMoreSettings(props: {
  provider: CustomProvider;
  onChange: (updater: (provider: CustomProvider) => CustomProvider) => void;
}) {
  const { provider, onChange } = props;
  const { t } = useLocale();
  const retryMode = provider.retryPolicy?.mode ?? "default";
  const retryCount =
    provider.retryPolicy?.mode === "custom"
      ? provider.retryPolicy.maxRetries
      : PROVIDER_RETRY_DEFAULT_MAX_RETRIES;
  const type = provider.type;
  const supportsCaching = type === "claude_code" || type === "codex";
  const cachingEnabled =
    type === "codex" ? provider.promptCacheHintMode !== "none" : provider.promptCachingEnabled;

  function set(patch: Partial<CustomProvider>) {
    onChange((current) => ({ ...current, ...patch }));
  }

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">
            {t("settings.providerStreamRetry")}
          </Label>
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ["default", "settings.providerStreamRetryDefault"],
                ["off", "settings.providerStreamRetryOff"],
                ["custom", "settings.providerStreamRetryCustom"],
              ] as const
            ).map(([value, labelKey]) => (
              <button
                key={value}
                type="button"
                className={cn(
                  "h-7 rounded-full border px-2.5 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary",
                  retryMode === value && "border-primary bg-primary/10 text-primary",
                )}
                aria-pressed={retryMode === value}
                onClick={() =>
                  set({
                    retryPolicy:
                      value === "default"
                        ? undefined
                        : value === "off"
                          ? { mode: "off" }
                          : { mode: "custom", maxRetries: retryCount },
                  })
                }
              >
                {t(labelKey)}
              </button>
            ))}
            {retryMode === "custom" ? (
              <CommittedInput
                value={String(retryCount)}
                type="number"
                min={PROVIDER_RETRY_MAX_RETRIES_LIMITS.min}
                max={PROVIDER_RETRY_MAX_RETRIES_LIMITS.max}
                inputMode="numeric"
                className="h-7 w-16 text-xs shadow-none"
                aria-label={t("settings.providerStreamRetryMaxRetries")}
                onCommit={(value) =>
                  set({ retryPolicy: { mode: "custom", maxRetries: clampRetries(Number(value)) } })
                }
              />
            ) : null}
          </div>
        </div>
        <ToggleRow
          label={t("settings.providerUseSystemProxy")}
          checked={provider.useSystemProxy}
          onCheckedChange={(checked) => set({ useSystemProxy: checked })}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
        {supportsCaching ? (
          type === "codex" ? (
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">
                {t("settings.promptCacheHintMode")}
              </Label>
              <Select
                value={provider.promptCacheHintMode ?? "auto"}
                onValueChange={(value) =>
                  set({
                    promptCacheHintMode: value as PromptCacheHintMode,
                    promptCachingEnabled: value !== "none",
                  })
                }
              >
                <SelectTrigger
                  className="h-8 text-xs shadow-none"
                  aria-label={t("settings.promptCacheHintMode")}
                >
                  <SelectValue>
                    {t(PROMPT_CACHE_HINT_LABEL_KEYS[provider.promptCacheHintMode ?? "auto"])}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PROMPT_CACHE_HINT_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(PROMPT_CACHE_HINT_LABEL_KEYS[mode])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-1.5">
              <ToggleRow
                label={t("settings.promptCaching")}
                hint={t("settings.promptCachingDescClaude")}
                checked={cachingEnabled}
                onCheckedChange={(checked) => set({ promptCachingEnabled: checked })}
              />
              {cachingEnabled ? (
                <div className="flex flex-wrap items-center gap-1.5 px-1">
                  <span className="text-[11px] text-muted-foreground">
                    {t("settings.promptCacheRetention")}
                  </span>
                  {(
                    [
                      ["short", "settings.promptCacheRetentionShort"],
                      ["long", "settings.promptCacheRetentionLong"],
                    ] as const
                  ).map(([value, labelKey]) => (
                    <button
                      key={value}
                      type="button"
                      className={cn(
                        "h-6 rounded-full border px-2.5 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary",
                        (provider.promptCacheRetention ?? "short") === value &&
                          "border-primary bg-primary/10 text-primary",
                      )}
                      aria-pressed={(provider.promptCacheRetention ?? "short") === value}
                      onClick={() =>
                        set({ promptCacheRetention: value === "long" ? "long" : undefined })
                      }
                    >
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )
        ) : null}
        <ToggleRow
          label={t("settings.nativeWebSearch")}
          hint={t("settings.providerNativeWebSearchHint")}
          checked={provider.nativeWebSearchEnabled}
          onCheckedChange={(checked) => set({ nativeWebSearchEnabled: checked })}
        />
      </div>
    </div>
  );
}
