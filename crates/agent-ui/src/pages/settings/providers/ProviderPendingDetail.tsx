// 未配置渠道的详情：注册表声明的接口与地址、鉴权方式、取 Key 链接，以及
// Key（和地址）输入与"检测并启用"（设计文档 7 中栏第 1 条）。

import { PROVIDER_CHAT_PROTOCOLS } from "@liveagent/app/lib/settings";
import { ArrowLeft, ExternalLink } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  expandPresetBaseUrl,
  PROVIDER_PROTOCOL_AUTH_HEADER,
  type ProviderPreset,
  presetUsesCatalogModels,
} from "@liveagent/ui/lib/providers/registry";
import { useState } from "react";
import { Chip, ProviderAvatar, protocolLabel, SecretInput, SectionTitle } from "./providerChips";

export function ProviderPendingDetail(props: {
  preset: ProviderPreset;
  onSetup: (input: { origin: string; apiKey: string }) => void;
  onAddManually: () => void;
  onBack: () => void;
}) {
  const { preset, onSetup, onAddManually, onBack } = props;
  const { t } = useLocale();
  const [origin, setOrigin] = useState(preset.defaultOrigin ?? "");
  const [apiKey, setApiKey] = useState("");
  const declared = PROVIDER_CHAT_PROTOCOLS.filter((protocol) => preset.endpoints[protocol]);
  const needsAddress = preset.input !== "key";
  const canSetup =
    (!needsAddress || origin.trim().length > 0) &&
    (preset.authOptional || apiKey.trim().length > 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="settings-provider-back hidden h-8 w-8 max-[720px]:inline-flex"
          onClick={onBack}
          title={t("settings.channelBackToList")}
          aria-label={t("settings.channelBackToList")}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <ProviderAvatar preset={preset} className="h-10 w-10" />
        <h2 className="text-base font-semibold tracking-tight">{preset.name}</h2>
        {preset.native ? <Chip>{t("settings.channelNative")}</Chip> : null}
        <span className="flex-1" />
        <Chip>{t("settings.channelPending")}</Chip>
      </div>

      <section className="space-y-2">
        <SectionTitle title={t("settings.channelDeclaredEndpoints")} />
        {declared.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("settings.channelProbeAllHint")}</p>
        ) : (
          <div className="space-y-1.5">
            {declared.map((protocol) => {
              const endpoint = preset.endpoints[protocol];
              if (!endpoint) return null;
              const isDefault = protocol === preset.defaultChatProtocol;
              // {origin} 模板按当前输入实时展开；没填地址时给占位说明而不是裸模板。
              const address = expandPresetBaseUrl(endpoint.baseUrl, origin);
              return (
                <div
                  key={protocol}
                  className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs"
                >
                  <Chip tone={isDefault ? "on" : "default"}>
                    {protocolLabel(protocol)}
                    {isDefault ? ` · ${t("settings.providerEndpointDefault")}` : ""}
                  </Chip>
                  {address ? (
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                      {address}
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-[11px] italic text-muted-foreground/70">
                      {t("settings.channelTemplateNeedsOrigin")}
                    </span>
                  )}
                  {endpoint.note ? (
                    <span className="text-[10.5px] text-muted-foreground/70">{endpoint.note}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span>
            {t("settings.channelAuthLabel")}
            {preset.authOptional
              ? t("settings.channelAuthNone")
              : `API Key（${PROVIDER_PROTOCOL_AUTH_HEADER[preset.defaultChatProtocol].headerName}）`}
          </span>
          {preset.dialect ? (
            <span>
              {t("settings.providerDialect")}: {preset.dialect}
            </span>
          ) : null}
          {preset.apiKeyUrl ? (
            <a
              href={preset.apiKeyUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              {t("settings.channelGetApiKey")}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
          {preset.doc ? (
            <a
              href={preset.doc}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              {t("settings.channelDocs")}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
        </p>
      </section>

      <section className="space-y-2">
        <SectionTitle
          title={
            preset.input === "key"
              ? t("settings.channelSetupKeyOnly")
              : preset.authOptional
                ? t("settings.channelSetupAddressOnly")
                : t("settings.channelSetupAddressAndKey")
          }
        />
        <div className="space-y-3 rounded-xl border bg-card p-4">
          {needsAddress ? (
            <div className="space-y-1.5">
              <Label htmlFor="channel-setup-origin" className="text-xs text-muted-foreground">
                {preset.input === "origin"
                  ? t("settings.channelOriginLabel")
                  : t("settings.baseUrl")}
              </Label>
              <Input
                id="channel-setup-origin"
                className="h-8 font-mono text-xs shadow-none"
                value={origin}
                placeholder={
                  preset.input === "origin"
                    ? "https://relay.example.com"
                    : "https://api.example.com/v1"
                }
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setOrigin(event.currentTarget.value)}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="channel-setup-key" className="text-xs text-muted-foreground">
              API Key
              {preset.authOptional ? (
                <span className="ml-1 text-muted-foreground/70">
                  {t("settings.channelAuthOptionalHint")}
                </span>
              ) : null}
            </Label>
            <SecretInput
              id="channel-setup-key"
              value={apiKey}
              configured={false}
              redacted={false}
              ariaLabel="API Key"
              onCommit={setApiKey}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button
              type="button"
              size="sm"
              className="h-8 shadow-none"
              disabled={!canSetup}
              onClick={() => onSetup({ origin: origin.trim(), apiKey: apiKey.trim() })}
            >
              {t("settings.channelProbeAndEnable")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shadow-none"
              onClick={onAddManually}
            >
              {t("settings.channelAddManually")}
            </Button>
            <span className="text-[11px] leading-relaxed text-muted-foreground/75">
              {/* 目录渠道不发请求，提示措辞要和实际行为一致。 */}
              {t(
                presetUsesCatalogModels(preset)
                  ? "settings.channelProbeHintCatalog"
                  : "settings.channelProbeHint",
              )}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
