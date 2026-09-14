// "可用性"分区（设计文档 8）：故障转移按接口家族分组。每个家族一张卡片：
// 启用、备用供应商队列（只列服务该家族且已配置 Key 与地址的其他供应商）、
// 三个阈值。设置本身是全局的，这里只展示当前供应商参与的家族。

import {
  type CustomProvider,
  hasProviderFailoverConfiguration,
  MODEL_FAILOVER_QUEUE_LIMIT,
  PROVIDER_PROTOCOL_FAMILY_LABELS,
  type ProviderFailoverSettings,
  type ProviderId,
  type ProviderProtocolFamily,
  providerFailoverFamilies,
  updateModelFailover,
} from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { X } from "@liveagent/ui/components/IconSet";
import { NumberInput } from "@liveagent/ui/components/ui/number-input";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useVerticalListReorder } from "@liveagent/ui/components/ui/useVerticalListReorder";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { ModelPicker, type ModelPickerOption } from "@liveagent/ui/pages/settings/modelPicker";
import { useEffect, useMemo, useState } from "react";
import { DrawerFieldLabel, DrawerGroupLabel } from "../ProviderPresentation";
import { Chip } from "./providerChips";

const FAMILY_ICON_TYPE: Record<ProviderProtocolFamily, ProviderId> = {
  anthropic: "claude_code",
  openai: "codex",
  gemini: "gemini",
};

function FailoverNumberField(props: {
  label: string;
  ariaLabel: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const { label, ariaLabel, hint, value, min, max, onCommit } = props;
  const [draft, setDraft] = useState<number | null>(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commitDraft(nextValue: number | null) {
    const next = nextValue ?? value;
    setDraft(next);
    if (next !== value) onCommit(next);
  }

  return (
    <div className="space-y-1.5">
      <DrawerFieldLabel label={label} hint={hint} />
      <NumberInput
        aria-label={ariaLabel}
        incrementLabel={`${ariaLabel} +`}
        decrementLabel={`${ariaLabel} -`}
        min={min}
        max={max}
        step={1}
        snapOnStep
        value={draft}
        onValueChange={setDraft}
        onValueCommitted={commitDraft}
        className="h-8 rounded-lg"
        inputClassName="px-2 py-1 text-[12.5px]"
      />
    </div>
  );
}

function FailoverFamilyCard(
  props: SettingsSectionProps & { family: ProviderProtocolFamily; selected: CustomProvider },
) {
  const { settings, setSettings, family, selected } = props;
  const { t } = useLocale();
  const failover = settings.modelFailover[family];
  const familyLabel = PROVIDER_PROTOCOL_FAMILY_LABELS[family];
  const familyProviders = useMemo(
    () =>
      settings.customProviders.filter(
        (item) => item.id !== selected.id && providerFailoverFamilies(item).includes(family),
      ),
    [settings.customProviders, selected.id, family],
  );
  const queueValues = useMemo(() => new Set(failover.queue), [failover.queue]);
  const addableProviders = useMemo(
    () =>
      familyProviders.filter(
        (item) => !queueValues.has(item.id) && hasProviderFailoverConfiguration(item),
      ),
    [familyProviders, queueValues],
  );
  const unavailableProviderCount = useMemo(
    () =>
      familyProviders.filter(
        (item) => !queueValues.has(item.id) && !hasProviderFailoverConfiguration(item),
      ).length,
    [familyProviders, queueValues],
  );
  const unavailableQueuedProviderCount = useMemo(
    () =>
      failover.queue.filter((providerId) => {
        const item = settings.customProviders.find((candidate) => candidate.id === providerId);
        return item ? !hasProviderFailoverConfiguration(item) : false;
      }).length,
    [failover.queue, settings.customProviders],
  );
  const addableProviderOptions = useMemo<ModelPickerOption[]>(
    () =>
      addableProviders.map((provider) => ({
        value: provider.id,
        label: provider.name,
        description: provider.baseUrl,
        providerId: family,
        providerName: familyLabel,
        providerType: FAMILY_ICON_TYPE[family],
      })),
    [addableProviders, family, familyLabel],
  );

  function patchFailover(patch: Partial<ProviderFailoverSettings>) {
    setSettings((prev) => updateModelFailover(prev, family, patch));
  }

  function queueEntryLabel(providerId: string) {
    return settings.customProviders.find((item) => item.id === providerId)?.name ?? providerId;
  }

  function queueEntryDetail(providerId: string) {
    return settings.customProviders.find((item) => item.id === providerId)?.baseUrl ?? "";
  }

  const {
    draggingItemId: draggingQueueId,
    getItemProps: getQueueReorderProps,
    renderDragHandle: renderQueueDragHandle,
    scrollContainerRef: queueListRef,
  } = useVerticalListReorder({
    itemIds: failover.queue,
    canReorder: true,
    reorderLabel: t("settings.reorderProvider"),
    reorderHint: t("settings.reorderVerticalHint"),
    disabledHint: t("settings.reorderNeedsTwoItems"),
    onReorder: (nextIds) => patchFailover({ queue: nextIds }),
  });

  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-medium">
          {t("settings.failoverFamilyTitle").replace("{family}", familyLabel)}
        </span>
        <Chip>
          {family === "openai"
            ? "Completions + Responses"
            : family === "anthropic"
              ? "Messages"
              : "generateContent"}
        </Chip>
        {queueValues.has(selected.id) ? (
          <Chip tone="on">{t("settings.failoverInQueue")}</Chip>
        ) : null}
        <span className="flex-1" />
        <span className="text-[11px] text-muted-foreground">{t("settings.enable")}</span>
        <Switch
          size="sm"
          checked={failover.enabled}
          onCheckedChange={(checked) => patchFailover({ enabled: checked === true })}
          aria-label={`${familyLabel} ${t("settings.failoverTitle")}`}
        />
      </div>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
        style={{ gridTemplateRows: failover.enabled ? "1fr" : "0fr" }}
      >
        <div
          className="min-h-0 overflow-hidden"
          inert={!failover.enabled}
          aria-hidden={!failover.enabled}
        >
          <div className="space-y-4 pt-3">
            <div className="space-y-2">
              <DrawerGroupLabel
                label={t("settings.failoverQueueTitle")}
                hint={t("settings.failoverQueueFamilyHint").replace("{family}", familyLabel)}
              />
              {failover.queue.length > 0 ? (
                <div ref={queueListRef} className="space-y-1.5">
                  {failover.queue.map((entry, index) => (
                    <div
                      key={entry}
                      {...getQueueReorderProps(entry)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg border border-foreground/[0.06] bg-background/60 py-1.5 pl-1 pr-1.5 transition-colors",
                        draggingQueueId === entry
                          ? "border-foreground/[0.14] bg-accent shadow-lg"
                          : "hover:border-foreground/[0.12]",
                      )}
                    >
                      {renderQueueDragHandle(entry, queueEntryLabel(entry))}
                      <span className="flex h-5 w-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] font-mono text-[10px] font-semibold text-foreground/55">
                        P{index + 1}
                      </span>
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="block truncate text-[12.5px] font-medium text-foreground/90">
                          {queueEntryLabel(entry)}
                        </span>
                        {queueEntryDetail(entry) ? (
                          <span className="block truncate text-[10.5px] text-muted-foreground/70">
                            {queueEntryDetail(entry)}
                          </span>
                        ) : null}
                      </span>
                      <button
                        type="button"
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive"
                        onClick={() =>
                          patchFailover({ queue: failover.queue.filter((_, i) => i !== index) })
                        }
                        title={t("settings.failoverQueueRemove")}
                        aria-label={`${t("settings.failoverQueueRemove")} ${queueEntryLabel(entry)}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                  {t("settings.failoverQueueEmpty")}
                </div>
              )}
              {failover.queue.length < MODEL_FAILOVER_QUEUE_LIMIT && addableProviders.length > 0 ? (
                <ModelPicker
                  options={addableProviderOptions}
                  value=""
                  onChange={(providerId) => {
                    if (!providerId || queueValues.has(providerId)) return;
                    patchFailover({ queue: [...failover.queue, providerId] });
                  }}
                  placeholder={t("settings.failoverQueueAdd")}
                  ariaLabel={t("settings.failoverQueueAdd")}
                  collapsibleGroups={false}
                  searchPlaceholder={t("settings.failoverQueueSearch")}
                  emptyLabel={t("settings.failoverQueueNoMatch")}
                  triggerClassName="h-8 rounded-lg border-dashed border-foreground/[0.13] bg-transparent py-0 text-xs text-muted-foreground shadow-none transition-colors hover:border-foreground/[0.24] hover:bg-foreground/[0.02]"
                />
              ) : null}
              {unavailableProviderCount > 0 ? (
                <p className="text-[10.5px] leading-relaxed text-amber-700/90 dark:text-amber-300/90">
                  {t("settings.failoverQueueUnavailableCandidates").replace(
                    "{count}",
                    String(unavailableProviderCount),
                  )}
                </p>
              ) : null}
              {unavailableQueuedProviderCount > 0 ? (
                <p className="text-[10.5px] leading-relaxed text-amber-700/90 dark:text-amber-300/90">
                  {t("settings.failoverQueueUnavailableExisting").replace(
                    "{count}",
                    String(unavailableQueuedProviderCount),
                  )}
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <DrawerGroupLabel label={t("settings.failoverParamsTitle")} />
              <div className="grid grid-cols-3 gap-2 max-[720px]:grid-cols-1">
                <FailoverNumberField
                  label={t("settings.failoverMaxSwitchesShort")}
                  ariaLabel={`${familyLabel} ${t("settings.failoverMaxSwitches")}`}
                  hint={t("settings.failoverMaxSwitchesHint")}
                  value={failover.maxSwitches}
                  min={1}
                  max={10}
                  onCommit={(value) => patchFailover({ maxSwitches: value })}
                />
                <FailoverNumberField
                  label={t("settings.failoverFailureThresholdShort")}
                  ariaLabel={`${familyLabel} ${t("settings.failoverFailureThreshold")}`}
                  hint={t("settings.failoverFailureThresholdHint")}
                  value={failover.failureThreshold}
                  min={1}
                  max={10}
                  onCommit={(value) => patchFailover({ failureThreshold: value })}
                />
                <FailoverNumberField
                  label={t("settings.failoverCooldownSecondsShort")}
                  ariaLabel={`${familyLabel} ${t("settings.failoverCooldownSeconds")}`}
                  hint={t("settings.failoverCooldownSecondsHint")}
                  value={failover.cooldownSeconds}
                  min={5}
                  max={3600}
                  onCommit={(value) => patchFailover({ cooldownSeconds: value })}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ProviderFailoverSection(
  props: SettingsSectionProps & { provider: CustomProvider },
) {
  const { settings, setSettings, provider } = props;
  const families = providerFailoverFamilies(provider);
  return (
    <div className="space-y-2">
      {families.map((family) => (
        <FailoverFamilyCard
          key={family}
          settings={settings}
          setSettings={setSettings}
          family={family}
          selected={provider}
        />
      ))}
    </div>
  );
}
