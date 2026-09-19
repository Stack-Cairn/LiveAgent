// 抽屉一"请求配置"（设计文档 5.4 / 7）：每个已配置接口一张卡片（启用、探测状态、
// 默认、地址、方言、鉴权头、凭据、quirks、端点请求头）；"添加端点"只列尚未配置的
// 接口；供应商级请求头与"模拟 CLI"。

import {
  type CustomProvider,
  getProviderChatProtocolAdapter,
  PROVIDER_CHAT_PROTOCOLS,
  type ProviderChatProtocol,
  type ProviderWireDialect,
  resolveProviderDialect,
} from "@liveagent/app/lib/settings";
import { RefreshCw, Trash2, X } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { Label } from "@liveagent/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@liveagent/ui/components/ui/sheet";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  CLI_IDENTITY_PROVIDER_IDS,
  detectCliIdentityInHeaders,
  type EndpointIdentity,
  getCustomHeaderKeyPresets,
  recommendedIdentityForEndpoint,
  stripCliIdentityHeaders,
} from "@liveagent/ui/lib/providers/customHeaders";
import {
  CUSTOM_PRESET_ID,
  expandPresetBaseUrl,
  PROVIDER_PROTOCOL_AUTH_HEADER,
  PROVIDER_PROTOCOL_DIALECTS,
  PROVIDER_PROTOCOL_FAMILY,
  PROVIDER_PROTOCOL_MODELS_PATH,
  resolveEndpointRequestBase,
} from "@liveagent/ui/lib/providers/registry";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { customEndpointBaseUrl, probeProvider } from "@liveagent/ui/pages/settings/providerProbe";
import { useEffect, useRef, useState } from "react";
import { DrawerGroupLabel, HintTip } from "../ProviderPresentation";
import { CustomHeadersEditor } from "./CustomHeadersEditor";
import {
  Chip,
  ChipButton,
  CommittedInput,
  dialectLabel,
  ProbeReason,
  ProbeStatusChip,
  probeReason,
  protocolLabel,
  SourceTag,
} from "./providerChips";
import {
  presetForProvider,
  primaryCredential,
  providerConfiguredProtocols,
  providerCredentials,
  providerDefaultProtocol,
  providerEnabledProtocols,
  providerEndpointTemplate,
  providerExistingCandidates,
  providerOrigin,
  providerUsesOrigins,
  readEndpoint,
  readEndpointExpanded,
  recordProbeObservations,
  removeEndpoint,
  setDefaultProtocol,
  setEndpointEnabled,
  writeEndpoint,
} from "./providerSettingsModel";

type BooleanQuirkKey =
  | "supportsUsageInStreaming"
  | "supportsDeveloperRole"
  | "supportsReasoningEffort"
  | "supportsStore";

const QUIRK_KEYS: readonly BooleanQuirkKey[] = [
  "supportsUsageInStreaming",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsStore",
];

const QUIRK_LABELS: Record<BooleanQuirkKey, string> = {
  supportsUsageInStreaming: "stream_options",
  supportsDeveloperRole: "developer role",
  supportsReasoningEffort: "reasoning_effort",
  supportsStore: "store",
};

export function RequestConfigDrawer(props: {
  provider: CustomProvider;
  onChange: (updater: (provider: CustomProvider) => CustomProvider) => void;
  focus?: ProviderChatProtocol;
  onClose: () => void;
}) {
  const { provider, onChange, focus, onClose } = props;
  const { t } = useLocale();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [probing, setProbing] = useState<ReadonlySet<ProviderChatProtocol>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const preset = presetForProvider(provider);
  const isCustom = preset.id === CUSTOM_PRESET_ID;
  const defaultProtocol = providerDefaultProtocol(provider);
  const configured = providerConfiguredProtocols(provider);
  const enabled = providerEnabledProtocols(provider);
  const credentials = providerCredentials(provider);
  const missing = PROVIDER_CHAT_PROTOCOLS.filter(
    (protocol) => !configured.includes(protocol) && (isCustom || preset.endpoints[protocol]),
  );
  const missingCustom = isCustom
    ? []
    : PROVIDER_CHAT_PROTOCOLS.filter(
        (protocol) => !configured.includes(protocol) && !preset.endpoints[protocol],
      );
  const providerLevelIdentity = detectCliIdentityInHeaders(provider.customHeaders);
  const headerPresetKeys = getCustomHeaderKeyPresets(
    getProviderChatProtocolAdapter(
      defaultProtocol,
      resolveProviderDialect(provider, defaultProtocol),
    ),
  );
  const focusRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focus) focusRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focus]);

  async function toggleEndpoint(protocol: ProviderChatProtocol, next: boolean) {
    setNotice(null);
    if (!next && protocol === defaultProtocol) {
      const alternative = enabled.find((item) => item !== protocol);
      if (!alternative) {
        setNotice(t("settings.providerEndpointOnlyEnabled"));
        return;
      }
      const confirmed = await confirm({
        title: t("settings.providerEndpointDisableDefaultTitle"),
        description: t("settings.providerEndpointDisableDefaultDescription").replace(
          "{protocol}",
          protocolLabel(alternative),
        ),
        confirmLabel: t("settings.providerEndpointDisableDefaultConfirm"),
        cancelLabel: t("settings.cancel"),
      });
      if (!confirmed) return;
      onChange((current) =>
        setEndpointEnabled(setDefaultProtocol(current, alternative), protocol, false),
      );
      return;
    }
    onChange((current) => setEndpointEnabled(current, protocol, next));
  }

  /** 单接口重测：源地址模式下按每个启用的源各测一次；观测写回端点与各源。 */
  async function reprobe(protocol: ProviderChatProtocol) {
    const view = readEndpoint(provider, protocol);
    if (!view?.config.baseUrl) return;
    const candidates = providerExistingCandidates(provider, { includeDisabled: true, protocol });
    if (candidates.length === 0) return;
    const credential =
      credentials.find((item) => item.id === view.config.credentialId && item.enabled) ??
      credentials.find((item) => item.enabled) ??
      primaryCredential(provider);
    setProbing((previous) => new Set(previous).add(protocol));
    try {
      const result = await probeProvider({
        candidates,
        credentials: [{ ...credential, enabled: true }],
        useSystemProxy: provider.useSystemProxy,
        customHeaders: provider.customHeaders,
        providerId: provider.id,
      });
      onChange((current) => recordProbeObservations(current, candidates, result));
    } finally {
      setProbing((previous) => {
        const next = new Set(previous);
        next.delete(protocol);
        return next;
      });
    }
  }

  /** 停用的端点也能"设为默认"：先启用再切换，并提示发生了什么，而不是静默无效。 */
  function makeDefault(protocol: ProviderChatProtocol, isEnabled: boolean) {
    setNotice(null);
    onChange((current) =>
      setDefaultProtocol(
        isEnabled ? current : setEndpointEnabled(current, protocol, true),
        protocol,
      ),
    );
    if (!isEnabled) {
      setNotice(
        t("settings.providerEndpointEnabledAndDefault").replace(
          "{protocol}",
          protocolLabel(protocol),
        ),
      );
    }
  }

  async function removeEndpointConfirmed(protocol: ProviderChatProtocol) {
    const confirmed = await confirm({
      title: t("settings.providerEndpointRemove"),
      description: t("settings.providerEndpointRemoveConfirm").replace(
        "{protocol}",
        protocolLabel(protocol),
      ),
      confirmLabel: t("settings.providerEndpointRemove"),
      cancelLabel: t("settings.cancel"),
      preferCancel: true,
    });
    if (!confirmed) return;
    onChange((current) => removeEndpoint(current, protocol));
  }

  function addEndpoint(protocol: ProviderChatProtocol) {
    const template = preset.endpoints[protocol];
    const origin = providerOrigin(provider);
    const defaultBaseUrl = readEndpoint(provider, defaultProtocol)?.config.baseUrl ?? "";
    // 源地址模式：新端点直接落 `{origin}` 模板，随源地址列表一起切换。
    const baseUrl = providerUsesOrigins(provider)
      ? providerEndpointTemplate(provider, protocol)
      : template
        ? expandPresetBaseUrl(template.baseUrl, origin)
        : customEndpointBaseUrl(protocol, defaultBaseUrl || origin);
    if (!baseUrl) {
      setNotice(t("settings.providerEndpointAddNeedsAddress"));
      return;
    }
    onChange((current) =>
      writeEndpoint(current, protocol, () => ({
        baseUrl,
        ...(template?.modelsUrl ? { modelsUrl: template.modelsUrl } : {}),
        ...(template?.dialect ? { dialect: template.dialect } : {}),
        ...(template?.quirks ? { quirks: template.quirks } : {}),
        ...(template?.auth ? { auth: template.auth } : {}),
        source: template ? "auto" : "user",
      })),
    );
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        variant="inset"
        className="settings-provider-drawer max-w-none border-border bg-background sm:max-w-[600px]"
        closeLabel={t("settings.close")}
        showCloseButton={false}
      >
        <div className="settings-provider-drawer-header relative flex items-center gap-3 px-6 pb-4 pt-[22px]">
          <SheetTitle className="min-w-0 flex-1 truncate text-[17px] leading-tight tracking-tight text-foreground/95">
            {t("settings.providerDialogRequest")} · {provider.name}
          </SheetTitle>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground/80 transition-colors hover:bg-foreground/[0.12] hover:text-foreground"
            title={t("settings.close")}
            aria-label={t("settings.close")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div
          aria-hidden="true"
          className="relative mx-6 h-px bg-gradient-to-r from-transparent via-foreground/[0.08] to-transparent"
        />
        <div className="settings-provider-drawer-body relative min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4">
          <div className="space-y-5">
            <div className="space-y-2">
              <DrawerGroupLabel
                label={t("settings.providerDocUrl")}
                hint={t("settings.providerDocUrlHint")}
              />
              <CommittedInput
                value={provider.docUrl ?? ""}
                className="h-8 font-mono text-xs shadow-none"
                placeholder={preset.doc ?? "https://"}
                aria-label={t("settings.providerDocUrl")}
                autoComplete="off"
                spellCheck={false}
                onCommit={(value) =>
                  onChange((current) => {
                    const { docUrl: _previous, ...rest } = current;
                    const docUrl = value.trim();
                    return docUrl ? { ...rest, docUrl } : rest;
                  })
                }
              />
            </div>
            <div className="space-y-2">
              <DrawerGroupLabel
                label={t("settings.providerEndpointsTitle")}
                hint={t("settings.providerEndpointsHint")}
              />
              {notice ? (
                <p className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                  {notice}
                </p>
              ) : null}
              {configured.map((protocol) => {
                const view = readEndpoint(provider, protocol);
                if (!view) return null;
                const config = view.config;
                // 预览与方言推导按主源展开后的地址；输入框保留模板。
                const expandedBaseUrl =
                  readEndpointExpanded(provider, protocol)?.config.baseUrl ?? config.baseUrl;
                const isDefault = protocol === defaultProtocol;
                const isEnabled = config.enabled !== false;
                const inheritedDialect = resolveProviderDialect(provider, protocol, {
                  endpoint: { baseUrl: expandedBaseUrl },
                });
                const authDefault = PROVIDER_PROTOCOL_AUTH_HEADER[protocol];
                const showQuirks = PROVIDER_PROTOCOL_FAMILY[protocol] === "openai";
                const fullUrl = resolveEndpointRequestBase(
                  protocol,
                  expandedBaseUrl,
                  config.isFullUrl === true,
                ).requestUrl;
                return (
                  <div
                    key={protocol}
                    ref={focus === protocol ? focusRef : undefined}
                    className={cn(
                      "rounded-xl border bg-card",
                      !isEnabled && "opacity-80",
                      focus === protocol && "border-primary/40",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                      <Switch
                        size="sm"
                        checked={isEnabled}
                        onCheckedChange={(next) => void toggleEndpoint(protocol, next === true)}
                        aria-label={`${protocolLabel(protocol)} ${t("settings.enable")}`}
                      />
                      <span className="text-[12.5px] font-medium">{protocolLabel(protocol)}</span>
                      <ProbeStatusChip probe={config.lastProbe} pending={probing.has(protocol)} />
                      {isDefault ? (
                        <Chip tone="on">{t("settings.providerEndpointDefault")}</Chip>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          title={
                            isEnabled ? undefined : t("settings.providerEndpointSetDefaultDisabled")
                          }
                          onClick={() => makeDefault(protocol, isEnabled)}
                        >
                          {t("settings.providerEndpointSetDefault")}
                        </Button>
                      )}
                      <span className="flex-1" />
                      {config.source ? <SourceTag source={config.source} /> : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        disabled={probing.has(protocol)}
                        onClick={() => void reprobe(protocol)}
                        title={t("settings.providerEndpointRetest")}
                        aria-label={t("settings.providerEndpointRetest")}
                      >
                        <RefreshCw
                          className={cn("h-3.5 w-3.5", probing.has(protocol) && "animate-spin")}
                        />
                      </Button>
                      {!isDefault ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => void removeEndpointConfirmed(protocol)}
                          title={t("settings.providerEndpointRemove")}
                          aria-label={`${t("settings.providerEndpointRemove")} ${protocolLabel(protocol)}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                    </div>
                    {probeReason(config.lastProbe) ? (
                      <div className="px-3 pb-2">
                        <ProbeReason probe={config.lastProbe} />
                      </div>
                    ) : null}
                    {isEnabled ? (
                      <div className="space-y-3 border-t px-3 py-3">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            <Label className="text-xs text-muted-foreground">
                              {t("settings.baseUrl")}
                            </Label>
                            {preset.endpoints[protocol]?.note ? (
                              <span className="text-[10.5px] text-muted-foreground/70">
                                {preset.endpoints[protocol]?.note}
                              </span>
                            ) : null}
                          </div>
                          <CommittedInput
                            value={config.baseUrl}
                            className="h-8 font-mono text-xs shadow-none"
                            aria-label={`${protocolLabel(protocol)} ${t("settings.baseUrl")}`}
                            autoComplete="off"
                            spellCheck={false}
                            onCommit={(value) =>
                              onChange((current) =>
                                writeEndpoint(current, protocol, { baseUrl: value }),
                              )
                            }
                          />
                          <p className="truncate font-mono text-[10.5px] text-muted-foreground/70">
                            {t("settings.channelRequestPathPreview")}
                            {fullUrl || t("settings.providerOriginUnresolved")}
                          </p>
                          {!config.isFullUrl ? (
                            <p className="text-[10.5px] leading-relaxed text-muted-foreground/60">
                              {t("settings.providerBaseUrlVersionHint")}
                            </p>
                          ) : null}
                        </div>
                        <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                          <div className="flex h-8 items-center justify-between gap-2 rounded-lg border px-3">
                            <span className="text-xs text-muted-foreground">
                              {t("settings.providerFullUrl")}
                            </span>
                            <Switch
                              size="sm"
                              checked={config.isFullUrl === true}
                              onCheckedChange={(next) =>
                                onChange((current) =>
                                  writeEndpoint(current, protocol, { isFullUrl: next === true }),
                                )
                              }
                              aria-label={t("settings.providerFullUrl")}
                            />
                          </div>
                          <CommittedInput
                            value={config.modelsUrl ?? ""}
                            className="h-8 font-mono text-xs shadow-none"
                            placeholder={`${t("settings.providerModelsUrlAuto")} …${PROVIDER_PROTOCOL_MODELS_PATH[protocol]}`}
                            aria-label={t("settings.providerModelsUrl")}
                            autoComplete="off"
                            spellCheck={false}
                            onCommit={(value) =>
                              onChange((current) =>
                                writeEndpoint(current, protocol, {
                                  modelsUrl: value.trim() || undefined,
                                }),
                              )
                            }
                          />
                        </div>
                        <div className="grid grid-cols-4 gap-3 max-[1100px]:grid-cols-2 max-[720px]:grid-cols-1">
                          <div className="space-y-1">
                            <Label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                              {t("settings.providerDialect")}
                              <HintTip
                                text={t("settings.providerDialectHint")}
                                label={t("settings.providerDialect")}
                              />
                            </Label>
                            <Select
                              value={config.dialect ?? "inherit"}
                              onValueChange={(value) =>
                                onChange((current) =>
                                  writeEndpoint(current, protocol, {
                                    dialect:
                                      value === "inherit"
                                        ? undefined
                                        : (value as ProviderWireDialect),
                                  }),
                                )
                              }
                            >
                              <SelectTrigger className="h-8 text-xs shadow-none">
                                <SelectValue>
                                  {config.dialect
                                    ? dialectLabel(t, config.dialect)
                                    : t("settings.providerDialectInherit").replace(
                                        "{dialect}",
                                        dialectLabel(t, inheritedDialect),
                                      )}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="inherit">
                                  {t("settings.providerDialectInherit").replace(
                                    "{dialect}",
                                    dialectLabel(t, inheritedDialect),
                                  )}
                                </SelectItem>
                                {PROVIDER_PROTOCOL_DIALECTS[protocol].map((dialect) => (
                                  <SelectItem key={dialect} value={dialect}>
                                    {dialectLabel(t, dialect)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label
                              className="text-[11px] text-muted-foreground"
                              title={t("settings.providerEndpointIdentityHint")}
                            >
                              {t("settings.providerEndpointIdentity")}
                            </Label>
                            {(() => {
                              const recommended = recommendedIdentityForEndpoint(
                                protocol,
                                config.dialect ?? inheritedDialect,
                              );
                              const label = (value: EndpointIdentity | "inherit") =>
                                value === "inherit"
                                  ? t("settings.providerEndpointIdentityInherit")
                                  : value === "none"
                                    ? t("settings.providerEndpointIdentityNone")
                                    : t(`settings.cliIdentity.${value}`);
                              return (
                                <Select
                                  value={config.identity ?? "inherit"}
                                  onValueChange={(value) =>
                                    onChange((current) =>
                                      writeEndpoint(current, protocol, {
                                        identity:
                                          value === "inherit"
                                            ? undefined
                                            : (value as EndpointIdentity),
                                      }),
                                    )
                                  }
                                >
                                  <SelectTrigger
                                    className="h-8 text-xs shadow-none"
                                    title={t("settings.providerEndpointIdentityHint")}
                                  >
                                    <SelectValue>
                                      <span className="truncate">
                                        {label(config.identity ?? "inherit")}
                                      </span>
                                    </SelectValue>
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="inherit">{label("inherit")}</SelectItem>
                                    {CLI_IDENTITY_PROVIDER_IDS.map((item) => (
                                      <SelectItem key={item} value={item}>
                                        {label(item)}
                                        {item === recommended
                                          ? ` · ${t("settings.providerEndpointIdentityRecommended")}`
                                          : ""}
                                      </SelectItem>
                                    ))}
                                    <SelectItem value="none">{label("none")}</SelectItem>
                                  </SelectContent>
                                </Select>
                              );
                            })()}
                          </div>
                          <div className="space-y-1">
                            <Label className="text-[11px] text-muted-foreground">
                              {t("settings.providerAuthHeader")}
                            </Label>
                            <CommittedInput
                              value={config.auth?.headerName ?? ""}
                              className="h-8 font-mono text-xs shadow-none"
                              placeholder={authDefault.headerName}
                              aria-label={t("settings.providerAuthHeader")}
                              autoComplete="off"
                              spellCheck={false}
                              onCommit={(value) =>
                                onChange((current) =>
                                  writeEndpoint(current, protocol, {
                                    auth: value.trim()
                                      ? { ...config.auth, headerName: value.trim() }
                                      : config.auth?.prefix !== undefined
                                        ? { prefix: config.auth.prefix }
                                        : undefined,
                                  }),
                                )
                              }
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-[11px] text-muted-foreground">
                              {t("settings.providerEndpointCredential")}
                            </Label>
                            <Select
                              value={config.credentialId ?? "default"}
                              onValueChange={(value) =>
                                onChange((current) =>
                                  writeEndpoint(current, protocol, {
                                    credentialId: value === "default" ? undefined : value,
                                  }),
                                )
                              }
                            >
                              <SelectTrigger className="h-8 text-xs shadow-none">
                                <SelectValue>
                                  {config.credentialId
                                    ? credentialLabel(
                                        credentials.find((item) => item.id === config.credentialId),
                                        t,
                                      )
                                    : t("settings.providerCredentialAuto")}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="default">
                                  {t("settings.providerCredentialAuto")}
                                </SelectItem>
                                {credentials.map((credential, index) => (
                                  <SelectItem key={credential.id} value={credential.id}>
                                    {credential.label || credentialFallbackLabel(index, t)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        {showQuirks ? (
                          <div className="space-y-1">
                            <Label className="text-[11px] text-muted-foreground">
                              {t("settings.providerQuirks")}
                            </Label>
                            <div className="flex flex-wrap gap-1.5">
                              {QUIRK_KEYS.map((key) => {
                                const value = config.quirks?.[key];
                                return (
                                  <ChipButton
                                    key={key}
                                    tone={value === true ? "on" : "default"}
                                    className={cn(value === false && "opacity-70")}
                                    onClick={() =>
                                      onChange((current) =>
                                        writeEndpoint(current, protocol, {
                                          quirks: {
                                            ...config.quirks,
                                            [key]:
                                              value === undefined
                                                ? true
                                                : value === true
                                                  ? false
                                                  : undefined,
                                          },
                                        }),
                                      )
                                    }
                                    title={t("settings.providerQuirkCycleHint")}
                                  >
                                    {QUIRK_LABELS[key]}：
                                    {value === false
                                      ? t("settings.providerQuirkOff")
                                      : value === true
                                        ? t("settings.providerQuirkOn")
                                        : t("settings.providerQuirkAuto")}
                                  </ChipButton>
                                );
                              })}
                            </div>
                          </div>
                        ) : null}
                        <CustomHeadersEditor
                          compact
                          title={t("settings.providerEndpointHeaders")}
                          idPrefix={`endpoint-${protocol}-headers`}
                          headers={config.headers ?? []}
                          presetKeys={headerPresetKeys}
                          onChange={(headers) =>
                            onChange((current) =>
                              writeEndpoint(current, protocol, {
                                headers: headers.length > 0 ? headers : undefined,
                              }),
                            )
                          }
                        />
                      </div>
                    ) : (
                      <p className="border-t px-3 py-2 text-[11px] text-muted-foreground/75">
                        {t("settings.providerEndpointDisabledHint")}
                      </p>
                    )}
                  </div>
                );
              })}
              {missing.length > 0 || missingCustom.length > 0 ? (
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">
                    {t("settings.providerEndpointAdd")}
                  </Label>
                  <div className="flex flex-wrap gap-1.5">
                    {missing.map((protocol) => (
                      <ChipButton key={protocol} onClick={() => addEndpoint(protocol)}>
                        ＋ {protocolLabel(protocol)}
                        {preset.endpoints[protocol]
                          ? `（${t("settings.providerEndpointPresetAddress")}）`
                          : ""}
                      </ChipButton>
                    ))}
                    {missingCustom.map((protocol) => (
                      <ChipButton key={protocol} onClick={() => addEndpoint(protocol)}>
                        ＋ {protocolLabel(protocol)}
                      </ChipButton>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="space-y-2">
              <DrawerGroupLabel
                label={t("settings.customHeaders")}
                hint={t("settings.providerHeadersMergeHint")}
              />
              <CustomHeadersEditor
                title={t("settings.providerHeadersTitle")}
                idPrefix="provider-headers"
                headers={provider.customHeaders ?? []}
                presetKeys={headerPresetKeys}
                onChange={(headers) =>
                  onChange((current) => ({ ...current, customHeaders: headers }))
                }
              />
              {providerLevelIdentity ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                  <span className="min-w-0 flex-1">
                    {t("settings.providerHeadersIdentityNotice").replace(
                      "{cli}",
                      t(`settings.cliIdentity.${providerLevelIdentity}`),
                    )}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 text-[11px]"
                    onClick={() =>
                      onChange((current) => ({
                        ...current,
                        customHeaders: stripCliIdentityHeaders(current.customHeaders ?? []),
                      }))
                    }
                  >
                    {t("settings.providerHeadersIdentityStrip")}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        {confirmDialog}
      </SheetContent>
    </Sheet>
  );
}

function credentialFallbackLabel(index: number, t: (key: string) => string): string {
  return index === 0
    ? t("settings.providerCredentialPrimary")
    : `${t("settings.providerCredentialBackup")} ${index}`;
}

function credentialLabel(
  credential: { label: string } | undefined,
  t: (key: string) => string,
): string {
  if (!credential) return t("settings.providerCredentialAuto");
  return credential.label || t("settings.providerCredentialPrimary");
}
