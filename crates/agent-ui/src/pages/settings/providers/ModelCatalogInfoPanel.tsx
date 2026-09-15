// "编辑模型"抽屉里的"目录信息"面板（设计文档 6.6）：只读展示目录命中的分区与
// 条目、快照日期、系列、日期、状态、输入 / 输出模态、原始能力位与限额三项。
// 未命中时说明能力与限额按启发式，可手动覆盖。

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
  MODEL_CATALOG_SNAPSHOT_DATE,
} from "@liveagent/ui/lib/models/modelCatalog";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { formatTokenCount } from "@liveagent/ui/pages/settings/providerUtils";
import type { ReactNode } from "react";
import { DrawerGroupLabel } from "../ProviderPresentation";
import { Chip } from "./providerChips";

const MODALITY_ICONS: Record<CatalogModality, IconComponent> = {
  text: MessageSquareText,
  image: ImageIcon,
  pdf: FileText,
  audio: AudioLines,
  video: Video,
};

const CATALOG_FLAGS = [
  "toolCall",
  "structuredOutput",
  "attachment",
  "temperature",
  "interleaved",
] as const;

function Row(props: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="text-muted-foreground">{props.label}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">{props.children}</span>
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

export function ModelCatalogInfoPanel(props: {
  info: ResolvedModelCatalogInfo | undefined;
  modelId: string;
}) {
  const { info, modelId } = props;
  const { t } = useLocale();
  return (
    <section className="space-y-2">
      <DrawerGroupLabel
        label={t("settings.modelCatalogInfo")}
        hint={t("settings.modelCatalogInfoHint")}
      />
      {!info ? (
        <p className="rounded-xl border border-dashed bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
          {t("settings.modelCatalogMiss")}
        </p>
      ) : (
        <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-xl border bg-muted/20 px-3 py-2.5 text-xs">
          <Row label={t("settings.modelCatalogEntry")}>
            <span className="break-all font-mono">
              {info.catalogProviderId} / {info.entry.id}
            </span>
            {info.matchedId !== modelId.trim() ? (
              <Chip tone="warn" className="font-mono">
                {t("settings.modelCatalogMatchedAs").replace("{id}", info.matchedId)}
              </Chip>
            ) : null}
            <span className="text-[10.5px] text-muted-foreground">
              {t("settings.modelCatalogSnapshot")} {MODEL_CATALOG_SNAPSHOT_DATE}
            </span>
          </Row>
          <Row label={t("settings.modelCatalogName")}>
            <span>{info.entry.name ?? info.entry.id}</span>
            {info.entry.family ? (
              <span className="text-muted-foreground">
                · {t("settings.modelCatalogFamily")}{" "}
                <span className="font-mono">{info.entry.family}</span>
              </span>
            ) : null}
          </Row>
          <Row label={t("settings.modelCatalogStatus")}>
            {info.entry.status === "deprecated" ? (
              <Chip tone="bad">{t("settings.modelCatalogStatus.deprecated")}</Chip>
            ) : info.entry.status === "beta" ? (
              <Chip tone="warn">{t("settings.modelCatalogStatus.beta")}</Chip>
            ) : (
              <Chip tone="ok">{t("settings.modelCatalogStatus.active")}</Chip>
            )}
            {info.entry.openWeights ? <Chip>{t("settings.modelCatalogOpenWeights")}</Chip> : null}
          </Row>
          <Row label={t("settings.modelCatalogDates")}>
            <span className="tabular-nums text-muted-foreground">
              {[
                info.entry.releaseDate
                  ? t("settings.modelCatalogReleased").replace("{date}", info.entry.releaseDate)
                  : null,
                info.entry.lastUpdated
                  ? t("settings.modelCatalogUpdated").replace("{date}", info.entry.lastUpdated)
                  : null,
                info.entry.knowledge
                  ? t("settings.modelCatalogKnowledge").replace("{date}", info.entry.knowledge)
                  : null,
              ]
                .filter(Boolean)
                .join(" · ") || t("settings.modelCatalogUnpublished")}
            </span>
          </Row>
          <Row label={t("settings.modelCatalogInput")}>
            <ModalityChips modalities={info.entry.inputModalities} />
          </Row>
          <Row label={t("settings.modelCatalogOutput")}>
            <ModalityChips modalities={["text", ...(info.entry.outputModalities ?? [])]} />
          </Row>
          <Row label={t("settings.modelCatalogFlags")}>
            {CATALOG_FLAGS.map((flag) => {
              const on = info.entry[flag] === true;
              return (
                <Chip
                  key={flag}
                  tone={on ? "ok" : "default"}
                  strike={!on}
                  className={cn(!on && "opacity-60")}
                >
                  {t(`settings.modelCatalogFlag.${flag}`)}
                </Chip>
              );
            })}
          </Row>
          <Row label={t("settings.modelLimits")}>
            <span className="tabular-nums">
              {formatTokenCount(info.entry.contextWindow)} {t("settings.modelCatalogCtx")} ·{" "}
              {info.entry.maxInputTokens
                ? `${formatTokenCount(info.entry.maxInputTokens)} ${t("settings.modelMaxInputTokens")} · `
                : ""}
              {formatTokenCount(info.entry.maxOutputToken)} {t("settings.modelCatalogMaxOutput")}
            </span>
          </Row>
        </div>
      )}
    </section>
  );
}
