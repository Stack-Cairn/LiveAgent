// "添加渠道"对话框（设计文档 7）：自定义中转、聚合网关或尚未内置的厂商。
// 统一两列栅格（左标签 / 右输入），分五节：基本信息、API Key（多把）、源地址（主源 +
// 可选备用）、接口地址（四类接口平铺；填了主源后默认按 `{origin}` 模板预填，可改成
// 绝对地址，预览按主源展开）、从预设创建（折叠，可选）。校验文案固定在底部按钮左侧。

import {
  type CustomProvider,
  endpointUsesOrigin,
  PROVIDER_CHAT_PROTOCOLS,
  type ProviderChatProtocol,
} from "@liveagent/app/lib/settings";
import { ChevronDown, Plus, Trash2 } from "@liveagent/ui/components/IconSet";
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
  type ProviderPreset,
  resolveEndpointRequestBase,
} from "@liveagent/ui/lib/providers/registry";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { originEndpointTemplate } from "@liveagent/ui/pages/settings/providerProbe";
import { type ReactNode, useState } from "react";
import { ProviderAvatar, protocolLabel, SecretInput } from "./providerChips";
import { createProviderFromEndpoints, instanceNameForPreset } from "./providerSettingsModel";

/** 界面顺序：先 OpenAI 两类，再 Anthropic，最后 Gemini。 */
const ENDPOINT_ORDER: ProviderChatProtocol[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

/** 占位符按接口给"正常样式"的根地址，不带 /v1（版本段由 resolveEndpointRequestBase 补）。 */
const ENDPOINT_PLACEHOLDER: Record<ProviderChatProtocol, string> = {
  "openai-completions": "https://api.example.com",
  "openai-responses": "https://api.example.com",
  "anthropic-messages": "https://api.example.com",
  "google-generative-ai": "https://generativelanguage.googleapis.com",
};

type ApiKeyRow = { id: string; key: string; label: string };

function emptyKeyRow(): ApiKeyRow {
  return { id: createUuid(), key: "", label: "" };
}

/**
 * 预设的接口地址：`{origin}` 模板原样保留（随源地址列表切换），绝对地址照旧；
 * 预设声明了默认源时一并作为主源预填。
 */
function endpointsFromPreset(preset: ProviderPreset): {
  endpoints: Partial<Record<ProviderChatProtocol, string>>;
  origin: string;
} {
  const endpoints: Partial<Record<ProviderChatProtocol, string>> = {};
  let templated = false;
  for (const protocol of PROVIDER_CHAT_PROTOCOLS) {
    const endpoint = preset.endpoints[protocol];
    if (!endpoint) continue;
    endpoints[protocol] = endpoint.baseUrl;
    templated ||= endpointUsesOrigin(endpoint.baseUrl);
  }
  return { endpoints, origin: templated ? (preset.defaultOrigin ?? "") : "" };
}

/** 填了主源后，空着的接口地址按 `{origin}` 模板预填；用户填过的（含绝对地址）不动。 */
function prefillTemplates(
  endpoints: Partial<Record<ProviderChatProtocol, string>>,
  preset: ProviderPreset | undefined,
): Partial<Record<ProviderChatProtocol, string>> {
  const next = { ...endpoints };
  const protocols = preset
    ? PROVIDER_CHAT_PROTOCOLS.filter((protocol) => preset.endpoints[protocol])
    : PROVIDER_CHAT_PROTOCOLS;
  for (const protocol of protocols) {
    if (next[protocol]?.trim()) continue;
    const presetTemplate = preset?.endpoints[protocol]?.baseUrl;
    next[protocol] =
      presetTemplate && endpointUsesOrigin(presetTemplate)
        ? presetTemplate
        : originEndpointTemplate(protocol);
  }
  return next;
}

type OriginRow = { id: string; url: string };

function emptyOriginRow(url = ""): OriginRow {
  return { id: createUuid(), url };
}

/** 分节：标题行 + 两列栅格（左标签 132px，右输入自适应；窄屏退化为单列）。 */
function Section(props: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs font-medium text-foreground/85">
        {props.title}
        {props.hint ? (
          <span className="font-normal text-muted-foreground/75">{props.hint}</span>
        ) : null}
      </div>
      <div className="grid grid-cols-[132px_minmax(0,1fr)] items-start gap-x-4 gap-y-3 max-[520px]:grid-cols-1 max-[520px]:gap-y-1.5">
        {props.children}
      </div>
    </section>
  );
}

/** 左列标签：与输入框首行对齐（h-8 输入框 → 标签行高 2rem）；可带一行小字说明。 */
function FieldLabel(props: {
  htmlFor?: string;
  children: ReactNode;
  hint?: ReactNode;
  required?: boolean;
}) {
  return (
    <div className="min-w-0 max-[520px]:flex max-[520px]:items-baseline max-[520px]:gap-2">
      <Label
        htmlFor={props.htmlFor}
        className="flex h-8 items-center text-xs leading-none text-foreground/85"
      >
        <span className="truncate">{props.children}</span>
        {props.required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>
      {props.hint ? (
        <p className="-mt-1 truncate text-[10.5px] leading-4 text-muted-foreground/70 max-[520px]:mt-0">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
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
  const [keys, setKeys] = useState<ApiKeyRow[]>(() => [emptyKeyRow()]);
  const [presetId, setPresetId] = useState(
    initialPreset && initialPreset.id !== CUSTOM_PRESET_ID ? initialPreset.id : "",
  );
  const [presetOpen, setPresetOpen] = useState(() => Boolean(initialPreset));
  const [endpoints, setEndpoints] = useState<Partial<Record<ProviderChatProtocol, string>>>(() =>
    initialPreset ? endpointsFromPreset(initialPreset).endpoints : {},
  );
  // 源地址：首行主源，其余备用；空行提交时丢弃。
  const [origins, setOrigins] = useState<OriginRow[]>(() => [
    emptyOriginRow(initialPreset ? endpointsFromPreset(initialPreset).origin : ""),
  ]);
  const [error, setError] = useState<string | null>(null);
  const presets = listProviderPresets();
  const preset = findProviderPreset(presetId);
  const primaryOrigin = origins[0]?.url ?? "";

  function applyPreset(id: string) {
    setPresetId(id);
    setError(null);
    const next = findProviderPreset(id);
    if (!next) return;
    const fromPreset = endpointsFromPreset(next);
    setEndpoints(fromPreset.endpoints);
    if (fromPreset.origin && !primaryOrigin) {
      setOrigins((previous) => [{ ...previous[0], url: fromPreset.origin }, ...previous.slice(1)]);
    }
    if (!name.trim()) setName(instanceNameForPreset(next, providers));
  }

  function patchOrigin(id: string, url: string) {
    setError(null);
    setOrigins((previous) => previous.map((row) => (row.id === id ? { ...row, url } : row)));
    // 主源从空变为有值：空着的接口地址按模板预填。
    if (id === origins[0]?.id && !primaryOrigin.trim() && url.trim()) {
      setEndpoints((previous) => prefillTemplates(previous, preset));
    }
  }

  function removeOrigin(id: string) {
    setOrigins((previous) => previous.filter((row) => row.id !== id));
  }

  function patchKey(id: string, patch: Partial<Omit<ApiKeyRow, "id">>) {
    setError(null);
    setKeys((previous) => previous.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeKey(id: string) {
    setKeys((previous) => {
      const next = previous.filter((row) => row.id !== id);
      return next.length > 0 ? next : [emptyKeyRow()];
    });
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
    const originUrls = origins.map((row) => row.url.trim()).filter(Boolean);
    if (
      originUrls.length === 0 &&
      filled.some((protocol) => endpointUsesOrigin(endpoints[protocol]))
    ) {
      setError(t("settings.channelOriginRequired"));
      return;
    }
    onCreate(
      createProviderFromEndpoints({
        name,
        preset,
        apiKeys: keys.map((row) => ({ key: row.key, label: row.label })),
        endpoints,
        origins: originUrls,
      }),
    );
    setOpen(false);
  }

  const filledFromPreset = preset
    ? ENDPOINT_ORDER.filter((protocol) => preset.endpoints[protocol] && endpoints[protocol]?.trim())
    : [];

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
        className="flex max-h-[min(760px,calc(100dvh-2rem))] max-w-[600px] flex-col p-0"
        closeLabel={t("settings.close")}
        layout="fullscreen-mobile"
        showCloseButton
      >
        <DialogHeader className="flex-row items-center gap-3">
          <ProviderAvatar preset={preset} className="h-10 w-10 rounded-xl" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <DialogTitle className="text-sm">{t("settings.channelAdd")}</DialogTitle>
            <DialogDescription className="text-xs">
              {t("settings.channelAddDescription")}
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-6 py-4">
          <Section title={t("settings.channelSectionBasic")}>
            <FieldLabel htmlFor="add-channel-name" required>
              {t("settings.channelName")}
            </FieldLabel>
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
          </Section>

          <Section title="API Key" hint={t("settings.channelKeysHint")}>
            {keys.map((row, index) => {
              const inputId = `add-channel-key-${row.id}`;
              const rowLabel = `Key ${index + 1}`;
              return (
                <div key={row.id} className="contents">
                  <FieldLabel
                    htmlFor={inputId}
                    hint={index === 0 ? t("settings.channelKeyPrimaryHint") : undefined}
                  >
                    {rowLabel}
                  </FieldLabel>
                  <div className="flex min-w-0 items-center gap-2">
                    <SecretInput
                      id={inputId}
                      value={row.key}
                      configured={false}
                      redacted={false}
                      placeholder={t("settings.channelApiKeyPlaceholder")}
                      ariaLabel={`API ${rowLabel}`}
                      onCommit={(value) => patchKey(row.id, { key: value })}
                    />
                    <Input
                      className="h-8 w-28 shrink-0 text-xs shadow-none max-[520px]:w-24"
                      value={row.label}
                      placeholder={t("settings.channelKeyLabelPlaceholder")}
                      aria-label={`${rowLabel} ${t("settings.providerCredentialLabel")}`}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => patchKey(row.id, { label: event.currentTarget.value })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                      disabled={keys.length === 1 && !row.key && !row.label}
                      title={t("settings.channelKeyRemove")}
                      aria-label={`${t("settings.channelKeyRemove")} ${rowLabel}`}
                      onClick={() => removeKey(row.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
            <div className="min-[521px]:col-start-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setKeys((previous) => [...previous, emptyKeyRow()])}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t("settings.channelKeyAdd")}
              </Button>
            </div>
          </Section>

          <Section title={t("settings.channelOrigins")} hint={t("settings.channelOriginsHint")}>
            {origins.map((row, index) => {
              const inputId = `add-channel-origin-${row.id}`;
              const rowLabel =
                index === 0
                  ? t("settings.channelOriginPrimary")
                  : t("settings.channelOriginBackup").replace("{n}", String(index));
              return (
                <div key={row.id} className="contents">
                  <FieldLabel htmlFor={inputId}>{rowLabel}</FieldLabel>
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      id={inputId}
                      className="h-8 font-mono text-xs shadow-none"
                      value={row.url}
                      placeholder={t("settings.providerOriginPlaceholder")}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => patchOrigin(row.id, event.currentTarget.value)}
                    />
                    {index > 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                        title={t("settings.channelOriginRemove")}
                        aria-label={`${t("settings.channelOriginRemove")} ${rowLabel}`}
                        onClick={() => removeOrigin(row.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            <div className="min-[521px]:col-start-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                disabled={!primaryOrigin.trim()}
                onClick={() => setOrigins((previous) => [...previous, emptyOriginRow()])}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t("settings.channelOriginAdd")}
              </Button>
            </div>
          </Section>

          <Section title={t("settings.channelEndpoints")} hint={t("settings.channelEndpointsHint")}>
            {ENDPOINT_ORDER.map((protocol) => {
              const value = endpoints[protocol] ?? "";
              const id = `add-channel-endpoint-${protocol}`;
              // 模板按主源展开后再算请求地址；没填主源时模板展开为空 → 显示提示。
              const resolved = resolveEndpointRequestBase(
                protocol,
                expandPresetBaseUrl(value, primaryOrigin),
              );
              return (
                <div key={protocol} className="contents">
                  <FieldLabel htmlFor={id} hint={t(`settings.channelEndpointDesc.${protocol}`)}>
                    {protocolLabel(protocol)}
                  </FieldLabel>
                  <div className="min-w-0 space-y-1">
                    <Input
                      id={id}
                      className="h-8 font-mono text-xs shadow-none"
                      value={value}
                      placeholder={
                        primaryOrigin.trim()
                          ? originEndpointTemplate(protocol)
                          : ENDPOINT_PLACEHOLDER[protocol]
                      }
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        setError(null);
                        setEndpoints((previous) => ({ ...previous, [protocol]: next }));
                      }}
                    />
                    <p className="truncate font-mono text-[10.5px] leading-4 text-muted-foreground/70">
                      {resolved.requestUrl ? (
                        <>
                          <span className="font-sans">
                            {t("settings.channelRequestPathPreview")}
                          </span>
                          <span className="text-muted-foreground">{resolved.requestUrl}</span>
                        </>
                      ) : (
                        <span className="font-sans">{t("settings.channelRequestPathHint")}</span>
                      )}
                    </p>
                  </div>
                </div>
              );
            })}
          </Section>

          <section className="rounded-xl border bg-muted/20">
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs font-medium text-foreground/85 transition-colors hover:text-foreground"
              aria-expanded={presetOpen}
              aria-controls="add-channel-preset"
              onClick={() => setPresetOpen((previous) => !previous)}
            >
              <span className="min-w-0 flex-1 truncate">
                {t("settings.channelFromPreset")}
                {preset ? (
                  <span className="ml-2 font-normal text-muted-foreground">{preset.name}</span>
                ) : null}
              </span>
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                  presetOpen && "rotate-180",
                )}
              />
            </button>
            {presetOpen ? (
              <div id="add-channel-preset" className="space-y-2.5 border-t px-3 py-3">
                <p className="text-[10.5px] leading-relaxed text-muted-foreground/75">
                  {t("settings.channelFromPresetHint")}
                </p>
                <Select value={presetId} onValueChange={applyPreset}>
                  <SelectTrigger className="h-8 w-full bg-background text-xs shadow-none">
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
                {preset ? (
                  <div className="space-y-1 text-[10.5px] leading-4 text-muted-foreground/75">
                    <p>{t("settings.channelPresetApplied")}</p>
                    {filledFromPreset.length > 0 ? (
                      <ul className="space-y-0.5">
                        {filledFromPreset.map((protocol) => (
                          <li key={protocol} className="flex min-w-0 gap-2">
                            <span className="w-[132px] shrink-0 truncate max-[520px]:w-auto">
                              {protocolLabel(protocol)}
                            </span>
                            <span className="truncate font-mono text-muted-foreground">
                              {endpoints[protocol]}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>{t("settings.channelPresetAppliedNone")}</p>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        </DialogBody>
        <DialogFooter className="bg-muted/20">
          {error ? (
            <p className="min-w-0 flex-1 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
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
