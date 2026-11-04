import type { AppSettings, SttProviderId, SttProviderSettings } from "@liveagent/app/lib/settings";
import alibabaCloudIcon from "@liveagent/ui/assets/stt/alibaba-cloud.ico";
import baiduCloudIcon from "@liveagent/ui/assets/stt/baidu-cloud.ico";
import tencentCloudIcon from "@liveagent/ui/assets/stt/tencent-cloud.ico";
import volcengineIcon from "@liveagent/ui/assets/stt/volcengine.png";
import {
  ArrowLeft,
  ChevronRight,
  Eye,
  EyeOff,
  LoaderCircle,
  Plug,
  Trash2,
} from "@liveagent/ui/components/IconSet";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@liveagent/ui/components/settings/SettingsLayout";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
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
import { Input } from "@liveagent/ui/components/ui/input";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { toast } from "@liveagent/ui/components/ui/toast-manager";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { errorMessageWithFallback } from "@liveagent/ui/lib/shared/value";
import type {
  SttConnectionTestResult,
  SttSecretField,
  SttSettingsService,
} from "@liveagent/ui/lib/stt/types";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

const PROVIDERS: Array<{
  id: SttProviderId;
  labelKey: string;
  vendor: string;
  fields: Array<keyof SttProviderSettings>;
  secretFields: Array<keyof SttProviderSettings>;
}> = [
  {
    id: "tencent_cloud",
    labelKey: "settings.stt.provider.tencent_cloud",
    vendor: "Tencent Cloud",
    fields: ["appId", "engineModelType", "secretId", "secretKey"],
    secretFields: ["secretId", "secretKey"],
  },
  {
    id: "volcengine_seed_v3",
    labelKey: "settings.stt.provider.volcengine_seed_v3",
    vendor: "Volcengine",
    fields: ["websocketUrl", "appId", "accessToken", "resourceId"],
    secretFields: ["accessToken"],
  },
  {
    id: "aliyun_dashscope",
    labelKey: "settings.stt.provider.aliyun_dashscope",
    vendor: "Alibaba Cloud",
    fields: ["websocketUrl", "model", "apiKey"],
    secretFields: ["apiKey"],
  },
  {
    id: "baidu_cloud",
    labelKey: "settings.stt.provider.baidu_cloud",
    vendor: "Baidu AI Cloud",
    fields: ["websocketUrl", "baiduAppId", "devPid", "baiduApiKey"],
    secretFields: ["baiduApiKey"],
  },
];

const PROVIDER_BRAND: Record<SttProviderId, string> = {
  tencent_cloud: tencentCloudIcon,
  volcengine_seed_v3: volcengineIcon,
  aliyun_dashscope: alibabaCloudIcon,
  baidu_cloud: baiduCloudIcon,
};

function ProviderBrandBadge({
  provider,
  className,
  iconClassName,
}: {
  provider: SttProviderId;
  className?: string;
  iconClassName?: string;
}) {
  const icon = PROVIDER_BRAND[provider];
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg",
        "bg-background",
        className,
      )}
    >
      <img
        src={icon}
        alt=""
        aria-hidden="true"
        className={cn("size-5 object-contain", iconClassName)}
      />
    </span>
  );
}

type Translate = (key: string) => string;

const FIELD_LABEL_KEYS: Partial<Record<keyof SttProviderSettings, string>> = {
  websocketUrl: "settings.stt.field.websocketUrl",
  model: "settings.stt.field.model",
  engineModelType: "settings.stt.field.engineModelType",
  devPid: "settings.stt.field.devPid",
};

const FIELD_LABELS: Partial<Record<keyof SttProviderSettings, string>> = {
  apiKey: "API Key",
  secretId: "SecretId",
  secretKey: "SecretKey",
  accessToken: "Access Token",
  resourceId: "Resource ID",
  baiduAppId: "App ID",
  baiduApiKey: "API Key",
};

const FIELD_PLACEHOLDERS: Partial<Record<keyof SttProviderSettings, string>> = {
  model: "paraformer-realtime-v2",
  engineModelType: "16k_zh",
};

const FIELD_PLACEHOLDER_KEYS: Partial<Record<keyof SttProviderSettings, string>> = {
  resourceId: "settings.stt.placeholder.resourceId",
  devPid: "settings.stt.placeholder.devPid",
};

// The value is deliberately synthetic. A password input renders it as dots
// without placing a saved credential in the page or browser state.
const SAVED_SECRET_MASK = "saved-secret-placeholder";

const RESULT_LABEL_KEYS: Record<SttConnectionTestResult, string> = {
  connected: "settings.stt.result.connected",
  connected_no_speech: "settings.stt.result.connected_no_speech",
  authentication_failed: "settings.stt.result.authentication_failed",
  protocol_failed: "settings.stt.result.protocol_failed",
  network_failed: "settings.stt.result.network_failed",
  timeout: "settings.stt.result.timeout",
};

type ConfigStep = "providers" | "form";

function fieldLabel(t: Translate, provider: SttProviderId, field: keyof SttProviderSettings) {
  if (field === "appId") return provider === "tencent_cloud" ? "AppId" : "App ID";
  const key = FIELD_LABEL_KEYS[field];
  if (key) return t(key);
  return FIELD_LABELS[field] ?? field;
}

function fieldPlaceholder(t: Translate, provider: SttProviderId, field: keyof SttProviderSettings) {
  if (field === "appId") {
    if (provider === "tencent_cloud") return t("settings.stt.placeholder.tencentAppId");
    if (provider === "volcengine_seed_v3") return t("settings.stt.placeholder.volcengineAppId");
  }
  if (field === "apiKey") return "sk-...";
  if (field === "secretId") return "SecretId";
  if (field === "secretKey") return "SecretKey";
  if (field === "accessToken") return "Access Token";
  if (field === "baiduAppId") return t("settings.stt.placeholder.baiduAppId");
  if (field === "baiduApiKey") return "API Key";
  const key = FIELD_PLACEHOLDER_KEYS[field];
  if (key) return t(key);
  return FIELD_PLACEHOLDERS[field] ?? "";
}

function fieldValue(provider: SttProviderSettings, field: keyof SttProviderSettings) {
  return typeof provider[field] === "string" ? (provider[field] as string) : "";
}

export function SttSection({
  settings,
  setSettings,
  service,
  selectedProvider,
  onSelectedProviderChange,
}: {
  settings: AppSettings;
  setSettings: (updater: (previous: AppSettings) => AppSettings) => void;
  service: SttSettingsService;
  selectedProvider: SttProviderId;
  onSelectedProviderChange: (provider: SttProviderId) => void;
}) {
  const { t } = useLocale();
  const displayedStt = settings.stt;
  const definition = useMemo(
    () => PROVIDERS.find((item) => item.id === selectedProvider) ?? PROVIDERS[0],
    [selectedProvider],
  );
  const [draftProviders, setDraftProviders] = useState<
    Partial<Record<SttProviderId, Partial<SttProviderSettings>>>
  >({});
  const provider = {
    ...displayedStt.providers[definition.id],
    ...draftProviders[definition.id],
  };
  const [draftSecrets, setDraftSecrets] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [configStep, setConfigStep] = useState<ConfigStep>("providers");
  const [error, setError] = useState<string | null>(null);
  const [visibleSecrets, setVisibleSecrets] = useState<Record<string, boolean>>({});
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
  const [revealingSecret, setRevealingSecret] = useState<string | null>(null);
  const revealRequestRef = useRef(0);
  const toastScope = useId();
  const { confirm, dialog } = useConfirmDialog();

  useEffect(() => {
    if (!error) return;
    toast.error(error, { id: `${toastScope}-error`, appearance: "notice" });
  }, [error, toastScope]);

  useEffect(
    () => () => {
      toast.dismiss(`${toastScope}-error`);
      toast.dismiss(`${toastScope}-test`);
    },
    [toastScope],
  );

  const resetSecretVisibility = useCallback(() => {
    revealRequestRef.current += 1;
    setVisibleSecrets({});
    setRevealedSecrets({});
    setRevealingSecret(null);
  }, []);

  const toggleSecretVisibility = useCallback(
    async (field: SttSecretField) => {
      if (visibleSecrets[field]) {
        revealRequestRef.current += 1;
        setVisibleSecrets((previous) => ({ ...previous, [field]: false }));
        setRevealedSecrets((previous) => {
          const next = { ...previous };
          delete next[field];
          return next;
        });
        return;
      }

      setError(null);
      if (service.secretRevealMode === "field-name") {
        setVisibleSecrets((previous) => ({ ...previous, [field]: true }));
        return;
      }
      if (Object.hasOwn(draftSecrets, field) && draftSecrets[field]) {
        setVisibleSecrets((previous) => ({ ...previous, [field]: true }));
        return;
      }
      if (!service.revealSecret) {
        setError(t("settings.stt.revealUnsupported"));
        return;
      }

      const requestId = ++revealRequestRef.current;
      setRevealingSecret(field);
      try {
        const value = await service.revealSecret(definition.id, field);
        if (revealRequestRef.current !== requestId) return;
        setRevealedSecrets((previous) => ({ ...previous, [field]: value }));
        setVisibleSecrets((previous) => ({ ...previous, [field]: true }));
      } catch (cause) {
        if (revealRequestRef.current !== requestId) return;
        setError(errorMessageWithFallback(cause, t("settings.stt.revealFailed")));
      } finally {
        if (revealRequestRef.current === requestId) setRevealingSecret(null);
      }
    },
    [definition.id, draftSecrets, service, t, visibleSecrets],
  );

  const updateProvider = useCallback(
    (patch: Partial<SttProviderSettings>) => {
      setDraftProviders((previous) => ({
        ...previous,
        [definition.id]: { ...previous[definition.id], ...patch },
      }));
    },
    [definition.id],
  );

  const selectProvider = (id: SttProviderId) => {
    setError(null);
    setDraftSecrets({});
    resetSecretVisibility();
    onSelectedProviderChange(id);
    setConfigStep("form");
  };

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    const nextProvider = {
      ...provider,
      ...draftSecrets,
    } as SttProviderSettings;
    // save() is never a clear: leftover clearSecrets from the previous
    // empty-key write would wipe newly typed credentials.
    delete nextProvider.clearSecrets;
    const payload = {
      ...displayedStt,
      provider: definition.id,
      providers: { ...displayedStt.providers, [definition.id]: nextProvider },
    };
    try {
      const redacted = await service.update(payload);
      setSettings((previous) => ({ ...previous, stt: redacted }));
      setDraftProviders((previous) => {
        const next = { ...previous };
        delete next[definition.id];
        return next;
      });
      setDraftSecrets({});
      resetSecretVisibility();
      return true;
    } catch (cause) {
      setError(errorMessageWithFallback(cause, t("settings.stt.saveFailed")));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const clearProviderSecrets = async () => {
    const confirmed = await confirm({
      title: t("settings.stt.clearConfirmTitle"),
      subtitle: t(definition.labelKey),
      description: t("settings.stt.clearConfirmDescription"),
      confirmLabel: t("settings.stt.clearSecrets"),
      cancelLabel: t("settings.cancel"),
    });
    if (!confirmed) return;

    setClearing(true);
    setError(null);
    const payload = {
      ...displayedStt,
      provider: definition.id,
      providers: {
        ...displayedStt.providers,
        [definition.id]: {
          ...displayedStt.providers[definition.id],
          clearSecrets: true,
        },
      },
    };
    try {
      const redacted = await service.update(payload);
      // The service has already cleared the secret, but the host settings
      // layer persists every local state change as well. Keep the explicit
      // clear marker through that second write so an incomplete provider is
      // not rejected as an accidental partial configuration.
      setSettings((previous) => ({
        ...previous,
        stt: {
          ...redacted,
          providers: {
            ...redacted.providers,
            [definition.id]: {
              ...redacted.providers[definition.id],
              clearSecrets: true,
            },
          },
        },
      }));
      setDraftSecrets({});
      resetSecretVisibility();
      toast.success(t("settings.stt.secretsCleared"), {
        id: `${toastScope}-test`,
        appearance: "notice",
      });
    } catch (cause) {
      setError(errorMessageWithFallback(cause, t("settings.stt.clearFailed")));
    } finally {
      setClearing(false);
    }
  };

  const test = async () => {
    if (!(await save())) return;
    setTesting(true);
    setError(null);
    try {
      const result = await service.test(definition.id);
      const passed = result.result === "connected" || result.result === "connected_no_speech";
      const resultLabel = t(RESULT_LABEL_KEYS[result.result]);
      const message = result.message
        ? t("settings.stt.resultWithMessage")
            .replace("{result}", resultLabel)
            .replace("{message}", () => result.message ?? "")
        : resultLabel;
      const options = { id: `${toastScope}-test`, appearance: "notice" as const };
      if (passed) toast.success(message, options);
      else toast.error(message, options);
    } catch (cause) {
      setError(errorMessageWithFallback(cause, t("settings.stt.testFailed")));
    } finally {
      setTesting(false);
    }
  };

  const handleConfigOpenChange = (open: boolean) => {
    setConfigOpen(open);
    if (open) {
      setError(null);
      setConfigStep("providers");
      onSelectedProviderChange(displayedStt.provider ?? definition.id);
      return;
    }
    setDraftProviders({});
    setDraftSecrets({});
    setError(null);
    setConfigStep("providers");
    resetSecretVisibility();
    onSelectedProviderChange(displayedStt.provider ?? definition.id);
  };

  return (
    <div className="w-full min-w-0 space-y-6">
      <SettingsSection title={t("settings.groupGeneral")}>
        <SettingsCard>
          <SettingsRow
            title={t("settings.stt.enable")}
            description={
              <>
                {t("settings.stt.enableDescription")}
                {service.runtimeLabel ? (
                  <span className="block">
                    {t("settings.stt.runtime").replace("{runtime}", service.runtimeLabel)}
                  </span>
                ) : null}
              </>
            }
            control={
              <Switch
                checked={displayedStt.enabled}
                onCheckedChange={(enabled) =>
                  setSettings((previous) => ({
                    ...previous,
                    stt: { ...previous.stt, enabled, allowIncomplete: true },
                  }))
                }
                aria-label={t("settings.stt.enable")}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("settings.stt.sectionService")}>
        <SettingsCard>
          <SettingsRow
            title={t(definition.labelKey)}
            description={
              <span className="inline-flex items-center gap-1.5">
                <span>{definition.vendor}</span>
                <span aria-hidden="true">·</span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1",
                    provider.configured && "text-emerald-600 dark:text-emerald-400",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      provider.configured ? "bg-emerald-500" : "bg-muted-foreground/40",
                    )}
                  />
                  {provider.configured
                    ? t("settings.stt.configured")
                    : t("settings.stt.notConfigured")}
                </span>
              </span>
            }
            control={
              <Dialog open={configOpen} onOpenChange={handleConfigOpenChange}>
                <DialogTrigger
                  render={
                    <Button size="sm" variant={provider.configured ? "outline" : "default"} />
                  }
                >
                  {provider.configured ? t("settings.stt.manage") : t("settings.stt.setUp")}
                </DialogTrigger>
                <DialogContent
                  className="flex max-h-[calc(100dvh-2rem)] max-w-xl flex-col"
                  closeLabel={t("settings.close")}
                  showCloseButton
                >
                  {configStep === "providers" ? (
                    <>
                      <DialogHeader>
                        <DialogTitle>{t("settings.stt.chooseProviderTitle")}</DialogTitle>
                        <DialogDescription>
                          {t("settings.stt.chooseProviderDescription")}
                        </DialogDescription>
                      </DialogHeader>

                      <DialogBody className="space-y-1.5">
                        {PROVIDERS.map((item) => {
                          const configured = displayedStt.providers[item.id].configured;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => selectProvider(item.id)}
                              className={cn(
                                "group flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl",
                                "bg-settings-tile px-3.5 py-3 text-left transition-colors",
                                "hover:bg-settings-tile-hover",
                              )}
                            >
                              <ProviderBrandBadge
                                provider={item.id}
                                className="size-9"
                                iconClassName="size-18px"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium text-foreground">
                                  {t(item.labelKey)}
                                </span>
                                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                                  <span>{item.vendor}</span>
                                  {configured ? (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                                        <span className="size-1.5 rounded-full bg-emerald-500" />
                                        {t("settings.stt.configured")}
                                      </span>
                                    </>
                                  ) : null}
                                </span>
                              </span>
                              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                            </button>
                          );
                        })}
                      </DialogBody>
                    </>
                  ) : (
                    <>
                      <DialogHeader>
                        <div className="flex min-w-0 items-center gap-2">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="-ml-2 shrink-0 rounded-lg"
                            aria-label={t("settings.stt.backToProviders")}
                            title={t("settings.stt.backToProviders")}
                            onClick={() => {
                              setDraftProviders({});
                              setDraftSecrets({});
                              setError(null);
                              resetSecretVisibility();
                              setConfigStep("providers");
                            }}
                          >
                            <ArrowLeft className="size-4" />
                          </Button>
                          <div className="min-w-0">
                            <DialogTitle className="truncate">{t(definition.labelKey)}</DialogTitle>
                            <DialogDescription>
                              {provider.configured
                                ? t("settings.stt.formConfiguredDescription")
                                : t("settings.stt.formDescription")}
                            </DialogDescription>
                          </div>
                        </div>
                      </DialogHeader>

                      <DialogBody className="space-y-4">
                        {definition.fields.map((field) => {
                          const secret = definition.secretFields.includes(field);
                          const secretField = secret ? (field as SttSecretField) : null;
                          const visible = secretField
                            ? visibleSecrets[secretField] === true
                            : false;
                          const hasDraft = secretField
                            ? Object.hasOwn(draftSecrets, secretField)
                            : false;
                          const value = !secretField
                            ? fieldValue(provider, field)
                            : visible && service.secretRevealMode === "field-name"
                              ? fieldLabel(t, definition.id, field)
                              : hasDraft
                                ? (draftSecrets[secretField] ?? "")
                                : visible
                                  ? (revealedSecrets[secretField] ?? "")
                                  : provider.configured
                                    ? SAVED_SECRET_MASK
                                    : "";
                          const inputId = `stt-${definition.id}-${String(field)}`;
                          return (
                            <div key={field} className="min-w-0 space-y-1.5">
                              <label
                                htmlFor={inputId}
                                className="block text-xs font-medium text-foreground"
                              >
                                {fieldLabel(t, definition.id, field)}
                                {secret && provider.configured ? (
                                  <span className="ml-1 font-normal text-muted-foreground">
                                    {t("settings.stt.savedSuffix")}
                                  </span>
                                ) : null}
                              </label>
                              <div className="relative min-w-0">
                                <Input
                                  variant="plain"
                                  id={inputId}
                                  type={secret && !visible ? "password" : "text"}
                                  autoComplete="off"
                                  spellCheck={false}
                                  readOnly={
                                    Boolean(secretField) &&
                                    visible &&
                                    service.secretRevealMode === "field-name"
                                  }
                                  className={secret ? "w-full min-w-0 pr-10" : "w-full min-w-0"}
                                  inputMode={
                                    (definition.id === "tencent_cloud" && field === "appId") ||
                                    (definition.id === "baidu_cloud" &&
                                      (field === "baiduAppId" || field === "devPid"))
                                      ? "numeric"
                                      : undefined
                                  }
                                  value={value}
                                  placeholder={fieldPlaceholder(t, definition.id, field)}
                                  onFocus={(event) => {
                                    if (secret && provider.configured && !hasDraft && !visible) {
                                      event.currentTarget.select();
                                    }
                                  }}
                                  onClick={(event) => {
                                    if (secret && provider.configured && !hasDraft && !visible) {
                                      event.currentTarget.select();
                                    }
                                  }}
                                  onChange={(event) => {
                                    if (secret) {
                                      setDraftSecrets((old) => ({
                                        ...old,
                                        [field]: event.target.value,
                                      }));
                                      return;
                                    }
                                    updateProvider({
                                      [field]: event.target.value,
                                    } as Partial<SttProviderSettings>);
                                  }}
                                />
                                {secretField ? (
                                  <button
                                    type="button"
                                    className={cn(
                                      "absolute right-1 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center",
                                      "cursor-pointer rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                                      "disabled:pointer-events-none disabled:opacity-50",
                                    )}
                                    disabled={
                                      saving ||
                                      testing ||
                                      clearing ||
                                      revealingSecret === secretField ||
                                      (service.secretRevealMode === "value" &&
                                        !provider.configured &&
                                        !hasDraft)
                                    }
                                    onClick={() => void toggleSecretVisibility(secretField)}
                                    title={
                                      visible
                                        ? t("settings.stt.hideField")
                                        : service.secretRevealMode === "field-name"
                                          ? t("settings.stt.showFieldName")
                                          : t("settings.stt.showSavedSecret")
                                    }
                                    aria-label={
                                      visible
                                        ? t("settings.stt.hideField")
                                        : t("settings.stt.showField").replace(
                                            "{field}",
                                            fieldLabel(t, definition.id, field),
                                          )
                                    }
                                  >
                                    {revealingSecret === secretField ? (
                                      <LoaderCircle className="size-4 animate-spin" />
                                    ) : visible ? (
                                      <EyeOff className="size-4" />
                                    ) : (
                                      <Eye className="size-4" />
                                    )}
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}

                        {service.secretRevealMode === "field-name" ? (
                          <p className="text-xs leading-5 text-muted-foreground">
                            {t("settings.stt.webuiSecretNotice")}
                          </p>
                        ) : null}
                        {definition.id === "baidu_cloud" ? (
                          <p className="text-xs leading-5 text-muted-foreground">
                            {t("settings.stt.baiduHint")}
                          </p>
                        ) : null}
                      </DialogBody>

                      <DialogFooter className="justify-between sm:justify-between">
                        <div>
                          {provider.configured ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={saving || testing || clearing}
                              className="text-destructive hover:bg-destructive/5 hover:text-destructive"
                              onClick={() => void clearProviderSecrets()}
                            >
                              {clearing ? (
                                <LoaderCircle className="size-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="size-3.5" />
                              )}
                              {clearing
                                ? t("settings.stt.clearing")
                                : t("settings.stt.clearSecrets")}
                            </Button>
                          ) : null}
                        </div>
                        <Button
                          size="sm"
                          disabled={saving || testing || clearing}
                          onClick={() => void test()}
                        >
                          {saving || testing ? (
                            <LoaderCircle className="size-3.5 animate-spin" />
                          ) : (
                            <Plug className="size-3.5" />
                          )}
                          {saving
                            ? t("settings.stt.saving")
                            : testing
                              ? t("settings.stt.testing")
                              : t("settings.stt.saveAndTest")}
                        </Button>
                      </DialogFooter>
                    </>
                  )}
                </DialogContent>
              </Dialog>
            }
          />
        </SettingsCard>
      </SettingsSection>

      {dialog}
    </div>
  );
}
