// 左栏"渠道目录"：搜索框、添加渠道按钮、已配置实例（在前）与未配置渠道（在后）。
// 列表项来自注册表；同一渠道可有多个实例（设计文档 7）。

import type { CustomProvider } from "@liveagent/app/lib/settings";
import { Plus, Search, X } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import { listProviderPresets, type ProviderPreset } from "@liveagent/ui/lib/providers/registry";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type ReactNode, useMemo, useState } from "react";
import { ProviderAvatar, protocolLabel, protocolShortLabel } from "./providerChips";
import {
  type ProviderSelection,
  presetForProvider,
  providerDefaultProtocol,
  providerEnabledProtocols,
  providerKeyReady,
} from "./providerSettingsModel";

type CatalogRow =
  | { kind: "provider"; provider: CustomProvider; preset: ProviderPreset }
  | { kind: "preset"; preset: ProviderPreset };

function rowMatches(row: CatalogRow, query: string): boolean {
  if (!query) return true;
  const haystack =
    row.kind === "provider"
      ? `${row.provider.name} ${row.preset.name} ${row.preset.id} ${row.provider.baseUrl}`
      : `${row.preset.name} ${row.preset.id}`;
  return haystack.toLowerCase().includes(query);
}

export function ProviderCatalogList(props: {
  providers: readonly CustomProvider[];
  selection: ProviderSelection;
  onSelect: (selection: ProviderSelection) => void;
  onAddChannel: () => void;
  /** 添加按钮右侧的宿主扩展（导入等）与高级设置入口 */
  extraActions?: ReactNode;
}) {
  const { providers, selection, onSelect, onAddChannel, extraActions } = props;
  const { t } = useLocale();
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();

  const rows = useMemo<CatalogRow[]>(() => {
    const configured: CatalogRow[] = providers.map((provider) => ({
      kind: "provider",
      provider,
      preset: presetForProvider(provider),
    }));
    const usedPresets = new Set(providers.map((provider) => provider.presetId));
    const pending: CatalogRow[] = listProviderPresets()
      .filter((preset) => !usedPresets.has(preset.id))
      .sort((a, b) => Number(b.native) - Number(a.native) || a.order - b.order)
      .map((preset) => ({ kind: "preset", preset }));
    return [...configured, ...pending].filter((row) => rowMatches(row, query));
  }, [providers, query]);

  return (
    <div className="settings-provider-catalog flex h-full min-h-0 flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          className="h-8 pl-8 pr-8 text-xs shadow-none"
          placeholder={t("settings.channelSearchPlaceholder")}
          aria-label={t("settings.channelSearchPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setSearch(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setSearch("");
          }}
        />
        {search ? (
          <button
            type="button"
            className="absolute right-0 top-0 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setSearch("")}
            title={t("settings.clearModelSearch")}
            aria-label={t("settings.clearModelSearch")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          className="h-8 flex-1 gap-1.5 shadow-none"
          onClick={onAddChannel}
          title={t("settings.channelAdd")}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("settings.channelAdd")}
        </Button>
        {extraActions}
      </div>
      <p className="px-0.5 text-[10.5px] leading-relaxed text-muted-foreground/70">
        {t("settings.channelCatalogHint")}
      </p>
      <div className="settings-provider-catalog-scroll min-h-0 flex-1 overflow-y-auto pr-0.5">
        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
            {t("settings.channelNoMatch")}
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {rows.map((row) => {
              const active =
                row.kind === "provider"
                  ? selection?.kind === "provider" && selection.id === row.provider.id
                  : selection?.kind === "preset" && selection.id === row.preset.id;
              const name = row.kind === "provider" ? row.provider.name : row.preset.name;
              const subtitle =
                row.kind === "provider"
                  ? `${protocolLabel(providerDefaultProtocol(row.provider))}${
                      providerEnabledProtocols(row.provider).length > 1
                        ? ` · ${t("settings.channelMultiEndpoint")}`
                        : ""
                    }`
                  : [
                      t("settings.channelPending"),
                      row.preset.native ? t("settings.channelNative") : null,
                      Object.keys(row.preset.endpoints).length > 0
                        ? Object.keys(row.preset.endpoints)
                            .map((protocol) =>
                              protocolShortLabel(protocol as keyof typeof row.preset.endpoints),
                            )
                            .join(" / ")
                        : t("settings.channelProbeAll"),
                    ]
                      .filter(Boolean)
                      .join(" · ");
              const enabled = row.kind === "provider" && row.provider.enabled !== false;
              // 实心绿点 = 已启用且已配置 Key；灰点 = 已停用；已启用但没填 Key 不打点，
              // 只在副标题里注明（原生五家初始就是这个状态，不用颜色提醒）。
              const keyReady = row.kind === "provider" && providerKeyReady(row.provider);
              const showDot = row.kind === "provider" && (!enabled || keyReady);
              const statusLabel = !enabled
                ? t("settings.providerDisabled")
                : t("settings.providerEnabled");
              const rowSubtitle =
                row.kind === "provider" && enabled && !keyReady
                  ? `${subtitle} · ${t("settings.providerEnabledNoKey")}`
                  : subtitle;
              return (
                <li key={row.kind === "provider" ? `p:${row.provider.id}` : `s:${row.preset.id}`}>
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "group settings-provider-catalog-row flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/40",
                      active && "bg-accent/70 hover:bg-accent/70",
                    )}
                    onClick={() =>
                      onSelect(
                        row.kind === "provider"
                          ? { kind: "provider", id: row.provider.id }
                          : { kind: "preset", id: row.preset.id },
                      )
                    }
                  >
                    <ProviderAvatar preset={row.preset} className="h-7 w-7" />
                    {/* 未配置渠道只弱化文字，logo 保持原色以便辨识。 */}
                    <span
                      className={cn(
                        "min-w-0 flex-1 leading-tight",
                        row.kind === "preset" && "opacity-70 group-hover:opacity-100",
                      )}
                    >
                      <span className="block truncate text-[12.5px] font-medium text-foreground/90">
                        {name}
                      </span>
                      <span className="block truncate text-[10.5px] text-muted-foreground/75">
                        {rowSubtitle}
                      </span>
                    </span>
                    {showDot ? (
                      <span
                        role="img"
                        aria-label={statusLabel}
                        title={statusLabel}
                        className={cn(
                          "h-2 w-2 shrink-0 rounded-full",
                          !enabled ? "bg-muted-foreground/30" : "bg-emerald-500",
                        )}
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
