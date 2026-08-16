import {
  CheckCircle2,
  ChevronDown,
  Download,
  Key,
  Loader2,
  RefreshCw,
  X,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  createDraftModelConfig,
  fetchModelsFromApi,
  mergeFetchedModels,
} from "@liveagent/ui/pages/settings/providerUtils";
import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import ccswitchLogoUrl from "../../src-tauri/icons/custom/ccswitch.png";
import cherryStudioLogoUrl from "../../src-tauri/icons/custom/cherrystudio.png";
import type { ProviderModelConfig } from "../lib/settings";
import {
  type AppSettings,
  type CodexRequestFormat,
  type CustomProvider,
  getDefaultUsageQueryConfig,
  type ProviderId,
  updateCustomProviders,
} from "../lib/settings";
import {
  type CherryProviderImportItem,
  type CherryProvidersResponse,
  CherryStudioImportModal,
} from "../pages/settings/CherryStudioImportModal";
import type { SetSettingsFn } from "../pages/settings/types";

type CcsProviderImportItem = {
  sourceId: string;
  appType: string;
  providerType: ProviderId;
  name: string;
  baseUrl: string;
  isFullUrl: boolean;
  modelsUrl?: string;
  apiKey: string;
  requestFormat: CodexRequestFormat;
  models?: string[];
};

type CcsProvidersResponse = {
  status: string;
  message: string;
  providers: CcsProviderImportItem[];
};

const CHERRY_DATA_PATH_STORAGE_KEY = "liveagent.cherryStudioDataPath";

function sourceLogo(source: "ccswitch" | "cherry", className?: string) {
  return (
    <img
      src={source === "ccswitch" ? ccswitchLogoUrl : cherryStudioLogoUrl}
      alt=""
      draggable={false}
      className={cn("shrink-0 select-none rounded-lg object-contain", className)}
    />
  );
}

function readCherryDataPath() {
  try {
    return localStorage.getItem(CHERRY_DATA_PATH_STORAGE_KEY);
  } catch {
    return null;
  }
}

function normalizedBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function ccsImportIdentity(provider: Pick<CustomProvider, "type" | "name" | "baseUrl">) {
  const name = provider.name
    .replace(/[（(]ccswitch[）)]/i, "")
    .trim()
    .toLowerCase();
  return `${provider.type}\n${name}\n${normalizedBaseUrl(provider.baseUrl)}`;
}

function ccsItemKey(item: CcsProviderImportItem) {
  return `${item.appType}:${item.sourceId}`;
}

function ccsProviderIsTransferable(item: CcsProviderImportItem) {
  return (
    (item.baseUrl.trim().length > 0 && item.apiKey.trim().length > 0) ||
    (item.models?.length ?? 0) > 0
  );
}

export function providerFromCcs(
  item: CcsProviderImportItem,
  existingIds: Set<string>,
): CustomProvider {
  const baseId =
    `ccswitch-${item.sourceId}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "ccswitch-provider";
  let id = baseId;
  for (let index = 2; existingIds.has(id); index += 1) id = `${baseId}-${index}`;
  existingIds.add(id);
  const models = (item.models ?? []).map((model) =>
    createDraftModelConfig(item.providerType, model),
  );
  return {
    id,
    name: `${item.name.replace(/[（(]ccswitch[）)]/i, "").trim()}（ccswitch）`,
    type: item.providerType,
    baseUrl: item.baseUrl,
    isFullUrl: item.isFullUrl,
    ...(item.providerType !== "gemini" && item.modelsUrl?.trim()
      ? { modelsUrl: item.modelsUrl.trim() }
      : {}),
    apiKey: item.apiKey,
    apiKeyConfigured: item.apiKey.trim().length > 0,
    models,
    activeModels: models.map((model) => model.id),
    requestFormat:
      item.providerType === "xai"
        ? "openai-responses"
        : item.providerType === "codex"
          ? item.requestFormat
          : undefined,
    reasoning: "off",
    promptCachingEnabled:
      item.providerType !== "gemini" &&
      item.providerType !== "xai" &&
      item.providerType !== "deepseek",
    nativeWebSearchEnabled: item.providerType !== "deepseek",
    useSystemProxy: false,
    usageQuery: getDefaultUsageQueryConfig(),
  };
}

function cherryProviderId(item: CherryProviderImportItem) {
  return (
    `cherry-studio-${item.sourceId}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "cherry-studio-provider"
  );
}

function cherryProviderName(item: CherryProviderImportItem, allItems: CherryProviderImportItem[]) {
  const duplicateCount = allItems.filter(
    (candidate) =>
      candidate.name.trim().toLowerCase() === item.name.trim().toLowerCase() &&
      candidate.providerType === item.providerType &&
      normalizedBaseUrl(candidate.baseUrl) === normalizedBaseUrl(item.baseUrl),
  ).length;
  if (duplicateCount <= 1) return `${item.name.trim()}（Cherry Studio）`;
  return `${item.name.trim()}（Cherry Studio · ${item.sourceId.split("::", 1)[0].slice(0, 8)}）`;
}

function cherryEffectiveApiKey(item: CherryProviderImportItem, existing?: CustomProvider) {
  return existing?.apiKey?.trim() ? existing.apiKey : item.apiKey;
}

export function providerFromCherry(
  item: CherryProviderImportItem,
  allItems: CherryProviderImportItem[],
  existing?: CustomProvider,
): CustomProvider {
  const apiKey = cherryEffectiveApiKey(item, existing);
  return {
    ...(existing ?? {}),
    id: cherryProviderId(item),
    name: existing?.name ?? cherryProviderName(item, allItems),
    type: item.providerType,
    baseUrl: item.baseUrl,
    isFullUrl: existing?.isFullUrl ?? false,
    ...(existing?.modelsUrl ? { modelsUrl: existing.modelsUrl } : {}),
    apiKey,
    apiKeyConfigured: apiKey.trim().length > 0,
    models: existing?.models ?? [],
    activeModels: existing?.activeModels ?? [],
    requestFormat:
      item.providerType === "xai"
        ? "openai-responses"
        : item.providerType === "codex"
          ? item.requestFormat
          : undefined,
    reasoning: existing?.reasoning ?? "off",
    promptCachingEnabled:
      item.providerType === "deepseek"
        ? false
        : (existing?.promptCachingEnabled ??
          (item.providerType !== "gemini" && item.providerType !== "xai")),
    nativeWebSearchEnabled:
      item.providerType === "deepseek" ? false : (existing?.nativeWebSearchEnabled ?? true),
    useSystemProxy: existing?.useSystemProxy ?? false,
    usageQuery: existing?.usageQuery ?? getDefaultUsageQueryConfig(),
  };
}

function isLikelyCherryChatModel(modelId: string) {
  const lower = modelId.toLowerCase();
  return ![
    "embedding",
    "rerank",
    "whisper",
    "realtime",
    "audio-preview",
    "audio-realtime",
    "image",
    "video",
    "banana",
    "dall-e",
    "imagen",
    "sora-",
    "veo-",
    "tts-",
  ].some((needle) => lower.includes(needle));
}

function CcsImportModal(props: {
  activeTab: ProviderId;
  items: CcsProviderImportItem[];
  existingProviders: CustomProvider[];
  importing: boolean;
  result: string | null;
  onImport: (items: CcsProviderImportItem[]) => void;
  onClose: () => void;
}) {
  const { activeTab, items, existingProviders, importing, result, onImport, onClose } = props;
  const existing = useMemo(
    () => new Set(existingProviders.map(ccsImportIdentity)),
    [existingProviders],
  );
  const rows = items.filter((item) => item.providerType === activeTab);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const selectedItems = rows.filter((item) => selected.has(ccsItemKey(item)));

  function toggle(item: CcsProviderImportItem) {
    const key = ccsItemKey(item);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="关闭 CC Switch 导入"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={importing ? undefined : onClose}
      />
      <div className="relative z-10 flex h-[min(34rem,85vh)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl">
        <div className="flex items-center gap-3 border-b px-6 py-4">
          {sourceLogo("ccswitch", "h-9 w-9")}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">从 CC Switch 导入</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              导入当前供应商类型的配置，并在后台获取模型列表
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={importing}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 divide-y overflow-y-auto">
          {rows.length > 0 ? (
            rows.map((item) => {
              const identity = ccsImportIdentity({
                type: item.providerType,
                name: item.name,
                baseUrl: item.baseUrl,
              });
              const alreadyImported = existing.has(identity);
              const selectable = ccsProviderIsTransferable(item) && !alreadyImported;
              return (
                <label
                  key={ccsItemKey(item)}
                  className={cn(
                    "flex items-center gap-3 px-6 py-3",
                    selectable ? "cursor-pointer hover:bg-accent/40" : "opacity-55",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selectable && selected.has(ccsItemKey(item))}
                    disabled={!selectable || importing}
                    onChange={() => toggle(item)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{item.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {item.baseUrl || "未配置 Base URL"}
                    </div>
                  </div>
                  {item.apiKey.trim() ? <Key className="h-3.5 w-3.5" /> : null}
                  {alreadyImported ? (
                    <span className="text-xs text-emerald-600">已导入</span>
                  ) : null}
                </label>
              );
            })
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              当前类型未发现可导入配置
            </div>
          )}
        </div>
        {result ? (
          <div className="flex items-start gap-2 border-t px-6 py-3 text-xs text-emerald-600">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{result}</span>
          </div>
        ) : null}
        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <Button variant="outline" onClick={onClose} disabled={importing}>
            关闭
          </Button>
          <Button
            className="gap-1.5"
            onClick={() => onImport(selectedItems)}
            disabled={importing || selectedItems.length === 0}
          >
            {importing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            导入 {selectedItems.length} 项
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ProviderSettingsExtension(props: {
  activeTab: ProviderId;
  settings: AppSettings;
  setSettings: SetSettingsFn;
}) {
  const { activeTab, settings, setSettings } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [ccsResponse, setCcsResponse] = useState<CcsProvidersResponse | null>(null);
  const [cherryResponse, setCherryResponse] = useState<CherryProvidersResponse | null>(null);
  const [ccsModalOpen, setCcsModalOpen] = useState(false);
  const [cherryModalOpen, setCherryModalOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [cherryDataPath, setCherryDataPath] = useState<string | null>(readCherryDataPath);

  async function scan() {
    setScanning(true);
    setMessage(null);
    try {
      const results = await Promise.allSettled([
        invoke<CcsProvidersResponse>("settings_list_ccswitch_providers"),
        cherryDataPath
          ? invoke<CherryProvidersResponse>("settings_list_cherry_studio_providers_from_path", {
              dataPath: cherryDataPath,
            })
          : invoke<CherryProvidersResponse>("settings_list_cherry_studio_providers"),
      ]);
      if (results[0].status === "fulfilled") setCcsResponse(results[0].value);
      if (results[1].status === "fulfilled") setCherryResponse(results[1].value);
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) =>
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
      if (errors.length > 0) setMessage(errors.join("；"));
    } finally {
      setScanning(false);
    }
  }

  function handleMenuOpenChange(open: boolean) {
    setMenuOpen(open);
    if (open && !ccsResponse && !cherryResponse && !scanning) void scan();
  }

  async function syncModels(providers: CustomProvider[]) {
    const results = await Promise.all(
      providers.map(async (provider) => {
        try {
          const models = await fetchModelsFromApi(
            provider.type,
            provider.baseUrl,
            provider.apiKey,
            {
              useSystemProxy: provider.useSystemProxy,
              isFullUrl: provider.isFullUrl,
              modelsUrl: provider.modelsUrl,
            },
          );
          return { id: provider.id, models, ok: true };
        } catch {
          return { id: provider.id, models: [] as ProviderModelConfig[], ok: false };
        }
      }),
    );
    setSettings((current) =>
      updateCustomProviders(
        current,
        current.customProviders.map((provider) => {
          const result = results.find((item) => item.id === provider.id);
          if (!result?.ok) return provider;
          const models = mergeFetchedModels(result.models, provider.models);
          return { ...provider, models, activeModels: models.map((model) => model.id) };
        }),
      ),
    );
    const failed = results.filter((result) => !result.ok).length;
    setMessage(
      failed > 0
        ? `已导入配置，${failed} 个供应商模型获取失败`
        : "已导入配置并激活获取到的全部模型",
    );
  }

  function importCcs(items: CcsProviderImportItem[]) {
    if (items.length === 0 || importing) return;
    setImporting(true);
    const existingIds = new Set(settings.customProviders.map((provider) => provider.id));
    const existingIdentity = new Set(settings.customProviders.map(ccsImportIdentity));
    const imported = items.flatMap((item) => {
      const identity = ccsImportIdentity({
        type: item.providerType,
        name: item.name,
        baseUrl: item.baseUrl,
      });
      if (existingIdentity.has(identity) || !ccsProviderIsTransferable(item)) return [];
      existingIdentity.add(identity);
      return [providerFromCcs(item, existingIds)];
    });
    setSettings((current) => {
      return imported.length > 0
        ? updateCustomProviders(current, [...current.customProviders, ...imported])
        : current;
    });
    setMessage(`已导入 ${imported.length} 个 CC Switch 供应商，正在获取模型…`);
    void syncModels(imported).finally(() => setImporting(false));
  }

  async function importCherry(items: CherryProviderImportItem[]) {
    if (importing) return;
    const importable = items.filter((item) => item.importable);
    if (importable.length === 0) return;
    setImporting(true);
    const allItems = cherryResponse?.providers ?? importable;
    const importedIds = importable.map(cherryProviderId);
    setSettings((current) => {
      const providers = [...current.customProviders];
      for (const item of importable) {
        const id = cherryProviderId(item);
        const index = providers.findIndex((provider) => provider.id === id);
        const provider = providerFromCherry(
          item,
          allItems,
          index >= 0 ? providers[index] : undefined,
        );
        if (index >= 0) providers[index] = provider;
        else providers.push(provider);
      }
      return updateCustomProviders(current, providers);
    });
    const results = await Promise.all(
      importable.map(async (item) => {
        const id = cherryProviderId(item);
        try {
          const models = (
            await fetchModelsFromApi(item.providerType, item.baseUrl, item.apiKey)
          ).filter((model) => isLikelyCherryChatModel(model.id));
          return { id, models, ok: true };
        } catch {
          return { id, models: [] as ProviderModelConfig[], ok: false };
        }
      }),
    );
    setSettings((current) =>
      updateCustomProviders(
        current,
        current.customProviders.map((provider) => {
          if (!importedIds.includes(provider.id)) return provider;
          const result = results.find((item) => item.id === provider.id);
          if (!result?.ok) return provider;
          const models = mergeFetchedModels(result.models, provider.models);
          return { ...provider, models, activeModels: models.map((model) => model.id) };
        }),
      ),
    );
    const failed = results.filter((result) => !result.ok).length;
    setMessage(
      failed > 0
        ? `已同步 ${importable.length} 个 Cherry Studio 供应商，${failed} 个模型列表获取失败`
        : `已同步 ${importable.length} 个 Cherry Studio 供应商并激活全部模型`,
    );
    setCherryModalOpen(false);
    setImporting(false);
  }

  async function chooseCherryDataDirectory() {
    const selected = await invoke<string | null>("system_pick_folder", {
      initial_workdir: cherryDataPath ?? cherryResponse?.dataPath ?? undefined,
    });
    if (!selected) return;
    setScanning(true);
    try {
      const response = await invoke<CherryProvidersResponse>(
        "settings_list_cherry_studio_providers_from_path",
        { dataPath: selected },
      );
      const resolvedPath = response.dataPath || selected;
      localStorage.setItem(CHERRY_DATA_PATH_STORAGE_KEY, resolvedPath);
      setCherryDataPath(resolvedPath);
      setCherryResponse(response);
    } finally {
      setScanning(false);
    }
  }

  function resetCherryDataDirectory() {
    localStorage.removeItem(CHERRY_DATA_PATH_STORAGE_KEY);
    setCherryDataPath(null);
    setScanning(true);
    void invoke<CherryProvidersResponse>("settings_list_cherry_studio_providers")
      .then(setCherryResponse)
      .finally(() => setScanning(false));
  }

  const ccsCount =
    ccsResponse?.providers.filter((item) => item.providerType === activeTab).length ?? 0;
  const cherryCount =
    cherryResponse?.providers.filter((item) => item.providerType === activeTab && item.importable)
      .length ?? 0;

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              title={message ?? "从桌面开发工具导入供应商"}
            />
          }
        >
          {scanning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          导入
          <ChevronDown
            className={cn("h-3.5 w-3.5 transition-transform", menuOpen && "rotate-180")}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel>桌面配置同步</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => void scan()} disabled={scanning} className="gap-2">
            <RefreshCw className={cn("h-4 w-4", scanning && "animate-spin")} />
            重新扫描本地配置
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={scanning || ccsCount === 0}
            onSelect={() => setCcsModalOpen(true)}
            className="gap-3 py-2.5"
          >
            {sourceLogo("ccswitch", "h-8 w-8")}
            <span className="min-w-0 flex-1">
              <span className="block font-medium">CC Switch</span>
              <span className="block truncate text-xs text-muted-foreground">
                当前类型发现 {ccsCount} 项配置
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={scanning || cherryCount === 0}
            onSelect={() => setCherryModalOpen(true)}
            className="gap-3 py-2.5"
          >
            {sourceLogo("cherry", "h-8 w-8")}
            <span className="min-w-0 flex-1">
              <span className="block font-medium">Cherry Studio</span>
              <span className="block truncate text-xs text-muted-foreground">
                当前类型发现 {cherryCount} 项可同步配置
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {ccsModalOpen ? (
        <CcsImportModal
          activeTab={activeTab}
          items={ccsResponse?.providers ?? []}
          existingProviders={settings.customProviders}
          importing={importing}
          result={message}
          onImport={importCcs}
          onClose={() => setCcsModalOpen(false)}
        />
      ) : null}
      {cherryModalOpen && cherryResponse ? (
        <CherryStudioImportModal
          initialType={activeTab}
          response={cherryResponse}
          importing={importing}
          scanning={scanning}
          dataPath={cherryDataPath}
          isExisting={(item) =>
            settings.customProviders.some((provider) => provider.id === cherryProviderId(item))
          }
          onChooseDataDirectory={() => void chooseCherryDataDirectory()}
          onResetDataDirectory={resetCherryDataDirectory}
          onConfirm={(items) => void importCherry(items)}
          onClose={() => setCherryModalOpen(false)}
        />
      ) : null}
    </>
  );
}
