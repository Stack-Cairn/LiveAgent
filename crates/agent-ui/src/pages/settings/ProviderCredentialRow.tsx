import "@liveagent/ui/i18n/namespaces/settings";
import { CODEX_REQUEST_FORMAT_LABELS, type CodexRequestFormat } from "@liveagent/app/lib/settings";
import { Eye, EyeOff } from "@liveagent/ui/components/IconSet";
import {
  FormField,
  FormFieldDescription,
  FormFieldLabel,
} from "@liveagent/ui/components/settings/FormField";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { GEMINI_API_PLATFORM_LABEL_KEYS, GEMINI_API_PLATFORM_PRESETS } from "./geminiApiPlatform";
import type { ProviderModalViewModel } from "./ProviderModal";

/** API key field plus the per-type selector to its right (request format, API platform). */
export function ProviderCredentialRow({ viewModel }: { viewModel: ProviderModalViewModel }) {
  const {
    apiKey,
    apiKeyIsRedactedDisplay,
    geminiApiPlatform,
    geminiApiPlatformIsLocked,
    providerType,
    requestFormat,
    revealApiKeyError,
    revealingApiKey,
    selectGeminiApiPlatform,
    setApiKey,
    setRequestFormat,
    showApiKey,
    t,
    toggleShowApiKey,
  } = viewModel;
  const hasSideSelect = providerType === "codex" || providerType === "gemini";
  return (
    <div
      className={cn(
        "grid items-start gap-3",
        hasSideSelect && "grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] max-[640px]:grid-cols-1",
      )}
    >
      <div className="space-y-2">
        <div className="flex items-center">
          <FormFieldLabel htmlFor="modal-apikey">API Key</FormFieldLabel>
        </div>
        <div className="relative">
          <Input
            variant="plain"
            id="modal-apikey"
            type={showApiKey ? "text" : "password"}
            value={apiKey}
            className="h-10 pr-9 shadow-none"
            onChange={(event) => setApiKey(event.currentTarget.value)}
            onFocus={(event) => {
              // The stored-key placeholder is selected whole, so typing replaces it.
              if (apiKeyIsRedactedDisplay) event.currentTarget.select();
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={() => void toggleShowApiKey()}
            disabled={revealingApiKey}
            title={showApiKey ? t("settings.hideApiKey") : t("settings.showApiKey")}
            aria-label={showApiKey ? t("settings.hideApiKey") : t("settings.showApiKey")}
          >
            {showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        </div>
        {revealApiKeyError ? <p className="text-xs text-destructive">{revealApiKeyError}</p> : null}
      </div>
      {providerType === "codex" ? (
        <FormField>
          <div className="flex items-center">
            <FormFieldLabel>{t("settings.requestFormat")}</FormFieldLabel>
          </div>
          <Select
            value={requestFormat}
            onValueChange={(value) => setRequestFormat(value as CodexRequestFormat)}
          >
            <SelectTrigger variant="plain" className="h-10 w-full shadow-none">
              <SelectValue>{CODEX_REQUEST_FORMAT_LABELS[requestFormat]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(CODEX_REQUEST_FORMAT_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      ) : null}
      {providerType === "gemini" ? (
        <FormField>
          <div className="flex items-center">
            <FormFieldLabel>{t("settings.geminiApiPlatform")}</FormFieldLabel>
          </div>
          <Select
            value={geminiApiPlatform}
            onValueChange={(value) => {
              const preset = GEMINI_API_PLATFORM_PRESETS.find((item) => item === value);
              if (preset) selectGeminiApiPlatform(preset);
            }}
            disabled={geminiApiPlatformIsLocked}
          >
            <SelectTrigger
              variant="plain"
              className="h-10 w-full shadow-none"
              aria-label={t("settings.geminiApiPlatform")}
              aria-describedby={
                geminiApiPlatformIsLocked ? "modal-gemini-platform-locked" : undefined
              }
            >
              <SelectValue>{t(GEMINI_API_PLATFORM_LABEL_KEYS[geminiApiPlatform])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {GEMINI_API_PLATFORM_PRESETS.map((preset) => (
                <SelectItem key={preset} value={preset}>
                  {t(GEMINI_API_PLATFORM_LABEL_KEYS[preset])}
                </SelectItem>
              ))}
              {geminiApiPlatform === "custom" ? (
                <SelectItem value="custom">{t(GEMINI_API_PLATFORM_LABEL_KEYS.custom)}</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
          {geminiApiPlatformIsLocked ? (
            <FormFieldDescription id="modal-gemini-platform-locked">
              {t("settings.geminiApiPlatformLocked")}
            </FormFieldDescription>
          ) : null}
        </FormField>
      ) : null}
    </div>
  );
}
