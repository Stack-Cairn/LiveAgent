// "添加渠道"对话框（设计文档 7）：自定义中转、聚合网关或尚未内置的厂商。
// 渠道头像（预设 logo / 中性图标）、名称、API 密钥、四类接口的 Base URL（两类常显、两类折叠），
// 填根地址后即时显示实际请求路径；"从预设创建（可选）"填入该渠道的接口与地址。

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
import { ProviderAvatar, protocolLabel, SecretInput } from "./providerChips";
import { createProviderFromEndpoints, instanceNameForPreset } from "./providerSettingsModel";

const PRIMARY_PROTOCOLS: ProviderChatProtocol[] = ["openai-completions", "anthropic-messages"];
const MORE_PROTOCOLS: ProviderChatProtocol[] = ["openai-responses", "google-generative-ai"];

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

function requestPathPreview(protocol: ProviderChatProtocol, baseUrl: string): string {
  const root = baseUrl.trim().replace(/\/+$/, "");
  if (protocol === "anthropic-messages" && /\/v1$/i.test(root)) return `${root}/messages`;
  return `${root}${PROVIDER_PROTOCOL_REQUEST_PATH[protocol]}`;
}

export function AddChannelDialog(props: {
  providers: readonly CustomProvider[];
  /** 从未配置渠道的"手动填写地址"进入：按预设预填 */
  initialPresetId?: string;
  onCreate: (provider: CustomProvider) => void;
  onClose: () => void;
}) {
  const { providers, initialPresetId, onCreate, onClose } = props;
  const { t } = useLocale();
  const initialPreset = findProviderPreset(initialPresetId);
  const [open, setOpen] = useState(true);
  const [name, setName] = useState(() =>
    initialPreset ? instanceNameForPreset(initialPreset, providers) : "",
  );
  const [apiKey, setApiKey] = useState("");
  const [presetId, setPresetId] = useState(
    initialPreset && initialPreset.id !== CUSTOM_PRESET_ID ? initialPreset.id : "",
  );
  const [endpoints, setEndpoints] = useState<Partial<Record<ProviderChatProtocol, string>>>(() =>
    initialPreset ? endpointsFromPreset(initialPreset) : {},
  );
  const [moreOpen, setMoreOpen] = useState(() => {
    const initial = initialPreset ? endpointsFromPreset(initialPreset) : {};
    return MORE_PROTOCOLS.some((protocol) => initial[protocol]);
  });
  const [error, setError] = useState<string | null>(null);
  const presets = listProviderPresets();
  const preset = findProviderPreset(presetId);

  function applyPreset(id: string) {
    setPresetId(id);
    setError(null);
    const next = findProviderPreset(id);
    if (!next) return;
    setEndpoints(endpointsFromPreset(next));
    if (!name.trim()) setName(instanceNameForPreset(next, providers));
    if (MORE_PROTOCOLS.some((protocol) => next.endpoints[protocol])) setMoreOpen(true);
  }

  function submit() {
    if (!name.trim()) {
      setError(t("settings.channelNameRequired"));
      return;
    }
    const filled = PROVIDER_CHAT_PROTOCOLS.filter((protocol) => endpoints[protocol]?.trim());
    if (filled.length === 0) {
      setError(t("settings.channelEndpointRequired"));
      return;
    }
    onCreate(createProviderFromEndpoints({ name, preset, apiKey, endpoints }));
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
            <ProviderAvatar preset={preset} className="h-14 w-14" />
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
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-channel-key" className="text-xs text-muted-foreground">
              API Key
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
                  {preset ? (
                    <span className="flex items-center gap-2">
                      <ProviderAvatar preset={preset} className="h-5 w-5" />
                      {preset.name}
                      {preset.native ? `（${t("settings.channelNative")}）` : ""}
                    </span>
                  ) : (
                    t("settings.channelFromPresetPlaceholder")
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {presets.map((item) => (
                  <SelectItem key={item.id} value={item.id} className="text-xs">
                    <span className="flex items-center gap-2">
                      <ProviderAvatar preset={item} className="h-5 w-5" />
                      {item.name}
                      {item.native ? `（${t("settings.channelNative")}）` : ""}
                    </span>
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
