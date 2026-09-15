import {
  Check,
  ClaudeIcon,
  DeepseekIcon,
  FolderOpen,
  GeminiIcon,
  GrokIcon,
  OpenaiChatgptIcon,
  RefreshCw,
  Settings,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSubheader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import {
  findProviderPreset,
  type ProviderChatProtocol,
  type ProviderPreset,
  presetIdForLegacyType,
} from "@liveagent/ui/lib/providers/registry";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useMemo, useState } from "react";
import type {
  CodexRequestFormat,
  CustomProvider,
  ProviderCredential,
  ProviderEndpointConfig,
  ProviderId,
} from "../../lib/settings";

export type CherryProviderImportItem = {
  sourceId: string;
  sourceVersion: string;
  sourceProviderType: string;
  providerType: ProviderId;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** 源侧全部可迁移 Key（首把即 apiKey）；旧后端不带此字段。 */
  apiKeys?: string[];
  apiKeyCount: number;
  requestFormat: CodexRequestFormat;
  enabled: boolean;
  importable: boolean;
  reason: string;
  warning: string;
  excludedModelCount: number;
};

/** Cherry 源 provider id（`sourceId` 的 `::` 前缀）。 */
function cherrySourceProviderId(item: CherryProviderImportItem) {
  return item.sourceId.split("::", 1)[0] ?? "";
}

/** 条目走的接口：由 Rust 侧按模型分组后给出的 providerType + requestFormat 推得。 */
export function cherryItemChatProtocol(item: CherryProviderImportItem): ProviderChatProtocol {
  if (item.providerType === "claude_code") return "anthropic-messages";
  if (item.providerType === "gemini") return "google-generative-ai";
  if (item.providerType === "xai") return "openai-responses";
  if (item.providerType === "deepseek") return "openai-completions";
  return item.requestFormat === "openai-responses" ? "openai-responses" : "openai-completions";
}

/**
 * Cherry provider id 与预设注册表 id 不一致的别名；候选按顺序试，优先取
 * 默认地址与条目 Base URL 同源的那个（区分国际站与国内站）。
 */
const CHERRY_PRESET_ALIASES: Record<string, readonly string[]> = {
  silicon: ["siliconflow-cn", "siliconflow"],
  siliconflow: ["siliconflow-cn", "siliconflow"],
  dashscope: ["dashscope-cn", "dashscope"],
  moonshot: ["moonshot-cn", "moonshot"],
  minimax: ["minimax-cn", "minimax"],
  grok: ["xai"],
  doubao: ["volcengine"],
};

function urlOrigin(value: string): string | undefined {
  try {
    return new URL(value.trim()).origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function cherryPresetFor(item: CherryProviderImportItem): ProviderPreset | undefined {
  const sourceId = cherrySourceProviderId(item).trim().toLowerCase();
  const candidates = (CHERRY_PRESET_ALIASES[sourceId] ?? [sourceId])
    .map((id) => findProviderPreset(id))
    .filter((preset): preset is ProviderPreset => Boolean(preset));
  if (candidates.length === 0) {
    return findProviderPreset(presetIdForLegacyType(item.providerType));
  }
  const origin = urlOrigin(item.baseUrl);
  return (
    candidates.find(
      (preset) => origin && preset.defaultOrigin && urlOrigin(preset.defaultOrigin) === origin,
    ) ?? candidates[0]
  );
}

/**
 * 同一 Cherry provider 按接口拆成的兄弟条目 → 该供应商的多端点配置。每个条目
 * 仍各自导入为一个供应商（既有行为不变），这里只是把同源的其他接口地址一并
 * 记进 `endpointConfigs`，供路由按模型接口选地址。
 */
function cherryEndpointConfigs(
  item: CherryProviderImportItem,
  allItems: CherryProviderImportItem[],
  existing?: CustomProvider,
): CustomProvider["endpointConfigs"] {
  const sourceId = cherrySourceProviderId(item);
  const configs: NonNullable<CustomProvider["endpointConfigs"]> = {
    ...(existing?.endpointConfigs ?? {}),
  };
  const siblings = allItems.filter(
    (candidate) =>
      candidate.importable &&
      candidate.baseUrl.trim() &&
      cherrySourceProviderId(candidate) === sourceId,
  );
  for (const candidate of [item, ...siblings]) {
    const protocol = cherryItemChatProtocol(candidate);
    const baseUrl = candidate.baseUrl.trim();
    if (!baseUrl) continue;
    const current = configs[protocol];
    // 用户手改过的端点（source: user）不被导入覆盖。
    if (current?.source === "user") continue;
    const next: ProviderEndpointConfig = {
      ...(current ?? {}),
      baseUrl,
      enabled: true,
      source: "auto",
    };
    configs[protocol] = next;
  }
  return Object.keys(configs).length > 0 ? configs : undefined;
}

function cherryImportKeys(item: CherryProviderImportItem): string[] {
  const keys = (item.apiKeys?.length ? item.apiKeys : [item.apiKey])
    .map((key) => key.trim())
    .filter(Boolean);
  return [...new Set(keys)];
}

/**
 * 多 Key → 凭据列表。首把是默认凭据（与 `apiKey` 一致），其余按顺序作为备用；
 * 已有供应商保留原凭据，只追加尚未出现的 Key。只有一把 Key 且无既有凭据时返回
 * undefined，交给归一化生成默认凭据。
 */
function cherryCredentials(
  item: CherryProviderImportItem,
  primaryApiKey: string,
  existing?: CustomProvider,
): ProviderCredential[] | undefined {
  const imported = cherryImportKeys(item);
  const base: ProviderCredential[] = existing?.credentials?.length
    ? existing.credentials.map((credential) => ({ ...credential }))
    : primaryApiKey || imported.length > 1
      ? [
          {
            id: "default",
            label: "",
            apiKey: primaryApiKey,
            apiKeyConfigured: primaryApiKey.length > 0,
            enabled: true,
          },
        ]
      : [];
  if (base.length === 0) return undefined;
  const known = new Set(base.map((credential) => credential.apiKey.trim()).filter(Boolean));
  const usedIds = new Set(base.map((credential) => credential.id));
  let ordinal = 1;
  for (const key of imported) {
    if (known.has(key)) continue;
    ordinal += 1;
    let id = `cherry-key-${ordinal}`;
    while (usedIds.has(id)) id = `cherry-key-${++ordinal}`;
    usedIds.add(id);
    known.add(key);
    base.push({
      id,
      label: `Cherry Studio Key ${ordinal}`,
      apiKey: key,
      apiKeyConfigured: true,
      enabled: true,
    });
  }
  if (base.length === 1 && !existing?.credentials?.length) return undefined;
  return base;
}

/**
 * Cherry 条目映射到供应商注册表结构的那部分字段：预设、分类、默认接口、方言、
 * 多端点与多 Key。旧字段（type / baseUrl / apiKey / requestFormat）仍由调用方填。
 */
export function cherryProviderRegistryFields(
  item: CherryProviderImportItem,
  allItems: CherryProviderImportItem[],
  primaryApiKey: string,
  existing?: CustomProvider,
): Pick<
  CustomProvider,
  "presetId" | "defaultChatProtocol" | "dialect" | "endpointConfigs" | "credentials"
> {
  const preset = cherryPresetFor(item);
  const endpointConfigs = cherryEndpointConfigs(item, allItems, existing);
  const credentials = cherryCredentials(item, primaryApiKey, existing);
  const dialect = existing?.dialect ?? preset?.dialect;
  return {
    presetId: preset?.id ?? presetIdForLegacyType(item.providerType),
    defaultChatProtocol: cherryItemChatProtocol(item),
    ...(dialect ? { dialect } : {}),
    ...(endpointConfigs ? { endpointConfigs } : {}),
    ...(credentials ? { credentials } : {}),
  };
}

export type CherryProvidersResponse = {
  status: string;
  message: string;
  version: string;
  dataPath: string;
  totalProviderCount: number;
  enabledProviderCount: number;
  providers: CherryProviderImportItem[];
};

type CherryStudioImportModalProps = {
  initialType: ProviderId;
  response: CherryProvidersResponse;
  importing: boolean;
  scanning: boolean;
  dataPath: string | null;
  isExisting: (item: CherryProviderImportItem) => boolean;
  onChooseDataDirectory: () => void;
  onResetDataDirectory: () => void;
  onClose: () => void;
  onConfirm: (items: CherryProviderImportItem[]) => void;
};

const PROVIDER_ORDER: ProviderId[] = ["claude_code", "codex", "gemini", "xai", "deepseek"];

const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude_code: "Anthropic",
  codex: "OpenAI",
  gemini: "Gemini",
  xai: "Grok",
  deepseek: "DeepSeek",
};

function ProviderTypeIcon({ type }: { type: ProviderId }) {
  if (type === "claude_code") return <ClaudeIcon height="1em" />;
  if (type === "gemini") return <GeminiIcon height="1em" />;
  if (type === "xai") return <GrokIcon height="1em" />;
  if (type === "deepseek") return <DeepseekIcon height="1em" />;
  return <OpenaiChatgptIcon height="1em" className="fill-current dark:text-white" />;
}

function itemKey(item: CherryProviderImportItem) {
  return `${item.sourceId}\n${item.baseUrl}\n${item.requestFormat}`;
}

function itemProtocolLabel(item: CherryProviderImportItem) {
  if (item.providerType === "claude_code") return "Anthropic Messages";
  if (item.providerType === "gemini") return "Gemini Generate Content";
  if (item.providerType === "deepseek") return "DeepSeek Chat Completions";
  return item.requestFormat === "openai-responses" ? "Responses API" : "Chat Completions";
}

export function CherryStudioImportModal(props: CherryStudioImportModalProps) {
  const {
    initialType,
    response,
    importing,
    scanning,
    dataPath,
    isExisting,
    onChooseDataDirectory,
    onResetDataDirectory,
    onClose,
    onConfirm,
  } = props;
  const candidates = response.providers;
  const resolvedDataPath = dataPath ?? response.dataPath ?? "";
  const [pathDialogOpen, setPathDialogOpen] = useState(false);
  const hasSyncableItems = useMemo(
    () => candidates.some((item) => item.enabled && item.importable),
    [candidates],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [showAll, setShowAll] = useState(!hasSyncableItems);
  const [activeType, setActiveType] = useState<ProviderId>(initialType);

  const visibleItems = showAll
    ? candidates
    : candidates.filter((item) => item.enabled && item.importable);
  // All provider types in one modal, the tab the user came from leading.
  const groupOrder = [initialType, ...PROVIDER_ORDER.filter((type) => type !== initialType)];
  const groups = groupOrder
    .map((type) => ({
      type,
      items: visibleItems.filter((item) => item.providerType === type),
    }))
    .filter((group) => group.items.length > 0);
  // The active tab may lose all its items when the filter toggles — fall back
  // to the first group that still has some.
  const activeGroup = groups.find((group) => group.type === activeType) ?? groups[0];
  const activeItems = activeGroup?.items ?? [];
  const selectedItems = candidates.filter((item) => selected.has(itemKey(item)) && item.importable);

  function toggleItem(item: CherryProviderImportItem) {
    if (!item.importable || importing) return;
    setSelected((current) => {
      const next = new Set(current);
      const key = itemKey(item);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectActive() {
    setSelected((current) => {
      const next = new Set(current);
      for (const item of activeItems) {
        if (item.importable) next.add(itemKey(item));
      }
      return next;
    });
  }

  function clearActive() {
    setSelected((current) => {
      const next = new Set(current);
      for (const item of activeItems) next.delete(itemKey(item));
      return next;
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !importing && onClose()}>
      <DialogContent
        className="flex h-[min(35rem,88dvh)] max-w-2xl flex-col p-0"
        closeDisabled={importing}
        closeLabel="关闭"
        showCloseButton
      >
        <DialogHeader className="flex-row items-start gap-4 px-6">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base leading-normal">从 Cherry Studio 同步</DialogTitle>
            <DialogDescription className="mt-1 text-xs">
              仅同步 Base URL 和 API Key，模型由 LiveAgent 获取并激活；左侧切换供应商类型
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground"
            onClick={() => setPathDialogOpen(true)}
            disabled={importing}
            title="Cherry Studio 数据目录设置"
            aria-label="Cherry Studio 数据目录设置"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <DialogSubheader className="flex flex-wrap items-center justify-between gap-3 bg-muted/20 px-6 py-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(event) => setShowAll(event.currentTarget.checked)}
              disabled={importing}
            />
            显示禁用或不兼容配置
          </label>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 rounded-lg px-2.5 text-xs"
              onClick={selectActive}
              disabled={importing}
            >
              全选可用项
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 rounded-lg px-2.5 text-xs text-muted-foreground"
              onClick={clearActive}
              disabled={importing}
            >
              清空
            </Button>
          </div>
        </DialogSubheader>

        <DialogBody className="flex overflow-hidden p-0">
          {groups.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-6 py-10 text-center text-sm text-muted-foreground">
              没有可同步的 Cherry Studio 聊天供应商
            </div>
          ) : (
            <>
              <div className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r bg-muted/30 p-2">
                {groups.map((group) => {
                  const groupSelected = group.items.filter(
                    (item) => item.importable && selected.has(itemKey(item)),
                  ).length;
                  const active = group.type === activeGroup?.type;
                  return (
                    <button
                      key={group.type}
                      type="button"
                      onClick={() => setActiveType(group.type)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
                        active
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                    >
                      <span className="flex w-5 shrink-0 items-center justify-center text-base">
                        <ProviderTypeIcon type={group.type} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {PROVIDER_LABELS[group.type]}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {group.items.length} 项配置
                        </span>
                      </span>
                      {groupSelected > 0 ? (
                        <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                          {groupSelected}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <div className="space-y-2">
                  {activeItems.map((item) => {
                    const checked = selected.has(itemKey(item));
                    const existing = isExisting(item);
                    return (
                      <button
                        key={itemKey(item)}
                        type="button"
                        className={cn(
                          "flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
                          item.importable
                            ? checked
                              ? "border-primary/45 bg-primary/[0.06]"
                              : "hover:bg-accent/40"
                            : "cursor-not-allowed bg-muted/25 opacity-65",
                        )}
                        onClick={() => toggleItem(item)}
                        disabled={!item.importable || importing}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                            checked && item.importable
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-muted-foreground/40",
                          )}
                        >
                          {checked && item.importable ? <Check className="h-3 w-3" /> : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <strong className="text-sm font-medium">{item.name}</strong>
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {itemProtocolLabel(item)}
                            </span>
                            {existing ? (
                              <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-600 dark:text-blue-300">
                                将更新
                              </span>
                            ) : null}
                            {!item.enabled ? (
                              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                                Cherry 中已禁用
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-1 block truncate text-xs text-muted-foreground">
                            {item.baseUrl || "未配置 Base URL"}
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {item.apiKeyCount > 0 ? "密钥已配置" : "无可迁移密钥"}
                            {item.excludedModelCount > 0
                              ? ` · Cherry 中识别到 ${item.excludedModelCount} 个非聊天模型`
                              : ""}
                          </span>
                          {item.reason ? (
                            <span className="mt-1.5 block text-xs text-destructive">
                              {item.reason}
                            </span>
                          ) : item.warning ? (
                            <span className="mt-1.5 block text-xs text-amber-700 dark:text-amber-300">
                              {item.warning}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </DialogBody>

        <DialogFooter className="bg-background px-6 min-[821px]:justify-between">
          <div className="text-xs text-muted-foreground">
            已选择 {selectedItems.length} 个供应商配置
          </div>
          <DialogActions>
            <Button variant="outline" onClick={onClose} disabled={importing}>
              取消
            </Button>
            <Button
              className="min-w-32 gap-2"
              onClick={() => onConfirm(selectedItems)}
              disabled={importing || selectedItems.length === 0}
            >
              {importing ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
              {importing ? "正在同步…" : `同步 ${selectedItems.length} 个`}
            </Button>
          </DialogActions>
        </DialogFooter>
        <Dialog open={pathDialogOpen} onOpenChange={setPathDialogOpen}>
          <DialogContent
            className="max-w-md p-0"
            closeDisabled={scanning || importing}
            closeLabel="关闭"
            showCloseButton
          >
            <DialogHeader>
              <DialogTitle className="text-sm leading-normal">Cherry Studio 数据目录</DialogTitle>
              <DialogDescription className="text-xs">
                {dataPath
                  ? "正在使用手动指定的目录"
                  : "LiveAgent 会自动读取 Cherry Studio 的数据目录设置"}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={resolvedDataPath}
                  placeholder={scanning ? "正在检测…" : "未检测到数据目录"}
                  className="h-9 min-w-0 flex-1 text-xs"
                  title={resolvedDataPath}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  disabled={scanning || importing}
                  onClick={onChooseDataDirectory}
                  title="选择数据目录"
                  aria-label="选择 Cherry Studio 数据目录"
                >
                  {scanning ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <FolderOpen className="h-4 w-4" />
                  )}
                </Button>
              </div>
              {dataPath ? (
                <div className="mt-4 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>手动指定</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={scanning || importing}
                    onClick={onResetDataDirectory}
                  >
                    恢复自动检测
                  </Button>
                </div>
              ) : null}
            </DialogBody>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
