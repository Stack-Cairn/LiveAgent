// "编辑模型"抽屉里的"目录信息"面板（设计文档 6.6）：只读展示目录命中的分区与
// 条目、快照日期、系列、日期、状态、输入 / 输出模态、原始能力位与限额三项。
// 未命中时说明能力与限额按启发式，可手动覆盖。条目详情本身抽成 CatalogEntryDetails
// （只吃 CatalogModelEntry + 分区），"模型目录"浏览抽屉展开一行时复用同一份。

import {
  AudioLines,
  FileText,
  type IconComponent,
  ImageIcon,
  MessageSquareText,
  Video,
} from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ResolvedModelCatalogInfo } from "@liveagent/ui/lib/models/modelCapabilities";
import {
  type CatalogModality,
  type CatalogModelEntry,
  type CatalogProviderId,
  MODEL_CATALOG_SNAPSHOT_DATE,
} from "@liveagent/ui/lib/models/modelCatalog";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { formatTokenCount } from "@liveagent/ui/pages/settings/providerUtils";
import type { ReactNode } from "react";
import { DrawerGroupLabel } from "../ProviderPresentation";
import { Chip, StateChip } from "./providerChips";

export const MODALITY_ICONS: Record<CatalogModality, IconComponent> = {
  text: MessageSquareText,
  image: ImageIcon,
  pdf: FileText,
  audio: AudioLines,
  video: Video,
};

export const CATALOG_FLAGS = [
  "toolCall",
  "structuredOutput",
  "attachment",
  "temperature",
  "interleaved",
] as const;

/** 标签列与值列按 22px 芯片行高对齐：文本行同样撑到 22px，两列基线一致。 */
function Row(props: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="flex min-h-[22px] items-center text-muted-foreground">{props.label}</span>
      <span className="flex min-h-[22px] min-w-0 flex-wrap items-center gap-1.5">
        {props.children}
      </span>
    </>
  );
}

export function ModalityChips(props: {
  modalities: readonly CatalogModality[] | undefined;
  className?: string;
}) {
  const { modalities, className } = props;
  const { t } = useLocale();
  if (!modalities) {
    return (
      <span className="text-muted-foreground/70">{t("settings.modelCatalogUnpublished")}</span>
    );
  }
  return (
    <>
      {modalities.map((modality) => {
        const Icon = MODALITY_ICONS[modality];
        return (
          <Chip key={modality} className={className}>
            <Icon className="h-3 w-3" />
            {t(`settings.modelModality.${modality}`)}
          </Chip>
        );
      })}
    </>
  );
}

export function CatalogStatusChip(props: { entry: CatalogModelEntry }) {
  const { t } = useLocale();
  const status = props.entry.status;
  if (status === "deprecated") {
    return <Chip tone="bad">{t("settings.modelCatalogStatus.deprecated")}</Chip>;
  }
  if (status === "beta") return <Chip tone="warn">{t("settings.modelCatalogStatus.beta")}</Chip>;
  return <Chip tone="ok">{t("settings.modelCatalogStatus.active")}</Chip>;
}

/** 限额一行：上下文 · （最大输入）· 最大输出，中文标签，两处共用同一格式。 */
export function catalogLimitsText(t: (key: string) => string, entry: CatalogModelEntry): string {
  return [
    `${formatTokenCount(entry.contextWindow)} ${t("settings.modelCatalogCtx")}`,
    entry.maxInputTokens
      ? `${formatTokenCount(entry.maxInputTokens)} ${t("settings.modelMaxInputTokens")}`
      : null,
    `${formatTokenCount(entry.maxOutputToken)} ${t("settings.modelCatalogMaxOutput")}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * 单条目录条目的完整只读详情。只依赖条目与分区 id，不感知渠道；
 * matchedId / modelId 仅在从渠道模型跳转过来、命中形态与配置 id 不同时用来提示。
 */
export function CatalogEntryDetails(props: {
  entry: CatalogModelEntry;
  catalogProviderId: CatalogProviderId;
  matchedId?: string;
  modelId?: string;
  className?: string;
}) {
  const { entry, catalogProviderId, matchedId, modelId, className } = props;
  const { t } = useLocale();
  const showMatchedAs =
    matchedId !== undefined && modelId !== undefined && matchedId !== modelId.trim();
  return (
    <div
      className={cn(
        "grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-xl border bg-muted/20 px-3 py-2.5 text-xs",
        className,
      )}
    >
      <Row label={t("settings.modelCatalogEntry")}>
        <span className="break-all font-mono">
          {catalogProviderId} / {entry.id}
        </span>
        {showMatchedAs ? (
          <Chip tone="warn" className="font-mono">
            {t("settings.modelCatalogMatchedAs").replace("{id}", matchedId)}
          </Chip>
        ) : null}
        <span className="text-[10.5px] text-muted-foreground">
          {t("settings.modelCatalogSnapshot")} {MODEL_CATALOG_SNAPSHOT_DATE}
        </span>
      </Row>
      <Row label={t("settings.modelCatalogName")}>
        <span>{entry.name ?? entry.id}</span>
        {entry.family ? (
          <span className="text-muted-foreground">
            · {t("settings.modelCatalogFamily")} <span className="font-mono">{entry.family}</span>
          </span>
        ) : null}
      </Row>
      <Row label={t("settings.modelCatalogStatus")}>
        <CatalogStatusChip entry={entry} />
        {entry.openWeights ? <Chip>{t("settings.modelCatalogOpenWeights")}</Chip> : null}
      </Row>
      <Row label={t("settings.modelCatalogDates")}>
        <span className="tabular-nums text-muted-foreground">
          {[
            entry.releaseDate
              ? t("settings.modelCatalogReleased").replace("{date}", entry.releaseDate)
              : null,
            entry.lastUpdated
              ? t("settings.modelCatalogUpdated").replace("{date}", entry.lastUpdated)
              : null,
            entry.knowledge
              ? t("settings.modelCatalogKnowledge").replace("{date}", entry.knowledge)
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || t("settings.modelCatalogUnpublished")}
        </span>
      </Row>
      <Row label={t("settings.modelCatalogInput")}>
        <ModalityChips modalities={entry.inputModalities} />
      </Row>
      <Row label={t("settings.modelCatalogOutput")}>
        <ModalityChips modalities={["text", ...(entry.outputModalities ?? [])]} />
      </Row>
      <Row label={t("settings.modelCatalogThinking")}>
        {entry.thinking ? (
          <>
            <Chip tone="on">
              {entry.thinking.off
                ? t("settings.modelThinkingCanDisable")
                : t("settings.modelThinkingAlwaysOn")}
            </Chip>
            {entry.thinking.levels.length > 0 ? (
              <span className="text-muted-foreground">
                {entry.thinking.levels.map((level) => t(`settings.reasoning.${level}`)).join(" / ")}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground/70">{t("settings.modelThinkingNone")}</span>
        )}
      </Row>
      <Row label={t("settings.modelCatalogFlags")}>
        {CATALOG_FLAGS.map((flag) => (
          <StateChip
            key={flag}
            state={entry[flag] === true ? "supported" : "unsupported"}
            title={t("settings.modelCapabilitySource.catalog")}
          >
            {t(`settings.modelCatalogFlag.${flag}`)}
          </StateChip>
        ))}
      </Row>
      <Row label={t("settings.modelLimits")}>
        <span className="tabular-nums">{catalogLimitsText(t, entry)}</span>
      </Row>
    </div>
  );
}

export function ModelCatalogInfoPanel(props: {
  info: ResolvedModelCatalogInfo | undefined;
  modelId: string;
  /** 标题右侧的动作插槽（"查看目录"） */
  action?: ReactNode;
}) {
  const { info, modelId, action } = props;
  const { t } = useLocale();
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <DrawerGroupLabel
            label={t("settings.modelCatalogInfo")}
            hint={t("settings.modelCatalogInfoHint")}
          />
        </div>
        {action}
      </div>
      {!info ? (
        <p className="rounded-xl border border-dashed bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
          {t("settings.modelCatalogMiss")}
        </p>
      ) : (
        <CatalogEntryDetails
          entry={info.entry}
          catalogProviderId={info.catalogProviderId}
          matchedId={info.matchedId}
          modelId={modelId}
        />
      )}
    </section>
  );
}
