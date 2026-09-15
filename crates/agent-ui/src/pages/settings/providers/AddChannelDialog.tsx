// "添加渠道"对话框（设计文档 7）：自定义中转、聚合网关或尚未内置的厂商。
// 头像首字、名称、类型、API 密钥、四类接口的 Base URL（两类常显、两类折叠），
// 填根地址后即时显示实际请求路径；"从预设创建（可选）"填入该渠道的接口与地址；
// "再加一个实例"从来源实例预填名称、类型、端点地址与方言。

import {
  type CustomProvider,
  PROVIDER_CHAT_PROTOCOLS,
  type ProviderChatProtocol,
} from "@liveagent/app/lib/settings";
import { ChevronDown } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  CUSTOM_PRESET_ID,
  expandPresetBaseUrl,
  findProviderPreset,
  listProviderPresets,
  PROVIDER_PROTOCOL_REQUEST_PATH,
  type ProviderPreset,
} from "@liveagent/ui/lib/providers/registry";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState } from "react";
import { Chip, dialectLabel, protocolLabel, SecretInput } from "./providerChips";
import {
  createProviderFromEndpoints,
  instanceNameForCopy,
  instanceNameForPreset,
  materializedEndpointConfigs,
} from "./providerSettingsModel";

const PRIMARY_PROTOCOLS: ProviderChatProtocol[] = ["openai-completions", "anthropic-messages"];
const MORE_PROTOCOLS: ProviderChatProtocol[] = ["openai-responses", "google-generative-ai"];

type Category = NonNullable<CustomProvider["category"]>;

function endpointsFromPreset(
  preset: ProviderPreset,
): Partial<Record<ProviderChatProtocol, string>> {
  const out: Partial<Record<ProviderChatProtocol, string>> = {};
  for (const protocol of PROVIDER_CHAT_PROTOCOLS) {
    const endpoint = preset.endpoints[protocol];
    if (!endpoint) continue;
    out[protocol] = expandPresetBaseUrl(endpoint.baseUrl, preset.defaultOrigin);
  }
  return out;
}

function endpointsFromProvider(
  provider: CustomProvider,
): Partial<Record<ProviderChatProtocol, string>> {
  const out: Partial<Record<ProviderChatProtocol, string>> = {};
  for (const [protocol, config] of Object.entries(materializedEndpointConfigs(provider))) {
    if (config?.baseUrl) out[protocol as ProviderChatProtocol] = config.baseUrl;
  }
  return out;
}

function requestPathPreview(protocol: ProviderChatProtocol, baseUrl: string): string {
  const root = baseUrl.trim().replace(/\/+$/, "");
  if (protocol === "anthropic-messages" && /\/v1$/i.test(root)) return `${root}/messages`;
  return `${root}${PROVIDER_PROTOCOL_REQUEST_PATH[protocol]}`;
}

export function AddChannelDialog(props: {
  providers: readonly CustomProvider[];
  /** 从未配置渠道的"手动填写地址"进入：按预设预填 */
  initialPresetId?: string;
  /** "再加一个实例"：按来源实例预填名称、类型、四个端点地址与方言 */
  sourceProvider?: CustomProvider;
  onCreate: (provider: CustomProvider) => void;
  onClose: () => void;
}) {
  const { providers, initialPresetId, sourceProvider, onCreate, onClose } = props;
  const { t } = useLocale();
  const initialPreset = findProviderPreset(sourceProvider?.presetId ?? initialPresetId);
  const [open, setOpen] = useState(true);
  const [name, setName] = useState(() =>
    sourceProvider
      ? instanceNameForCopy(sourceProvider, providers)
      : initialPreset
        ? instanceNameForPreset(initialPreset, providers)
        : "",
  );
  const [category, setCategory] = useState<Category>(
    sourceProvider?.category ?? initialPreset?.category ?? "relay",
  );
  const [apiKey, setApiKey] = useState("");
  const [presetId, setPresetId] = useState(
    initialPreset && initialPreset.id !== CUSTOM_PRESET_ID ? initialPreset.id : "",
  );
  const [endpoints, setEndpoints] = useState<Partial<Record<ProviderChatProtocol, string>>>(() =>
    sourceProvider
      ? endpointsFromProvider(sourceProvider)
      : initialPreset
        ? endpointsFromPreset(initialPreset)
        : {},
  );
  const [moreOpen, setMoreOpen] = useState(() => {
    const initial = sourceProvider
      ? endpointsFromProvider(sourceProvider)
      : initialPreset
        ? endpointsFromPreset(initialPreset)
        : {};
    return MORE_PROTOCOLS.some((protocol) => initial[protocol]);
  });
  const [error, setError] = useState<string | null>(null);
  const presets = listProviderPresets();
  const preset = findProviderPreset(presetId);
  const initial = (name.trim()[0] ?? "P").toUpperCase();

  function applyPreset(id: string) {
    setPresetId(id);
    setError(null);
    const next = findProviderPreset(id);
    if (!next) return;
    setEndpoints(endpointsFromPreset(next));
    setCategory(next.category);
    if (!name.trim()) setName(instanceNameForPreset(next, providers));
    if (MORE_PROTOCOLS.some((protocol) => next.endpoints[protocol])) setMoreOpen(true);
  }

  function submit() {
    if (!name.trim()) {
      setError(t("settings.channelNameRequired"));
      return;
    }
    // 只有"自建"（本地服务）允许不填 Key；中转 / 官方没有 Key 探测必然鉴权失败。
    if (!apiKey.trim() && category !== "self-hosted") {
      setError(t("settings.channelApiKeyRequired"));
      return;
    }
    const filled = PROVIDER_CHAT_PROTOCOLS.filter((protocol) => endpoints[protocol]?.trim());
    if (filled.length === 0) {
      setError(t("settings.channelEndpointRequired"));
      return;
    }
    onCreate(
      createProviderFromEndpoints({
        name,
        preset,
        category,
        apiKey,
        endpoints,
        template: sourceProvider,
      }),
    );
    setOpen(false);
  }

  function renderEndpointField(protocol: ProviderChatProtocol) {
    const value = endpoints[protocol] ?? "";
    const id = `add-channel-endpoint-${protocol}`;
    return (
      <div key={protocol} className="space-y-1.5">
        <Label htmlFor={id} className="text-xs text-foreground/85">
          {protocolLabel(protocol)}
        </Label>
        <Input
          id={id}
          className="h-8 font-mono text-xs shadow-none"
          value={value}
          placeholder={`Base URL: https://example.com${
            protocol === "google-generative-ai" ? "/v1beta" : "/v1"
          }`}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setError(null);
            setEndpoints((previous) => ({ ...previous, [protocol]: next }));
          }}
        />
        <p className="font-mono text-[10.5px] leading-relaxed text-muted-foreground/75">
          {value.trim() ? (
            <>
              {t("settings.channelRequestPathPreview")}
              <span className="text-muted-foreground">{requestPathPreview(protocol, value)}</span>
            </>
          ) : (
            <span className="font-sans">{t("settings.channelRequestPathHint")}</span>
          )}
        </p>
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[min(720px,calc(100dvh-2rem))] max-w-[560px] flex-col p-0"
        closeLabel={t("settings.close")}
        layout="fullscreen-mobile"
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle className="text-sm">{t("settings.channelAdd")}</DialogTitle>
          <DialogDescription className="text-xs">
            {t("settings.channelAddDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="flex justify-center">
            <span
              aria-hidden="true"
              className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/15 text-2xl font-semibold text-primary"
            >
              {initial}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
            <div className="space-y-1.5">
              <Label htmlFor="add-channel-name" className="text-xs text-muted-foreground">
                {t("settings.channelName")} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="add-channel-name"
                className="h-8 shadow-none"
                value={name}
                placeholder={t("settings.channelNamePlaceholder")}
                onChange={(event) => {
                  setName(event.currentTarget.value);
                  setError(null);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t("settings.channelCategory")}
              </Label>
              <Select value={category} onValueChange={(value) => setCategory(value as Category)}>
                <SelectTrigger className="h-8 w-full text-xs shadow-none">
                  <SelectValue>{t(`settings.providerCategory.${category}`)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(["relay", "official", "self-hosted"] as const).map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`settings.providerCategory.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-channel-key" className="text-xs text-muted-foreground">
              API Key
              {category !== "self-hosted" ? <span className="text-destructive"> *</span> : null}
            </Label>
            <SecretInput
              id="add-channel-key"
              value={apiKey}
              configured={false}
              redacted={false}
              placeholder={t("settings.channelApiKeyPlaceholder")}
              ariaLabel="API Key"
              onCommit={(value) => {
                setApiKey(value);
                setError(null);
              }}
            />
          </div>
          {sourceProvider?.dialect ? (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>{t("settings.providerDialect")}</span>
              <Chip tone="purple">{dialectLabel(t, sourceProvider.dialect)}</Chip>
            </div>
          ) : null}

          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-medium text-foreground/85">
              {t("settings.channelEndpoints")}
              <span className="font-normal text-muted-foreground/75">
                {t("settings.channelEndpointsHint")}
              </span>
            </div>
            {PRIMARY_PROTOCOLS.map(renderEndpointField)}
            <div className="border-t pt-2">
              <button
                type="button"
                className="flex w-full items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((previous) => !previous)}
              >
                {t("settings.channelMoreEndpoints")}
                <ChevronDown
                  className={cn(
                    "ml-auto h-3.5 w-3.5 transition-transform",
                    moreOpen && "rotate-180",
                  )}
                />
              </button>
              {moreOpen ? (
                <div className="mt-3 space-y-3">{MORE_PROTOCOLS.map(renderEndpointField)}</div>
              ) : null}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-foreground/85">
              {t("settings.channelFromPreset")}
            </div>
            <p className="text-[10.5px] leading-relaxed text-muted-foreground/75">
              {t("settings.channelFromPresetHint")}
            </p>
            <Select value={presetId} onValueChange={applyPreset}>
              <SelectTrigger className="h-8 w-full text-xs shadow-none">
                <SelectValue>
                  {preset
                    ? `${preset.name}${preset.native ? `（${t("settings.channelNative")}）` : ""}`
                    : t("settings.channelFromPresetPlaceholder")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {presets.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                    {item.native ? `（${t("settings.channelNative")}）` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="bg-muted/20">
          <DialogActions>
            <Button variant="outline" className="h-8" onClick={() => setOpen(false)}>
              {t("settings.cancel")}
            </Button>
            <Button className="h-8" onClick={submit}>
              {t("settings.channelAddAndProbe")}
            </Button>
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
