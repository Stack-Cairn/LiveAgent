import type { AppSettings, SttProviderId, SttProviderSettings } from "@liveagent/app/lib/settings";
import {
  Brackets,
  Check,
  CheckCircle2,
  Cloud,
  Eye,
  EyeOff,
  Flame,
  type IconComponent,
  LoaderCircle,
  Mic,
  PawPrint,
  Plug,
  Shield,
  Trash2,
  XCircle,
} from "@liveagent/ui/components/IconSet";
import { Input } from "@liveagent/ui/components/ui/input";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { errorMessageWithFallback } from "@liveagent/ui/lib/shared/value";
import type {
  SttConnectionTestResponse,
  SttConnectionTestResult,
  SttSecretField,
  SttSettingsService,
} from "@liveagent/ui/lib/stt/types";
import { useCallback, useMemo, useRef, useState } from "react";

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

// 品牌视觉:logos 图标集没有这四家国内厂商的商标,用贴近品牌意象的
// lucide 图形 + 品牌色近似值代替(百度=爪印、阿里云=中括号、火山=火焰)。
const PROVIDER_BRAND: Record<
  SttProviderId,
  { icon: IconComponent; iconClass: string; boxClass: string }
> = {
  tencent_cloud: {
    icon: Cloud,
    iconClass: "text-sky-600 dark:text-sky-400",
    boxClass: "bg-sky-500/10",
  },
  volcengine_seed_v3: {
    icon: Flame,
    iconClass: "text-rose-600 dark:text-rose-400",
    boxClass: "bg-rose-500/10",
  },
  aliyun_dashscope: {
    icon: Brackets,
    iconClass: "text-orange-600 dark:text-orange-400",
    boxClass: "bg-orange-500/10",
  },
  baidu_cloud: {
    icon: PawPrint,
    iconClass: "text-indigo-600 dark:text-indigo-400",
    boxClass: "bg-indigo-500/10",
  },
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
  const brand = PROVIDER_BRAND[provider];
  const Icon = brand.icon;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg",
        brand.boxClass,
        className,
      )}
    >
      <Icon className={cn(brand.iconClass, iconClassName)} />
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
  const [testResults, setTestResults] = useState<
    Partial<Record<SttProviderId, SttConnectionTestResponse>>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [visibleSecrets, setVisibleSecrets] = useState<Record<string, boolean>>({});
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
  const [revealingSecret, setRevealingSecret] = useState<string | null>(null);
  const revealRequestRef = useRef(0);

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
      setTestResults((previous) => {
        const next = { ...previous };
        delete next[definition.id];
        return next;
      });
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
  };

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    const nextProvider = {
      ...provider,
      ...draftSecrets,
    } as SttProviderSettings;
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
    setClearing(true);
    setError(null);
    setTestResults((previous) => {
      const next = { ...previous };
      delete next[definition.id];
      return next;
    });
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
      setSettings((previous) => ({ ...previous, stt: redacted }));
      setDraftSecrets({});
      resetSecretVisibility();
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
      setTestResults((previous) => ({ ...previous, [definition.id]: result }));
    } catch (cause) {
      setError(errorMessageWithFallback(cause, "连接测试失败"));
    } finally {
      setTesting(false);
    }
  };

  const resultLabel: Record<SttConnectionTestResult, string> = {
    connected: "连接成功",
    connected_no_speech: "连接成功，未检测到有效语音",
    authentication_failed: "鉴权失败",
    protocol_failed: "协议错误",
    network_failed: "网络错误",
    timeout: "连接超时",
  };
  const testResult = testResults[definition.id] ?? null;
  const testPassed =
    testResult?.result === "connected" || testResult?.result === "connected_no_speech";

  return (
    <div className="w-full min-w-0 space-y-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
          <Mic className="h-[18px] w-[18px] text-primary" />
        </div>
        <div>
          <h3 className="text-sm font-semibold">语音输入</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            桌面端配置会同步到 Gateway WebUI；浏览器仅接收脱敏配置，录音统一为 16 kHz 单声道 PCM。
          </p>
          {service.runtimeLabel ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              当前运行端：{service.runtimeLabel}
            </p>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {PROVIDERS.map((item) => {
          const active = item.id === definition.id;
          const configured = displayedStt.providers[item.id].configured;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => selectProvider(item.id)}
              aria-pressed={active}
              className={cn(
                "group relative flex min-w-0 items-center gap-3 rounded-xl border p-3 text-left transition-all duration-150",
                active
                  ? "border-primary/50 bg-primary/5 shadow-sm ring-1 ring-primary/25"
                  : "border-border/50 bg-background/40 hover:border-border hover:bg-muted/40",
              )}
            >
              <ProviderBrandBadge
                provider={item.id}
                className="h-9 w-9 transition-transform duration-150 group-hover:scale-105"
                iconClassName="h-[18px] w-[18px]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium leading-tight">
                  {item.label}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="truncate">{item.vendor}</span>
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1",
                      configured && "text-emerald-600 dark:text-emerald-400",
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        configured ? "bg-emerald-500" : "bg-muted-foreground/40",
                      )}
                    />
                    {configured ? "已配置" : "未配置"}
                  </span>
                </span>
              </span>
              {active ? (
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="h-3 w-3" />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="w-full min-w-0 space-y-4 rounded-xl border border-border/50 bg-background/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <ProviderBrandBadge
              provider={definition.id}
              className="h-8 w-8"
              iconClassName="h-4 w-4"
            />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium leading-tight">
                {definition.label}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {provider.configured
                  ? "凭据已保存，可直接使用语音输入"
                  : "填写凭据后保存并测试连接"}
              </div>
            </div>
          </div>
          {provider.configured ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
              <Shield className="h-3 w-3" />
              密钥已脱敏保存
            </span>
          ) : null}
        </div>
        <div className="grid min-w-0 gap-x-4 gap-y-3 sm:grid-cols-2">
          {definition.fields.map((field) => {
            const secret = definition.secretFields.includes(field);
            const secretField = secret ? (field as SttSecretField) : null;
            const visible = secretField ? visibleSecrets[secretField] === true : false;
            const hasDraft = secretField ? Object.hasOwn(draftSecrets, secretField) : false;
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
              <div
                key={field}
                className={cn(
                  "block min-w-0 space-y-1.5 text-xs",
                  field === "websocketUrl" && "sm:col-span-2",
                )}
              >
                <label htmlFor={inputId} className="block font-medium text-foreground/80">
                  {fieldLabel(definition.id, field)}
                  {secret && provider.configured ? (
                    <span className="ml-1 font-normal text-muted-foreground">（已保存）</span>
                  ) : null}
                </label>
                <div className="relative min-w-0">
                  <Input
                    id={inputId}
                    type={secret && !visible ? "password" : "text"}
                    autoComplete="off"
                    spellCheck={false}
                    readOnly={
                      Boolean(secretField) && visible && service.secretRevealMode === "field-name"
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
                        setTestResults((previous) => {
                          const next = { ...previous };
                          delete next[definition.id];
                          return next;
                        });
                        setDraftSecrets((old) => ({ ...old, [field]: event.target.value }));
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
                      className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                      disabled={
                        saving ||
                        testing ||
                        clearing ||
                        revealingSecret === secretField ||
                        (service.secretRevealMode === "value" && !provider.configured && !hasDraft)
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
                        visible ? "隐藏该字段" : `查看 ${fieldLabel(definition.id, field)}`
                      }
                    >
                      {revealingSecret === secretField ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : visible ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        {service.secretRevealMode === "field-name" ? (
          <p className="text-[11px] text-muted-foreground">
            WebUI 的查看按钮只显示字段名；已保存的密钥内容不会下发到浏览器。
          </p>
        ) : null}
        {definition.id === "baidu_cloud" ? (
          <p className="text-[11px] text-muted-foreground">
            appid 必须是数字；dev_pid 不提供默认值，请按百度模型填写。
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
          <button
            type="button"
            onClick={() => void test()}
            disabled={saving || testing || clearing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            {saving || testing ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plug className="h-3.5 w-3.5" />
            )}
            {saving ? "正在保存…" : testing ? "正在测试…" : "保存并测试连接"}
          </button>
          <button
            type="button"
            onClick={() => void clearProviderSecrets()}
            disabled={saving || testing || clearing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 px-3.5 py-2 text-xs text-destructive transition-colors hover:bg-destructive/5 disabled:opacity-60"
          >
            {clearing ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {clearing ? "正在清空…" : "清空密钥"}
          </button>
        </div>
        {testResult ? (
          <div
            className={cn(
              "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs",
              testPassed
                ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
                : "border-destructive/30 bg-destructive/5 text-destructive",
            )}
          >
            {testPassed ? (
              <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" />
            ) : (
              <XCircle className="mt-px h-3.5 w-3.5 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="font-medium">{resultLabel[testResult.result]}</div>
              {testResult.message ? (
                <p className="mt-0.5 break-words font-normal text-muted-foreground">
                  {testResult.message}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
            <XCircle className="mt-px h-3.5 w-3.5 shrink-0" />
            <p className="break-words">{error}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
