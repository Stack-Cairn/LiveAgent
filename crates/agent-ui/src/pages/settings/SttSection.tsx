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
  label: string;
  vendor: string;
  fields: Array<keyof SttProviderSettings>;
  secretFields: Array<keyof SttProviderSettings>;
}> = [
  {
    id: "tencent_cloud",
    label: "腾讯云实时语音识别",
    vendor: "Tencent Cloud",
    fields: ["appId", "engineModelType", "secretId", "secretKey"],
    secretFields: ["secretId", "secretKey"],
  },
  {
    id: "volcengine_seed_v3",
    label: "火山引擎实时语音识别",
    vendor: "Volcengine",
    fields: ["websocketUrl", "appId", "accessToken", "resourceId"],
    secretFields: ["accessToken"],
  },
  {
    id: "aliyun_dashscope",
    label: "阿里云 DashScope",
    vendor: "Alibaba Cloud",
    fields: ["websocketUrl", "model", "apiKey"],
    secretFields: ["apiKey"],
  },
  {
    id: "baidu_cloud",
    label: "百度智能云实时语音识别",
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

const FIELD_LABELS: Partial<Record<keyof SttProviderSettings, string>> = {
  websocketUrl: "实时识别 WebSocket 地址",
  model: "模型名称",
  apiKey: "API Key",
  secretId: "SecretId",
  secretKey: "SecretKey",
  accessToken: "Access Token",
  resourceId: "Resource ID",
  engineModelType: "引擎模型（16k_zh）",
  baiduAppId: "App ID",
  baiduApiKey: "API Key",
  devPid: "dev_pid（识别模型编号）",
};

const FIELD_PLACEHOLDERS: Partial<Record<keyof SttProviderSettings, string>> = {
  model: "paraformer-realtime-v2",
  engineModelType: "16k_zh",
  resourceId: "火山引擎资源 ID",
  baiduAppId: "例如：124151367",
  devPid: "请按已开通的实时识别模型填写",
};

// The value is deliberately synthetic. A password input renders it as dots
// without placing a saved credential in the page or browser state.
const SAVED_SECRET_MASK = "saved-secret-placeholder";

const RESULT_LABEL: Record<SttConnectionTestResult, string> = {
  connected: "连接成功",
  connected_no_speech: "连接成功，未检测到有效语音",
  authentication_failed: "鉴权失败",
  protocol_failed: "协议错误",
  network_failed: "网络错误",
  timeout: "连接超时",
};

type ConfigStep = "providers" | "form";

function fieldLabel(provider: SttProviderId, field: keyof SttProviderSettings) {
  if (field === "appId") return provider === "tencent_cloud" ? "AppId" : "App ID";
  return FIELD_LABELS[field] ?? field;
}

function fieldPlaceholder(provider: SttProviderId, field: keyof SttProviderSettings) {
  if (field === "appId") {
    if (provider === "tencent_cloud") return "腾讯云应用 AppId";
    if (provider === "volcengine_seed_v3") return "火山引擎应用 App ID";
  }
  if (field === "apiKey") return "sk-...";
  if (field === "secretId") return "SecretId";
  if (field === "secretKey") return "SecretKey";
  if (field === "accessToken") return "Access Token";
  if (field === "baiduAppId") return "百度语音应用 App ID";
  if (field === "baiduApiKey") return "API Key";
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
        setError("当前运行端不支持查看已保存的 STT 密钥");
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
        setError(errorMessageWithFallback(cause, "无法查看已保存的 STT 密钥"));
      } finally {
        if (revealRequestRef.current === requestId) setRevealingSecret(null);
      }
    },
    [definition.id, draftSecrets, service, visibleSecrets],
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
      setError(errorMessageWithFallback(cause, "STT 配置保存失败"));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const clearProviderSecrets = async () => {
    const confirmed = await confirm({
      title: "清空已保存的密钥？",
      subtitle: definition.label,
      description: "清空后，该识别服务将无法使用，直到重新填写凭据。",
      confirmLabel: "清空密钥",
      cancelLabel: "取消",
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
      toast.success("密钥已清空", {
        id: `${toastScope}-test`,
        appearance: "notice",
      });
    } catch (cause) {
      setError(errorMessageWithFallback(cause, "STT 密钥清空失败"));
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
      const message = [RESULT_LABEL[result.result], result.message].filter(Boolean).join("：");
      const options = { id: `${toastScope}-test`, appearance: "notice" as const };
      if (passed) toast.success(message, options);
      else toast.error(message, options);
    } catch (cause) {
      setError(errorMessageWithFallback(cause, "连接测试失败"));
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
      <SettingsSection title="通用">
        <SettingsCard>
          <SettingsRow
            title="开启语音输入"
            description={
              <>
                在聊天输入框中显示麦克风按钮。
                {service.runtimeLabel ? (
                  <span className="block">当前运行端：{service.runtimeLabel}</span>
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
                aria-label="开启语音输入"
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="识别服务">
        <SettingsCard>
          <SettingsRow
            title={definition.label}
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
                  {provider.configured ? "已配置" : "未配置"}
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
                  {provider.configured ? "管理" : "设置服务"}
                </DialogTrigger>
                <DialogContent
                  className="flex max-h-[calc(100dvh-2rem)] max-w-xl flex-col"
                  closeLabel="关闭"
                  showCloseButton
                >
                  {configStep === "providers" ? (
                    <>
                      <DialogHeader>
                        <DialogTitle>选择语音识别服务</DialogTitle>
                        <DialogDescription>
                          选择一家服务商，然后填写对应的连接凭据。
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
                                  {item.label}
                                </span>
                                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                                  <span>{item.vendor}</span>
                                  {configured ? (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                                        <span className="size-1.5 rounded-full bg-emerald-500" />
                                        已配置
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
                            aria-label="返回选择服务"
                            title="返回选择服务"
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
                            <DialogTitle className="truncate">{definition.label}</DialogTitle>
                            <DialogDescription>
                              {provider.configured
                                ? "凭据已保存，可以修改后重新测试连接。"
                                : "填写凭据并测试连接。"}
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
                              ? fieldLabel(definition.id, field)
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
                                {fieldLabel(definition.id, field)}
                                {secret && provider.configured ? (
                                  <span className="ml-1 font-normal text-muted-foreground">
                                    （已保存）
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
                                  placeholder={fieldPlaceholder(definition.id, field)}
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
                                        ? "隐藏该字段"
                                        : service.secretRevealMode === "field-name"
                                          ? "查看字段名（WebUI 不显示密钥内容）"
                                          : "查看已保存的密钥"
                                    }
                                    aria-label={
                                      visible
                                        ? "隐藏该字段"
                                        : `查看 ${fieldLabel(definition.id, field)}`
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
                            WebUI 仅显示密钥字段名，已保存的密钥内容不会发送到浏览器。
                          </p>
                        ) : null}
                        {definition.id === "baidu_cloud" ? (
                          <p className="text-xs leading-5 text-muted-foreground">
                            App ID 必须是数字；dev_pid 请按已开通的识别模型填写。
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
                              {clearing ? "正在清空…" : "清空密钥"}
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
                          {saving ? "正在保存…" : testing ? "正在测试…" : "保存并测试连接"}
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
