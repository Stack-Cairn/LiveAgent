import {
  ProviderCopyConfigButton,
  ProviderSettingsExtension,
} from "@liveagent/adapters/providerSettings";
import {
  getProviderUsageCardDisplay,
  type ProviderUsageState,
  useProviderUsage,
  useUsageNowTicker,
} from "@liveagent/app/lib/providers/usageQuery";
import {
  type CustomProvider,
  hasProviderFailoverConfiguration,
  MODEL_FAILOVER_QUEUE_LIMIT,
  type ProviderFailoverSettings,
  type ProviderId,
  type SelectedModel,
  updateCustomProviders,
  updateCustomSettings,
  updateModelFailover,
} from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import {
  Activity,
  ChevronDown,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Shield,
  Trash2,
  WandSparkles,
  Waypoints,
  X,
} from "@liveagent/ui/components/IconSet";
import { SettingsNotice } from "@liveagent/ui/components/settings/SettingsNotice";
import { Button } from "@liveagent/ui/components/ui/button";
import { NumberInput } from "@liveagent/ui/components/ui/number-input";
import { SegmentedSlider } from "@liveagent/ui/components/ui/segmented-slider";
import { Sheet, SheetContent, SheetTitle } from "@liveagent/ui/components/ui/sheet";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useVerticalListReorder } from "@liveagent/ui/components/ui/useVerticalListReorder";
import { useLocale } from "@liveagent/ui/i18n/index";
import { buildModelOptions } from "@liveagent/ui/lib/models/modelOptions";
import { parseModelValue, toModelValue } from "@liveagent/ui/lib/models/modelValue";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { ModelPicker, type ModelPickerOption } from "@liveagent/ui/pages/settings/modelPicker";
import { ConfirmDeletePopover } from "@liveagent/ui/pages/settings/shared";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ProviderModal } from "./ProviderModal";
import {
  DrawerFieldLabel,
  DrawerGroupLabel,
  DrawerSectionHeader,
  getProviderLabel,
  itemsByIdOrder,
  PROVIDER_TABS,
  ProviderBrandIcon,
  UsagePlanLine,
  usageRelativeTimeText,
} from "./ProviderPresentation";
import { RetryErrorSection } from "./RetryErrorSection";

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
        inputClassName="px-2 py-1 text-xs"
      />
    </div>
  );
}

function FailoverSettingsCard(props: SettingsSectionProps & { providerType: ProviderId }) {
  const { settings, setSettings, providerType } = props;
  const { t } = useLocale();
  const failover = settings.modelFailover[providerType];
  const vendorLabel = getProviderLabel(providerType);
  // Same-vendor guard: only providers of this tab's vendor type are offered,
  // so a Claude queue can never contain a Codex provider (and vice versa).
  // Failover keeps the conversation's model and only switches which provider
  // serves it, so the queue holds providers, not models.
  const vendorProviders = useMemo(
    () => settings.customProviders.filter((provider) => provider.type === providerType),
    [settings.customProviders, providerType],
  );
  const providerById = useMemo(() => {
    const index = new Map<string, CustomProvider>();
    for (const provider of settings.customProviders) {
      if (!index.has(provider.id)) index.set(provider.id, provider);
    }
    return index;
  }, [settings.customProviders]);

  const queueValues = useMemo(() => new Set(failover.queue), [failover.queue]);
  const addableProviders = useMemo(
    () =>
      vendorProviders.filter(
        (provider) => !queueValues.has(provider.id) && hasProviderFailoverConfiguration(provider),
      ),
    [vendorProviders, queueValues],
  );
  const unavailableProviderCount = useMemo(
    () =>
      vendorProviders.filter(
        (provider) => !queueValues.has(provider.id) && !hasProviderFailoverConfiguration(provider),
      ).length,
    [vendorProviders, queueValues],
  );
  const unavailableQueuedProviderCount = useMemo(
    () =>
      failover.queue.filter((providerId) => {
        const provider = providerById.get(providerId);
        return provider ? !hasProviderFailoverConfiguration(provider) : false;
      }).length,
    [failover.queue, providerById],
  );
  const addableProviderOptions = useMemo<ModelPickerOption[]>(
    () =>
      addableProviders.map((provider) => ({
        value: provider.id,
        label: provider.name,
        description: provider.baseUrl,
        // Keep all queue entries under the current vendor group, matching the
        // grouping used by the title/commit model picker.
        providerId: providerType,
        providerName: vendorLabel,
        providerType,
      })),
    [addableProviders, providerType, vendorLabel],
  );

  function patchFailover(patch: Partial<ProviderFailoverSettings>) {
    setSettings((prev) => updateModelFailover(prev, providerType, patch));
  }

  function queueEntryLabel(providerId: string) {
    const provider = providerById.get(providerId);
    return provider?.name ?? providerId;
  }

  function queueEntryDetail(providerId: string) {
    const provider = providerById.get(providerId);
    return provider?.baseUrl ?? "";
  }

  function addQueueEntry(providerId: string) {
    if (!providerId || queueValues.has(providerId)) return;
    patchFailover({ queue: [...failover.queue, providerId] });
  }

  function removeQueueEntry(index: number) {
    patchFailover({ queue: failover.queue.filter((_, i) => i !== index) });
  }

  // Queue priority is reordered by dragging (or arrow keys on the focused
  // handle) instead of per-row up/down buttons.
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
    <section className="py-5">
      <DrawerSectionHeader
        icon={<Shield className="size-3.5" />}
        title={t("settings.failoverTitle")}
        hint={t("settings.failoverToggleHint").replaceAll("{vendor}", vendorLabel)}
        badge={
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.05] px-2 py-0.5",
              "text-tiny font-medium text-foreground/60",
            )}
          >
            <ProviderBrandIcon type={providerType} />
            {vendorLabel}
          </span>
        }
        action={
          <Switch
            checked={failover.enabled}
            onCheckedChange={(checked) => patchFailover({ enabled: checked === true })}
            aria-label={t("settings.failoverTitle")}
          />
        }
      />

      {/* 开关直接控制配置区的展开/收起：关闭时抽屉只留一行分区头。 */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-ui-enter motion-reduce:transition-none"
        style={{ gridTemplateRows: failover.enabled ? "1fr" : "0fr" }}
      >
        <div
          className="min-h-0 overflow-hidden"
          inert={!failover.enabled}
          aria-hidden={!failover.enabled}
        >
          <div className="space-y-5 pt-4">
            <div className="space-y-2">
              <DrawerGroupLabel
                label={t("settings.failoverQueueTitle")}
                hint={t("settings.failoverQueueHint").replaceAll("{vendor}", vendorLabel)}
              />
              {failover.queue.length > 0 ? (
                <div ref={queueListRef} className="space-y-1.5">
                  {failover.queue.map((entry, index) => (
                    <div
                      key={entry}
                      {...getQueueReorderProps(entry)}
                      className={cn(
                        "flex items-center gap-1.5",
                        "rounded-lg border border-foreground/[0.06] bg-background/60",
                        "py-1.5 pl-1 pr-1.5 transition-colors",
                        draggingQueueId === entry
                          ? "border-foreground/[0.14] bg-accent shadow-lg"
                          : "hover:border-foreground/[0.12]",
                      )}
                    >
                      {renderQueueDragHandle(entry, queueEntryLabel(entry))}
                      <span
                        className={cn(
                          "flex h-5 w-6 shrink-0 items-center justify-center",
                          "rounded-md bg-foreground/[0.05] font-mono text-tiny font-semibold text-foreground/55",
                        )}
                      >
                        P{index + 1}
                      </span>
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="block truncate text-xs font-medium text-foreground/90">
                          {queueEntryLabel(entry)}
                        </span>
                        {queueEntryDetail(entry) ? (
                          <span className="block truncate text-tiny text-muted-foreground/70">
                            {queueEntryDetail(entry)}
                          </span>
                        ) : null}
                      </span>
                      <button
                        type="button"
                        className={cn(
                          "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors",
                          "hover:bg-destructive/10 hover:text-destructive",
                        )}
                        onClick={() => removeQueueEntry(index)}
                        title={t("settings.failoverQueueRemove")}
                        aria-label={`${t("settings.failoverQueueRemove")} ${queueEntryLabel(entry)}`}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <SettingsNotice variant="warning">
                  {t("settings.failoverQueueEmpty")}
                </SettingsNotice>
              )}
              {failover.queue.length < MODEL_FAILOVER_QUEUE_LIMIT && addableProviders.length > 0 ? (
                <ModelPicker
                  options={addableProviderOptions}
                  value=""
                  onChange={addQueueEntry}
                  placeholder={t("settings.failoverQueueAdd")}
                  ariaLabel={t("settings.failoverQueueAdd")}
                  collapsibleGroups={false}
                  searchPlaceholder={t("settings.failoverQueueSearch")}
                  emptyLabel={t("settings.failoverQueueNoMatch")}
                  triggerClassName="h-8 rounded-lg border-dashed border-foreground/[0.13] bg-transparent py-0 text-xs text-muted-foreground shadow-none transition-colors hover:border-foreground/[0.24] hover:bg-foreground/[0.02]"
                />
              ) : null}
              {unavailableProviderCount > 0 ? (
                <p className="text-tiny leading-relaxed text-amber-700/90 dark:text-amber-300/90">
                  {t("settings.failoverQueueUnavailableCandidates").replace(
                    "{count}",
                    String(unavailableProviderCount),
                  )}
                </p>
              ) : null}
              {unavailableQueuedProviderCount > 0 ? (
                <p className="text-tiny leading-relaxed text-amber-700/90 dark:text-amber-300/90">
                  {t("settings.failoverQueueUnavailableExisting").replace(
                    "{count}",
                    String(unavailableQueuedProviderCount),
                  )}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <DrawerGroupLabel label={t("settings.failoverParamsTitle")} />
              <div className="grid grid-cols-3 gap-2">
                <FailoverNumberField
                  label={t("settings.failoverMaxSwitchesShort")}
                  ariaLabel={t("settings.failoverMaxSwitches")}
                  hint={t("settings.failoverMaxSwitchesHint")}
                  value={failover.maxSwitches}
                  min={1}
                  max={10}
                  onCommit={(value) => patchFailover({ maxSwitches: value })}
                />
                <FailoverNumberField
                  label={t("settings.failoverFailureThresholdShort")}
                  ariaLabel={t("settings.failoverFailureThreshold")}
                  hint={t("settings.failoverFailureThresholdHint")}
                  value={failover.failureThreshold}
                  min={1}
                  max={10}
                  onCommit={(value) => patchFailover({ failureThreshold: value })}
                />
                <FailoverNumberField
                  label={t("settings.failoverCooldownSecondsShort")}
                  ariaLabel={t("settings.failoverCooldownSeconds")}
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
    </section>
  );
}

function CustomSettingsModelField(props: {
  label: string;
  hint: string;
  followCurrentLabel: string;
  selected: SelectedModel | undefined;
  modelOptions: ModelPickerOption[];
  onChange: (value: string) => void;
}) {
  const { label, hint, followCurrentLabel, selected, modelOptions, onChange } = props;
  const selectedValue = selected ? toModelValue(selected.customProviderId, selected.model) : "";
  // A stored model that is no longer among the active options still shows as
  // selected (same fallback-entry approach as the cron prompt form).
  const options =
    selected && !modelOptions.some((option) => option.value === selectedValue)
      ? [
          ...modelOptions,
          {
            value: selectedValue,
            label: selected.model,
            providerName: selected.customProviderId,
          },
        ]
      : modelOptions;

  return (
    <div className="space-y-1.5">
      <DrawerFieldLabel label={label} hint={hint} />
      <ModelPicker
        options={options}
        value={selectedValue}
        onChange={onChange}
        placeholder={followCurrentLabel}
        noneLabel={followCurrentLabel}
        ariaLabel={label}
        triggerClassName="h-9 rounded-lg border-foreground/10 bg-white/70 text-sm shadow-sm dark:bg-background/40"
      />
    </div>
  );
}

function CustomSettingsDrawer(
  props: SettingsSectionProps & { providerType: ProviderId; onClose: () => void },
) {
  const { settings, setSettings, providerType, onClose } = props;
  const { t } = useLocale();
  const modelOptions = useMemo(() => buildModelOptions(settings), [settings]);
  // 上下文占用展示三档的动态描述：只解释当前选中档，取代原先罗列三档的长段落。
  const contextDisplayModeDesc = {
    statsBar: t("settings.composerContextDisplayStatsBarDesc"),
    both: t("settings.composerContextDisplayBothDesc"),
    ring: t("settings.composerContextDisplayRingDesc"),
  } as const;

  function handleModelSettingChange(
    key: "conversationTitleModel" | "commitMessageModel" | "promptClarifyModel",
    value: string,
  ) {
    // "" comes from the picker's follow-current entry and parses to undefined.
    setSettings((prev) =>
      updateCustomSettings(prev, {
        [key]: parseModelValue(value) ?? undefined,
      }),
    );
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        variant="inset"
        className={cn(
          "max-w-none border-border bg-background",
          "sm:max-w-440px web:max-820:inset-0 web:max-820:size-full web:max-820:max-w-none web:max-820:max-h-none web:max-820:rounded-none web:max-820:border-l-0",
        )}
        closeLabel={t("settings.closeCustomSettings")}
        showCloseButton={false}
      >
        <div className="relative flex items-center gap-3 px-6 pb-4 pt-22px web:max-820:pt-settings-provider-custom-sheet-header-pt">
          <SheetTitle className="min-w-0 flex-1 text-lg leading-tight tracking-tight text-foreground/95">
            {t("settings.customSettings")}
          </SheetTitle>
          <button
            type="button"
            onClick={onClose}
            className={cn(
              "flex size-7 shrink-0 items-center justify-center",
              "rounded-full bg-foreground/[0.06] text-muted-foreground/80 transition-colors hover:bg-foreground/[0.12] hover:text-foreground",
            )}
            title={t("settings.closeCustomSettings")}
            aria-label={t("settings.closeCustomSettings")}
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div
          aria-hidden="true"
          className="relative mx-6 h-px bg-gradient-to-r from-transparent via-foreground/[0.08] to-transparent"
        />

        <div className="relative min-h-0 flex-1 overflow-y-auto px-6 pb-6 web:max-820:pb-settings-provider-custom-sheet-body-pb">
          <div className="divide-y divide-foreground/[0.06]">
            <section className="py-5 first:pt-4">
              <DrawerSectionHeader
                icon={<WandSparkles className="size-3.5" />}
                title={t("settings.customSettingsModelsTitle")}
              />
              <div className="mt-3.5 space-y-3">
                <CustomSettingsModelField
                  label={t("settings.conversationTitleModel")}
                  hint={t("settings.conversationTitleModelHint")}
                  followCurrentLabel={t("settings.conversationTitleModelFollowCurrent")}
                  selected={settings.customSettings.conversationTitleModel}
                  modelOptions={modelOptions}
                  onChange={(value) => handleModelSettingChange("conversationTitleModel", value)}
                />
                <CustomSettingsModelField
                  label={t("settings.commitMessageModel")}
                  hint={t("settings.commitMessageModelHint")}
                  followCurrentLabel={t("settings.conversationTitleModelFollowCurrent")}
                  selected={settings.customSettings.commitMessageModel}
                  modelOptions={modelOptions}
                  onChange={(value) => handleModelSettingChange("commitMessageModel", value)}
                />
                {modelOptions.length === 0 ? (
                  <SettingsNotice variant="warning">
                    {t("settings.customSettingsModelEmpty")}
                  </SettingsNotice>
                ) : null}
              </div>
            </section>
            {/* 澄清提示词（composer clarify）：总开关直接控制两端输入框魔杖按钮
                的显隐；展开区选澄清对话用的模型，未选跟随当前对话模型（与
                commitMessageModel 同一回退契约）。开关-展开模式同 failover。 */}
            <section className="py-5">
              <DrawerSectionHeader
                icon={<WandSparkles className="size-3.5" />}
                title={t("settings.promptClarifyTitle")}
                hint={t("settings.promptClarifyToggleHint")}
                action={
                  <Switch
                    checked={settings.customSettings.promptClarifyEnabled}
                    onCheckedChange={(checked) =>
                      setSettings((prev) =>
                        updateCustomSettings(prev, { promptClarifyEnabled: checked === true }),
                      )
                    }
                    aria-label={t("settings.promptClarifyTitle")}
                  />
                }
              />
              <div
                className="grid transition-[grid-template-rows] duration-300 ease-ui-enter motion-reduce:transition-none"
                style={{
                  gridTemplateRows: settings.customSettings.promptClarifyEnabled ? "1fr" : "0fr",
                }}
              >
                <div
                  className="min-h-0 overflow-hidden"
                  inert={!settings.customSettings.promptClarifyEnabled}
                  aria-hidden={!settings.customSettings.promptClarifyEnabled}
                >
                  <div className="space-y-3 pt-3.5">
                    <CustomSettingsModelField
                      label={t("settings.promptClarifyModel")}
                      hint={t("settings.promptClarifyModelHint")}
                      followCurrentLabel={t("settings.conversationTitleModelFollowCurrent")}
                      selected={settings.customSettings.promptClarifyModel}
                      modelOptions={modelOptions}
                      onChange={(value) => handleModelSettingChange("promptClarifyModel", value)}
                    />
                  </div>
                </div>
              </div>
            </section>
            {/* Composer 上下文占用展示样式（三档滑块，docs/design/composer-context-stats-bar.md §4.7）：
                从左到右 状态栏 / 都显示 / 用量环，对应 statsBar / both / ring。
                通用说明收进分区头的提示气泡，滑块下方只保留当前档位的一行动态描述。 */}
            <section className="py-5">
              <DrawerSectionHeader
                icon={<Activity className="size-3.5" />}
                title={t("settings.composerContextDisplay")}
                hint={t("settings.composerContextDisplayHint")}
              />
              <div className="mt-3.5 space-y-2">
                <SegmentedSlider
                  aria-label={t("settings.composerContextDisplay")}
                  className="w-full"
                  value={settings.customSettings.composerContextDisplay}
                  options={[
                    { value: "statsBar", label: t("settings.composerContextDisplayStatsBar") },
                    { value: "both", label: t("settings.composerContextDisplayBoth") },
                    { value: "ring", label: t("settings.composerContextDisplayRing") },
                  ]}
                  onValueChange={(mode) =>
                    setSettings((prev) =>
                      updateCustomSettings(prev, { composerContextDisplay: mode }),
                    )
                  }
                />
                <p className="text-xs leading-relaxed text-muted-foreground/70">
                  {contextDisplayModeDesc[settings.customSettings.composerContextDisplay]}
                </p>
              </div>
            </section>
            <FailoverSettingsCard
              settings={settings}
              setSettings={setSettings}
              providerType={providerType}
            />
            <RetryErrorSection settings={settings} setSettings={setSettings} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

const PROVIDER_ACTION_CLASS =
  "settings-provider-action inline-flex h-full min-w-0 items-center justify-center gap-6px rounded-[calc(var(--radius)-var(--radius-4px))] border-0 bg-transparent px-10px py-0 text-xs font-medium text-muted-foreground shadow-none transition-[background-color,color,box-shadow] duration-150 ease-default has-hover:hover:bg-background/72 has-hover:hover:text-foreground data-[open]:bg-background data-[open]:text-foreground data-[open]:shadow-[0_var(--spacing-1px)_var(--spacing-2px)_hsl(var(--foreground)/0.06)] data-[popup-open]:bg-background data-[popup-open]:text-foreground data-[popup-open]:shadow-[0_var(--spacing-1px)_var(--spacing-2px)_hsl(var(--foreground)/0.06)] focus-visible:z-1 focus-visible:outline-none focus-visible:shadow-[0_0_0_var(--spacing-2px)_hsl(var(--background)),0_0_0_var(--spacing-4px)_hsl(var(--ring))] motion-reduce:transition-none max-[860px]:min-w-32px max-[860px]:px-8px";

function ProviderActionGroup(props: {
  activeTab: ProviderId;
  settings: SettingsSectionProps["settings"];
  setSettings: SettingsSectionProps["setSettings"];
  customSettingsOpen: boolean;
  onAdd: () => void;
  onOpenCustomSettings: () => void;
}) {
  const { t } = useLocale();
  const { activeTab, settings, setSettings, customSettingsOpen, onAdd, onOpenCustomSettings } =
    props;

  return (
    <fieldset
      className={cn(
        "inline-flex h-36px min-w-0 shrink-0 items-stretch gap-1px",
        "rounded-(--radius) border-0 bg-muted p-4px text-muted-foreground",
        "[&>:not(.settings-provider-action):not(.settings-provider-action-slot)]:contents max-640:w-full max-640:flex-none max-640:[&>.settings-provider-action]:flex-1 max-640:[&>.settings-provider-action-slot]:flex-1",
      )}
      aria-label={t("settings.providerActionGroup")}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          PROVIDER_ACTION_CLASS,
          "bg-primary text-primary-foreground shadow-[0_var(--spacing-1px)_var(--spacing-2px)_hsl(var(--primary)/0.28)] has-hover:hover:bg-primary/90 has-hover:hover:text-primary-foreground",
        )}
        onClick={onAdd}
        title={t("settings.addProvider")}
        aria-label={t("settings.addProvider")}
      >
        <Plus className="size-3.5" />
        <span className="max-[860px]:hidden max-640:inline">{t("settings.addProviderShort")}</span>
      </Button>
      <ProviderSettingsExtension
        activeTab={activeTab}
        settings={settings}
        setSettings={setSettings}
        triggerClassName={PROVIDER_ACTION_CLASS}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          PROVIDER_ACTION_CLASS,
          customSettingsOpen &&
            "bg-background text-foreground shadow-[0_var(--spacing-1px)_var(--spacing-2px)_hsl(var(--foreground)/0.06)]",
        )}
        onClick={onOpenCustomSettings}
        title={t("settings.openCustomSettings")}
        aria-label={t("settings.openCustomSettings")}
      >
        <Settings className="size-3.5" />
        <span className="max-[860px]:hidden max-640:inline">
          {t("settings.providerActionSettings")}
        </span>
      </Button>
    </fieldset>
  );
}

function ProviderCardRow(props: {
  provider: CustomProvider;
  type: ProviderId;
  usageDisplay: ReturnType<typeof getProviderUsageCardDisplay>;
  refreshing: boolean;
  usageExpanded: boolean;
  onToggleUsageExpanded: () => void;
  dragging: boolean;
  reorderProps: { "data-vertical-reorder-id": string; style?: CSSProperties };
  dragHandle: ReactNode;
  onEdit: () => void;
  onDelete: () => void;
  onRefreshUsage: () => void;
}) {
  const { t } = useLocale();
  const {
    provider,
    type,
    usageDisplay,
    refreshing,
    usageExpanded,
    onToggleUsageExpanded,
    dragging,
    reorderProps,
    dragHandle,
    onEdit,
    onDelete,
    onRefreshUsage,
  } = props;
  // 收起态只展示首个套餐,其余套餐放入可动画折叠容器;配合下方等高骨架,
  // 卡片在"加载→出数"全程保持两行高度,不产生布局跳动。
  const [firstUsagePlan, ...extraUsagePlans] = usageDisplay.plans;

  return (
    <div
      {...reorderProps}
      className={cn(
        "settings-card-row group flex items-center gap-3",
        "rounded-xl border bg-card px-4 py-3 transition-colors",
        "hover:bg-accent/30 web:max-520:grid web:max-520:grid-cols-settings-provider-card-row web:max-520:items-center! web:max-520:flex-nowrap!",
        dragging && "bg-accent shadow-lg",
      )}
    >
      {dragHandle}
      <div className="flex w-5 shrink-0 items-center justify-center text-lg text-foreground">
        <ProviderBrandIcon type={type} />
      </div>
      <div className="min-w-0 flex-1 web:max-520:min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{provider.name}</span>
          {provider.useSystemProxy ? (
            <span
              className="shrink-0 text-blue-500 dark:text-blue-400"
              title={t("settings.providerUseSystemProxy")}
            >
              <Waypoints className="size-3" />
            </span>
          ) : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {provider.baseUrl || t("settings.noBaseUrl")} {" · "}
          {provider.activeModels.length} {t("settings.activeModels")}
        </div>
        {usageDisplay.show ? (
          <div
            className="mt-1 min-w-0 text-xs text-muted-foreground"
            aria-busy={usageDisplay.loading}
          >
            {/* 主行与元信息行都固定 min-h-4(= text-xs 行高):加载时
                骨架等高占位,结果到达后原位替换,卡片高度全程稳定。 */}
            <div className="flex min-h-4 min-w-0 items-center">
              {firstUsagePlan ? (
                <span className="flex min-w-0">
                  <UsagePlanLine plan={firstUsagePlan} />
                </span>
              ) : usageDisplay.loading ? (
                <span
                  aria-hidden="true"
                  className="h-2 w-32 max-w-full animate-pulse rounded-full bg-foreground/[0.08] motion-reduce:animate-none"
                />
              ) : (
                <span className={cn("truncate", usageDisplay.error && "text-destructive")}>
                  {usageDisplay.error ?? t("settings.providerUsageNoData")}
                </span>
              )}
            </div>
            {extraUsagePlans.length > 0 ? (
              <div
                className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
                style={{ gridTemplateRows: usageExpanded ? "1fr" : "0fr" }}
                aria-hidden={!usageExpanded}
              >
                <div className="min-h-0 overflow-hidden">
                  {extraUsagePlans.map((plan, index) => (
                    <div
                      key={`${plan.title.kind === "text" ? plan.title.text : plan.title.kind}:${
                        // biome-ignore lint/suspicious/noArrayIndexKey: 套餐无稳定 id,索引即位置语义
                        index
                      }`}
                      className="flex min-h-4 min-w-0 items-center pt-0.5"
                    >
                      <UsagePlanLine plan={plan} />
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="mt-0.5 flex min-h-4 min-w-0 items-center">
              {usageDisplay.loading ? (
                <span
                  aria-hidden="true"
                  className="h-2 w-16 animate-pulse rounded-full bg-foreground/[0.06] motion-reduce:animate-none"
                />
              ) : (
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  {extraUsagePlans.length > 0 ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-0.5 text-primary hover:underline"
                      aria-expanded={usageExpanded}
                      onClick={onToggleUsageExpanded}
                    >
                      {usageExpanded
                        ? t("settings.providerUsageCollapse")
                        : t("settings.providerUsageMorePlans").replace(
                            "{count}",
                            String(extraUsagePlans.length),
                          )}
                      <ChevronDown
                        className={cn(
                          "size-3 transition-transform duration-200 motion-reduce:transition-none",
                          usageExpanded && "rotate-180",
                        )}
                      />
                    </button>
                  ) : null}
                  {usageDisplay.isStale ? (
                    <span title={t("settings.providerUsageStaleTitle")}>
                      {t("settings.providerUsageStale")}
                    </span>
                  ) : null}
                  {usageDisplay.error && firstUsagePlan ? (
                    <span className="min-w-0 truncate text-destructive">{usageDisplay.error}</span>
                  ) : null}
                  {usageDisplay.updatedAt ? (
                    <time>{usageRelativeTimeText(t, usageDisplay.updatedAt)}</time>
                  ) : null}
                </span>
              )}
            </div>
          </div>
        ) : null}
      </div>
      <div
        className={cn(
          "settings-card-actions settings-hover-actions flex items-center gap-1 opacity-0 transition-opacity",
          "focus-within:opacity-100 group-hover:opacity-100",
        )}
      >
        <ProviderCopyConfigButton provider={provider} />
        {usageDisplay.show ? (
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            disabled={usageDisplay.refreshDisabled}
            onClick={onRefreshUsage}
            title={t("settings.providerUsageRefresh")}
            aria-label={t("settings.providerUsageRefresh")}
          >
            <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          onClick={onEdit}
          title={t("settings.edit")}
        >
          <Pencil className="size-3.5" />
        </Button>
        <ConfirmDeletePopover name={provider.name} onConfirm={onDelete}>
          {(open) => (
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-destructive"
              onClick={open}
              title={t("settings.delete")}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </ConfirmDeletePopover>
      </div>
    </div>
  );
}

function ProviderList(props: {
  type: ProviderId;
  providers: CustomProvider[];
  onAdd: () => void;
  onEdit: (provider: CustomProvider) => void;
  onDelete: (id: string) => void;
  onReorder: (type: ProviderId, nextIds: string[]) => void;
  usageByProvider: ProviderUsageState;
  refreshingProviderIds: ReadonlySet<string>;
  onRefreshUsage: (providerId: string) => void;
}) {
  const { t } = useLocale();
  const {
    type,
    providers,
    onAdd,
    onEdit,
    onDelete,
    onReorder,
    usageByProvider,
    refreshingProviderIds,
    onRefreshUsage,
  } = props;
  const filtered = providers.filter((provider) => provider.type === type);
  // 30s ticker 驱动"N 分钟前"相对时间;多套餐行的展开态是纯本地 UI 状态。
  const usageNow = useUsageNowTicker(
    filtered.some((provider) => provider.usageQuery?.enabled) ||
      Object.keys(usageByProvider).length > 0,
  );
  const [expandedUsageProviderIds, setExpandedUsageProviderIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  function toggleUsageExpanded(providerId: string) {
    setExpandedUsageProviderIds((previous) => {
      const next = new Set(previous);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  }
  const {
    draggingItemId: draggingProviderId,
    getItemProps: getProviderReorderProps,
    renderDragHandle: renderProviderDragHandle,
    scrollContainerRef: providerScrollContainerRef,
  } = useVerticalListReorder({
    itemIds: filtered.map((provider) => provider.id),
    canReorder: true,
    reorderLabel: t("settings.reorderProvider"),
    reorderHint: t("settings.reorderVerticalHint"),
    disabledHint: t("settings.reorderNeedsTwoItems"),
    onReorder: (nextIds) => onReorder(type, nextIds),
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 web:max-820:gap-10px">
      <div
        ref={providerScrollContainerRef}
        className="min-h-0 flex-1 overflow-y-auto pr-1 web:max-820:pr-0 web:max-820:overscroll-y-contain web:max-820:[-webkit-overflow-scrolling:touch]"
      >
        {filtered.length === 0 ? (
          <div
            className={cn(
              "flex flex-col items-center justify-center",
              "rounded-xl border border-dashed py-12 text-center",
              "web:max-820:min-h-settings-provider-empty-min-h web:max-820:px-16px web:max-820:py-28px web:max-520:min-h-settings-provider-empty-min-h-2 web:max-520:px-12px web:max-520:py-22px",
            )}
          >
            <div className="mb-3 flex items-center justify-center text-3xl text-foreground">
              <ProviderBrandIcon type={type} />
            </div>
            <p className="text-sm font-medium">{t("settings.noProvidersHint")}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4 gap-1.5 web:max-820:w-settings-provider-empty-add-w web:max-820:min-h-40px web:max-520:w-full"
              onClick={onAdd}
            >
              <Plus className="size-3.5" />
              {t("settings.addProvider")}
            </Button>
          </div>
        ) : (
          <div className="space-y-2 pb-1">
            {filtered.map((provider) => {
              const refreshing = refreshingProviderIds.has(provider.id);
              return (
                <ProviderCardRow
                  key={provider.id}
                  provider={provider}
                  type={type}
                  usageDisplay={getProviderUsageCardDisplay(
                    provider,
                    usageByProvider[provider.id],
                    refreshing,
                    usageNow,
                  )}
                  refreshing={refreshing}
                  usageExpanded={expandedUsageProviderIds.has(provider.id)}
                  onToggleUsageExpanded={() => toggleUsageExpanded(provider.id)}
                  dragging={draggingProviderId === provider.id}
                  reorderProps={getProviderReorderProps(provider.id)}
                  dragHandle={renderProviderDragHandle(provider.id, provider.name)}
                  onEdit={() => onEdit(provider)}
                  onDelete={() => onDelete(provider.id)}
                  onRefreshUsage={() => onRefreshUsage(provider.id)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProvidersSection(
  props: SettingsSectionProps & {
    initialProviderId?: string;
    onInitialProviderHandled?: () => void;
  },
) {
  const { settings, setSettings, initialProviderId, onInitialProviderHandled } = props;

  const [activeTab, setActiveTab] = useState<ProviderId>("claude_code");
  const [modalOpen, setModalOpen] = useState(false);
  const [customSettingsOpen, setCustomSettingsOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<CustomProvider | null>(null);
  const { usageByProvider, refreshingProviderIds, refreshProvider } = useProviderUsage(
    settings.customProviders,
  );
  const openedInitialProviderIdRef = useRef<string | null>(null);

  useEffect(() => {
    const providerId = initialProviderId?.trim();
    if (!providerId || openedInitialProviderIdRef.current === providerId) return;
    const provider = settings.customProviders.find((item) => item.id === providerId);
    if (!provider) return;
    openedInitialProviderIdRef.current = providerId;
    setActiveTab(provider.type);
    setEditingProvider(provider);
    setModalOpen(true);
    onInitialProviderHandled?.();
  }, [initialProviderId, onInitialProviderHandled, settings.customProviders]);

  function openAdd() {
    setEditingProvider(null);
    setModalOpen(true);
  }

  function openEdit(provider: CustomProvider) {
    setEditingProvider(provider);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingProvider(null);
  }

  function handleSave(data: Omit<CustomProvider, "id">) {
    setSettings((prev) => {
      if (editingProvider) {
        const updated = prev.customProviders.map((provider) =>
          provider.id === editingProvider.id ? { ...provider, ...data } : provider,
        );
        return updateCustomProviders(prev, updated);
      }

      const newProvider: CustomProvider = {
        id: createUuid(),
        ...data,
      };
      return updateCustomProviders(prev, [...prev.customProviders, newProvider]);
    });
  }

  function handleDelete(id: string) {
    setSettings((prev) =>
      updateCustomProviders(
        prev,
        prev.customProviders.filter((provider) => provider.id !== id),
      ),
    );
  }

  function handleProviderReorder(type: ProviderId, nextIds: string[]) {
    setSettings((prev) => {
      const providersOfType = prev.customProviders.filter((provider) => provider.type === type);
      const reordered = itemsByIdOrder(providersOfType, nextIds);
      const included = new Set(reordered.map((provider) => provider.id));
      for (const provider of providersOfType) {
        if (!included.has(provider.id)) reordered.push(provider);
      }
      let index = 0;
      return updateCustomProviders(
        prev,
        prev.customProviders.map((provider) =>
          provider.type === type ? (reordered[index++] ?? provider) : provider,
        ),
      );
    });
  }

  const activeTabIndex = Math.max(0, PROVIDER_TABS.indexOf(activeTab));
  // 每个厂商 Tab 内联展示已配置数量，替代原先列表上方单独的计数行。
  const providerCountByType = useMemo(() => {
    const counts = Object.fromEntries(PROVIDER_TABS.map((tab) => [tab, 0])) as Record<
      ProviderId,
      number
    >;
    for (const provider of settings.customProviders) {
      if (counts[provider.type] !== undefined) counts[provider.type] += 1;
    }
    return counts;
  }, [settings.customProviders]);

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col web:max-820:min-w-0 web:max-820:min-h-0">
        <div
          className={cn(
            "mb-4 flex shrink-0 items-center justify-between gap-3 min-w-0",
            "max-640:flex-col max-640:items-stretch web:max-820:flex web:max-820:w-full web:max-820:flex-col web:max-820:items-stretch web:max-820:gap-10px web:max-820:mb-10px",
            "web:max-820:overflow-visible",
          )}
        >
          <div
            className={cn(
              "inline-flex h-9 min-w-0 items-center overflow-x-auto rounded-lg bg-muted p-1",
              "text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&::-webkit-scrollbar]:h-0 max-640:w-full",
            )}
          >
            {PROVIDER_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md",
                  "px-3 py-1 text-sm font-medium transition-all",
                  "web:max-820:min-h-34px web:max-820:pl-10px web:max-820:pr-10px web:max-820:text-sm web:max-520:pl-8px web:max-520:pr-8px",
                  activeTab === tab
                    ? "bg-background text-foreground shadow"
                    : "hover:text-foreground/80",
                )}
              >
                <ProviderBrandIcon type={tab} />
                {getProviderLabel(tab)}
                {providerCountByType[tab] > 0 ? (
                  <span
                    className={cn(
                      "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1",
                      "text-tiny font-semibold leading-none tabular-nums transition-colors",
                      activeTab === tab
                        ? "bg-foreground/[0.08] text-foreground/70"
                        : "bg-foreground/[0.06] text-muted-foreground/80",
                    )}
                  >
                    {providerCountByType[tab]}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <ProviderActionGroup
            activeTab={activeTab}
            settings={settings}
            setSettings={setSettings}
            customSettingsOpen={customSettingsOpen}
            onAdd={openAdd}
            onOpenCustomSettings={() => setCustomSettingsOpen(true)}
          />
        </div>

        <div className="settings-provider-panels min-h-0 flex-1 overflow-hidden">
          <div
            className="flex h-full transition-transform duration-300 ease-in-out"
            style={{ transform: `translateX(-${activeTabIndex * 100}%)` }}
          >
            {PROVIDER_TABS.map((tab) => (
              <div
                key={tab}
                className="w-full shrink-0 overflow-hidden"
                aria-hidden={activeTab !== tab}
                inert={activeTab !== tab}
              >
                <ProviderList
                  type={tab}
                  providers={settings.customProviders}
                  onAdd={openAdd}
                  onEdit={openEdit}
                  onDelete={handleDelete}
                  onReorder={handleProviderReorder}
                  usageByProvider={usageByProvider}
                  refreshingProviderIds={refreshingProviderIds}
                  onRefreshUsage={(providerId) => void refreshProvider(providerId)}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {modalOpen ? (
        <ProviderModal
          providerType={activeTab}
          initialData={editingProvider ?? undefined}
          onSave={handleSave}
          onClose={closeModal}
        />
      ) : null}
      {customSettingsOpen ? (
        <CustomSettingsDrawer
          settings={settings}
          setSettings={setSettings}
          providerType={activeTab}
          onClose={() => setCustomSettingsOpen(false)}
        />
      ) : null}
    </>
  );
}
