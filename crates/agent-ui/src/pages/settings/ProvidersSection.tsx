// 供应商配置页（设计文档第 7 节）：三栏结构——左栏渠道目录、中栏渠道详情、
// 右侧抽屉（请求配置 / 管理密钥 / 编辑模型）。窄屏退化为列表 → 详情 → 抽屉三级。
// 所有写入经 normalizeCustomProvider（providerSettingsModel.finalizeProvider）。

import { ProviderSettingsExtension } from "@liveagent/adapters/providerSettings";
import {
  getProviderUsageCardDisplay,
  useProviderUsage,
  useUsageNowTicker,
} from "@liveagent/app/lib/providers/usageQuery";
import {
  type CustomProvider,
  type ProviderCredential,
  updateCustomProviders,
} from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { BookOpen, Settings } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  CUSTOM_PRESET_ID,
  findProviderPreset,
  listProviderPresets,
} from "@liveagent/ui/lib/providers/registry";
import { isGatewayWebuiRuntime } from "@liveagent/ui/lib/runtimeEnv";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  buildAutoConfiguration,
  buildEndpointCandidates,
  type EndpointCandidate,
  isProbeStatusUsable,
  type ProviderProbeResult,
  probeProvider,
} from "@liveagent/ui/pages/settings/providerProbe";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddChannelDialog } from "./providers/AddChannelDialog";
import { CredentialsDrawer } from "./providers/CredentialsDrawer";
import { ModelCatalogDrawer } from "./providers/ModelCatalogDrawer";
import { ModelEditDrawer } from "./providers/ModelEditDrawer";
import { ProviderCatalogList } from "./providers/ProviderCatalogList";
import { ProviderCustomSettingsDrawer } from "./providers/ProviderCustomSettingsDrawer";
import { ProviderDetail } from "./providers/ProviderDetail";
import { ProviderPendingDetail } from "./providers/ProviderPendingDetail";
import { ProviderProbeDialog, type ProviderProbeRequest } from "./providers/ProviderProbeDialog";
import {
  applyProbeToProvider,
  createProviderFromAutoConfiguration,
  DEFAULT_CREDENTIAL_ID,
  enabledCredentials,
  finalizeProvider,
  instanceNameForPreset,
  type ProviderDrawerState,
  type ProviderSelection,
  presetForProvider,
  probeSummaryFor,
  providerCredentials,
  providerExistingCandidates,
  providerProbeCandidates,
  providerUsesCatalogModels,
  recordProbeObservations,
  setCredentials,
} from "./providers/providerSettingsModel";
import { RequestConfigDrawer } from "./providers/RequestConfigDrawer";

type ProbeSession = {
  request: ProviderProbeRequest;
  onAccept: Parameters<typeof ProviderProbeDialog>[0]["onAccept"];
  /** 取消时仍写回本次观测（观测不是配置） */
  onDismiss?: Parameters<typeof ProviderProbeDialog>[0]["onDismiss"];
};

type Notice = { tone: "ok" | "bad"; text: string };

function defaultSelection(providers: readonly CustomProvider[]): ProviderSelection {
  if (providers.length > 0) return { kind: "provider", id: providers[0].id };
  const preset = listProviderPresets()[0];
  return preset ? { kind: "preset", id: preset.id } : null;
}

export function ProvidersSection(
  props: SettingsSectionProps & {
    initialProviderId?: string;
    onInitialProviderHandled?: () => void;
  },
) {
  const { settings, setSettings, initialProviderId, onInitialProviderHandled } = props;
  const { t } = useLocale();
  const isGatewayWebui = isGatewayWebuiRuntime();
  const providers = settings.customProviders;
  const [selection, setSelection] = useState<ProviderSelection>(() => defaultSelection(providers));
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [drawer, setDrawer] = useState<ProviderDrawerState>(null);
  const [addChannel, setAddChannel] = useState<{ presetId?: string } | null>(null);
  const [customSettingsOpen, setCustomSettingsOpen] = useState(false);
  const [probeSession, setProbeSession] = useState<ProbeSession | null>(null);
  const [busy, setBusy] = useState<{ providerId: string; kind: "check" | "refresh" } | null>(null);
  const [notice, setNotice] = useState<({ providerId: string } & Notice) | null>(null);
  const { usageByProvider, refreshingProviderIds, refreshProvider } = useProviderUsage(providers);
  const usageNow = useUsageNowTicker(
    providers.some((provider) => provider.usageQuery?.enabled) ||
      Object.keys(usageByProvider).length > 0,
  );
  const openedInitialProviderIdRef = useRef<string | null>(null);

  const selectedProvider =
    selection?.kind === "provider"
      ? providers.find((provider) => provider.id === selection.id)
      : undefined;
  const selectedPreset =
    selection?.kind === "preset" ? findProviderPreset(selection.id) : undefined;

  // 选中的实例被删除或从未存在时回到默认选择。
  useEffect(() => {
    if (selection?.kind === "provider" && !selectedProvider) {
      setSelection(defaultSelection(providers));
      setDrawer(null);
    }
  }, [selection, selectedProvider, providers]);

  useEffect(() => {
    const providerId = initialProviderId?.trim();
    if (!providerId || openedInitialProviderIdRef.current === providerId) return;
    const provider = settings.customProviders.find((item) => item.id === providerId);
    if (!provider) return;
    openedInitialProviderIdRef.current = providerId;
    setSelection({ kind: "provider", id: provider.id });
    setMobileDetailOpen(true);
    setDrawer(null);
    onInitialProviderHandled?.();
  }, [initialProviderId, onInitialProviderHandled, settings.customProviders]);

  const updateProvider = useCallback(
    (providerId: string, updater: (provider: CustomProvider) => CustomProvider) => {
      setSettings((prev) =>
        updateCustomProviders(
          prev,
          prev.customProviders.map((provider) =>
            provider.id === providerId ? finalizeProvider(updater(provider)) : provider,
          ),
        ),
      );
    },
    [setSettings],
  );

  const selectedProviderId = selectedProvider?.id;
  const updateSelectedProvider = useCallback(
    (updater: (provider: CustomProvider) => CustomProvider) => {
      if (selectedProviderId) updateProvider(selectedProviderId, updater);
    },
    [selectedProviderId, updateProvider],
  );

  function addProvider(provider: CustomProvider) {
    setSettings((prev) => updateCustomProviders(prev, [...prev.customProviders, provider]));
    select({ kind: "provider", id: provider.id });
  }

  function select(next: ProviderSelection) {
    setSelection(next);
    setDrawer(null);
    setMobileDetailOpen(true);
  }

  function deleteProvider(providerId: string) {
    setSettings((prev) =>
      updateCustomProviders(
        prev,
        prev.customProviders.filter((provider) => provider.id !== providerId),
      ),
    );
    setDrawer(null);
  }

  function showNotice(providerId: string, value: Notice) {
    setNotice({ providerId, ...value });
  }

  /** 探测对话框取消：只把已配置端点与各源的 lastProbe 写回，不采纳端点 / 模型变更。 */
  function recordDismissedProbe(
    providerId: string,
    result: { probe: ProviderProbeResult; candidates: EndpointCandidate[] },
  ) {
    updateProvider(providerId, (current) =>
      recordProbeObservations(current, result.candidates, result.probe),
    );
  }

  /** 未配置渠道的"检测并启用"：探测后创建实例。 */
  function setupPreset(presetId: string, input: { origin: string; apiKey: string }) {
    const preset = findProviderPreset(presetId);
    if (!preset) return;
    const isCustom = preset.id === CUSTOM_PRESET_ID;
    const candidates = buildEndpointCandidates({
      preset: isCustom ? undefined : preset,
      ...(preset.input === "base" ? { baseUrl: input.origin } : { origin: input.origin }),
    });
    const credentials: ProviderCredential[] = [
      {
        id: DEFAULT_CREDENTIAL_ID,
        label: "",
        apiKey: input.apiKey,
        apiKeyConfigured: input.apiKey.length > 0,
        enabled: true,
        modelScope: { mode: "auto" },
      },
    ];
    setProbeSession({
      request: {
        preset: isCustom ? undefined : preset,
        candidates,
        credentials,
        useSystemProxy: false,
        customHeaders: [],
        title: t("settings.providerProbeTitleSetup").replace("{name}", preset.name),
        acceptLabel: t("settings.providerProbeAcceptCreate"),
      },
      onAccept: ({ auto }) => {
        addProvider(
          createProviderFromAutoConfiguration({
            preset,
            name: instanceNameForPreset(preset, providers, input.origin),
            apiKey: input.apiKey,
            auto,
          }),
        );
      },
    });
  }

  /** 已配置实例的"检测并配置"：注册表接口 + 现有端点全部探测，摘要采纳后并入。 */
  function probeConfigure(provider: CustomProvider) {
    const preset = presetForProvider(provider);
    const candidates = providerProbeCandidates(provider);
    if (candidates.length === 0) {
      showNotice(provider.id, { tone: "bad", text: t("settings.providerNoEndpointsHint") });
      return;
    }
    setProbeSession({
      request: {
        preset: preset.id === CUSTOM_PRESET_ID ? undefined : preset,
        candidates,
        credentials: enabledCredentials(provider),
        useSystemProxy: provider.useSystemProxy,
        customHeaders: provider.customHeaders ?? [],
        providerId: provider.id,
        title: t("settings.providerProbeTitleConfigure").replace("{name}", provider.name),
        acceptLabel: t("settings.providerProbeAcceptApply"),
      },
      onAccept: ({ auto, probe, candidates: probed }) => {
        updateProvider(provider.id, (current) =>
          applyProbeToProvider(current, { candidates: probed, probe, auto, mode: "configure" }),
        );
      },
      onDismiss: (result) => recordDismissedProbe(provider.id, result),
    });
  }

  /** "检测"：只跑已配置端点（源地址模式按源 × 接口展开），记录观测，不改模型。 */
  async function quickCheck(provider: CustomProvider) {
    const candidates = providerExistingCandidates(provider, { includeDisabled: true });
    if (candidates.length === 0) {
      showNotice(provider.id, { tone: "bad", text: t("settings.providerNoEndpointsHint") });
      return;
    }
    setBusy({ providerId: provider.id, kind: "check" });
    try {
      const probe = await probeProvider({
        candidates,
        credentials: enabledCredentials(provider),
        useSystemProxy: provider.useSystemProxy,
        customHeaders: provider.customHeaders,
        providerId: provider.id,
        preset: presetForProvider(provider),
      });
      const seenByCredential = new Map<string, Set<string>>();
      let okCount = 0;
      for (const entry of probe.credentials) {
        const seen = seenByCredential.get(entry.credentialId) ?? new Set<string>();
        for (const endpoint of entry.endpoints) {
          if (!isProbeStatusUsable(endpoint.status)) continue;
          for (const model of endpoint.models) seen.add(model.id);
        }
        seenByCredential.set(entry.credentialId, seen);
      }
      const probedProtocols = [...new Set(candidates.map((candidate) => candidate.protocol))];
      okCount = probedProtocols.filter((protocol) =>
        isProbeStatusUsable(probeSummaryFor(probe, protocol).status),
      ).length;
      updateProvider(provider.id, (current) => {
        const next = recordProbeObservations(current, candidates, probe);
        const credentials = providerCredentials(next).map((credential) => {
          const seen = seenByCredential.get(credential.id);
          return seen && seen.size > 0
            ? {
                ...credential,
                modelScope: credential.modelScope ?? { mode: "auto" as const },
                lastModels: { at: probe.at, models: [...seen].sort() },
              }
            : credential;
        });
        return setCredentials(next, credentials);
      });
      showNotice(
        provider.id,
        okCount > 0
          ? {
              tone: "ok",
              text: t("settings.providerCheckDone")
                .replace("{ok}", String(okCount))
                .replace(
                  "{total}",
                  String(new Set(candidates.map((candidate) => candidate.protocol)).size),
                ),
            }
          : { tone: "bad", text: t("settings.providerCheckFailed") },
      );
    } finally {
      setBusy(null);
    }
  }

  /** "获取模型列表"：启用的 Key × 启用的渠道，合并后追加新模型并刷新观测。 */
  async function refreshModels(provider: CustomProvider) {
    const candidates = providerExistingCandidates(provider);
    if (candidates.length === 0) {
      showNotice(provider.id, { tone: "bad", text: t("settings.providerNoEndpointsHint") });
      return;
    }
    const preset = presetForProvider(provider);
    setBusy({ providerId: provider.id, kind: "refresh" });
    try {
      const credentials = enabledCredentials(provider);
      const probe = await probeProvider({
        candidates,
        credentials,
        useSystemProxy: provider.useSystemProxy,
        customHeaders: provider.customHeaders,
        providerId: provider.id,
        preset,
      });
      const auto = buildAutoConfiguration({
        preset: preset.id === CUSTOM_PRESET_ID ? undefined : preset,
        candidates,
        probe,
        credentials,
      });
      if (!auto.usable) {
        const failure = probe.credentials
          .flatMap((entry) => entry.endpoints)
          .find((endpoint) => endpoint.error)?.error;
        showNotice(provider.id, {
          tone: "bad",
          text: failure ? `${t("settings.fetchFailed")}: ${failure}` : t("settings.fetchFailed"),
        });
        return;
      }
      const knownIds = new Set(provider.models.map((model) => model.id));
      const added = auto.models.filter((model) => !knownIds.has(model.id)).length;
      updateProvider(provider.id, (current) =>
        applyProbeToProvider(current, { candidates, probe, auto, mode: "refresh" }),
      );
      showNotice(provider.id, {
        tone: "ok",
        // 目录渠道没有发请求，措辞区分开：是按内置目录对齐，不是从上游拉取。
        text: t(
          providerUsesCatalogModels(provider)
            ? "settings.providerModelsRefreshedCatalog"
            : "settings.providerModelsRefreshed",
        )
          .replace("{total}", String(auto.models.length))
          .replace("{added}", String(added)),
      });
    } finally {
      setBusy(null);
    }
  }

  /** "添加渠道"提交：创建实例后立即按已填接口探测并拉取模型。 */
  function createFromDialog(provider: CustomProvider) {
    addProvider(provider);
    const preset = presetForProvider(provider);
    const candidates = providerExistingCandidates(provider);
    if (candidates.length === 0) return;
    setProbeSession({
      request: {
        preset: preset.id === CUSTOM_PRESET_ID ? undefined : preset,
        candidates,
        credentials: providerCredentials(provider),
        useSystemProxy: provider.useSystemProxy,
        customHeaders: provider.customHeaders ?? [],
        providerId: provider.id,
        title: t("settings.providerProbeTitleConfigure").replace("{name}", provider.name),
        acceptLabel: t("settings.providerProbeAcceptApply"),
      },
      onAccept: ({ auto, probe, candidates: probed }) => {
        updateProvider(provider.id, (current) =>
          applyProbeToProvider(current, { candidates: probed, probe, auto, mode: "configure" }),
        );
      },
      onDismiss: (result) => recordDismissedProbe(provider.id, result),
    });
  }

  const selectedUsage = useMemo(() => {
    if (!selectedProvider) return null;
    const refreshing = refreshingProviderIds.has(selectedProvider.id);
    return {
      display: getProviderUsageCardDisplay(
        selectedProvider,
        usageByProvider[selectedProvider.id],
        refreshing,
        usageNow,
      ),
      refreshing,
      onRefresh: () => void refreshProvider(selectedProvider.id),
    };
  }, [selectedProvider, refreshingProviderIds, usageByProvider, usageNow, refreshProvider]);

  const activeNotice =
    notice && selectedProvider && notice.providerId === selectedProvider.id ? notice : null;

  return (
    <>
      <div className="settings-provider-section flex min-h-0 flex-1 flex-col">
        <div className="settings-provider-columns grid min-h-0 flex-1 grid-cols-[264px_minmax(0,1fr)] gap-5 max-[720px]:grid-cols-1">
          <aside
            className={cn(
              "settings-provider-column-list min-h-0 border-r pr-4 max-[720px]:border-r-0 max-[720px]:pr-0",
              mobileDetailOpen && "max-[720px]:hidden",
            )}
          >
            <ProviderCatalogList
              providers={providers}
              selection={selection}
              onSelect={select}
              onAddChannel={() => setAddChannel({})}
              extraActions={
                <>
                  <ProviderSettingsExtension
                    activeTab={selectedProvider?.type}
                    settings={settings}
                    setSettings={setSettings}
                    triggerClassName="h-8 rounded-md px-2 text-xs shadow-none"
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className={cn(
                            "h-8 w-8 shrink-0 shadow-none data-[popup-open]:bg-accent",
                            (customSettingsOpen || drawer?.kind === "catalog") && "bg-accent",
                          )}
                          title={t("settings.providerPageTools")}
                          aria-label={t("settings.providerPageTools")}
                        />
                      }
                    >
                      <Settings className="h-3.5 w-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-40">
                      <DropdownMenuItem
                        className="gap-2 text-xs"
                        onSelect={() => setCustomSettingsOpen(true)}
                      >
                        <Settings className="h-3.5 w-3.5 text-muted-foreground" />
                        {t("settings.customSettings")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="gap-2 text-xs"
                        onSelect={() => setDrawer({ kind: "catalog" })}
                      >
                        <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
                        {t("settings.modelCatalogBrowser")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              }
            />
          </aside>
          <section
            className={cn(
              "settings-provider-column-detail min-h-0 overflow-y-auto pb-6 pr-1",
              !mobileDetailOpen && "max-[720px]:hidden",
            )}
          >
            {selectedProvider && selectedUsage ? (
              <ProviderDetail
                key={selectedProvider.id}
                settings={settings}
                setSettings={setSettings}
                provider={selectedProvider}
                isGatewayWebui={isGatewayWebui}
                onChange={updateSelectedProvider}
                onOpenDrawer={setDrawer}
                onProbeConfigure={() => probeConfigure(selectedProvider)}
                onQuickCheck={() => void quickCheck(selectedProvider)}
                onRefreshModels={() => void refreshModels(selectedProvider)}
                onDelete={() => deleteProvider(selectedProvider.id)}
                onBack={() => setMobileDetailOpen(false)}
                busy={busy?.providerId === selectedProvider.id ? busy.kind : null}
                notice={activeNotice}
                usage={selectedUsage}
              />
            ) : selectedPreset ? (
              <ProviderPendingDetail
                key={selectedPreset.id}
                preset={selectedPreset}
                onSetup={(input) => setupPreset(selectedPreset.id, input)}
                onAddManually={() => setAddChannel({ presetId: selectedPreset.id })}
                onBack={() => setMobileDetailOpen(false)}
              />
            ) : (
              <div className="rounded-xl border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
                {t("settings.channelSelectHint")}
              </div>
            )}
          </section>
        </div>
      </div>

      {selectedProvider && drawer?.kind === "request" ? (
        <RequestConfigDrawer
          provider={selectedProvider}
          focus={drawer.focus}
          onChange={updateSelectedProvider}
          onClose={() => setDrawer(null)}
        />
      ) : null}
      {selectedProvider && drawer?.kind === "keys" ? (
        <CredentialsDrawer
          provider={selectedProvider}
          isGatewayWebui={isGatewayWebui}
          focus={drawer.focus}
          onChange={updateSelectedProvider}
          onClose={() => setDrawer(null)}
        />
      ) : null}
      {selectedProvider && drawer?.kind === "model" ? (
        <ModelEditDrawer
          settings={settings}
          provider={selectedProvider}
          modelId={drawer.modelId}
          onChange={updateSelectedProvider}
          onClose={() => setDrawer(null)}
          onOpenCatalog={(target) => setDrawer({ kind: "catalog", ...target, returnTo: drawer })}
        />
      ) : null}
      {drawer?.kind === "catalog" ? (
        <ModelCatalogDrawer
          initialSectionId={drawer.sectionId}
          initialQuery={drawer.query}
          onClose={() => setDrawer(drawer.returnTo ?? null)}
        />
      ) : null}
      {addChannel ? (
        <AddChannelDialog
          providers={providers}
          initialPresetId={addChannel.presetId}
          onCreate={createFromDialog}
          onClose={() => setAddChannel(null)}
        />
      ) : null}
      {probeSession ? (
        <ProviderProbeDialog
          request={probeSession.request}
          onAccept={probeSession.onAccept}
          onDismiss={probeSession.onDismiss}
          onClose={() => setProbeSession(null)}
        />
      ) : null}
      {customSettingsOpen ? (
        <ProviderCustomSettingsDrawer
          settings={settings}
          setSettings={setSettings}
          onClose={() => setCustomSettingsOpen(false)}
        />
      ) : null}
    </>
  );
}
