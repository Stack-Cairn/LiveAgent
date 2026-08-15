import { ProviderSettingsExtension } from "@liveagent/adapters/providerSettings";
import {
  getProviderUsageCardDisplay,
  type ProviderUsageState,
  useProviderUsage,
  useUsageNowTicker,
} from "@liveagent/app/lib/providers/usageQuery";
import {
  type CustomProvider,
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
  ChevronDown,
  ChevronUp,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  Waypoints,
  X,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Label } from "@liveagent/ui/components/ui/label";
import { NumberInput } from "@liveagent/ui/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@liveagent/ui/components/ui/sheet";
import { useVerticalListReorder } from "@liveagent/ui/components/ui/useVerticalListReorder";
import { useLocale } from "@liveagent/ui/i18n/index";
import { buildModelOptions } from "@liveagent/ui/lib/models/modelOptions";
import { parseModelValue, toModelValue } from "@liveagent/ui/lib/models/modelValue";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { ModelPicker, type ModelPickerOption } from "@liveagent/ui/pages/settings/modelPicker";
import { ConfirmDeletePopover } from "@liveagent/ui/pages/settings/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { ProviderModal } from "./ProviderModal";
import {
  DialogSwitch,
  getProviderLabel,
  itemsByIdOrder,
  PROVIDER_TABS,
  ProviderBrandIcon,
  UsagePlanLine,
  usageRelativeTimeText,
} from "./ProviderPresentation";

function FailoverNumberField(props: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const { label, hint, value, min, max, onCommit } = props;
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
      <Label className="text-[12.5px] font-medium text-foreground/85">{label}</Label>
      <NumberInput
        aria-label={label}
        incrementLabel={`${label} +`}
        decrementLabel={`${label} -`}
        min={min}
        max={max}
        step={1}
        snapOnStep
        value={draft}
        onValueChange={setDraft}
        onValueCommitted={commitDraft}
      />
      <p className="text-[11px] leading-relaxed text-muted-foreground/80">{hint}</p>
    </div>
  );
}

function FailoverSettingsCard(props: SettingsSectionProps & { providerType: ProviderId }) {
  const { settings, setSettings, providerType } = props;
  const { t } = useLocale();
  const failover = settings.modelFailover[providerType];
  // Same-vendor guard: only providers of this tab's vendor type are offered,
  // so a Claude queue can never contain a Codex provider (and vice versa).
  // Failover keeps the conversation's model and only switches which provider
  // serves it, so the queue holds providers, not models.
  const vendorProviders = useMemo(
    () => settings.customProviders.filter((provider) => provider.type === providerType),
    [settings.customProviders, providerType],
  );

  const queueValues = useMemo(() => new Set(failover.queue), [failover.queue]);
  const addableProviders = useMemo(
    () => vendorProviders.filter((provider) => !queueValues.has(provider.id)),
    [vendorProviders, queueValues],
  );

  function patchFailover(patch: Partial<ProviderFailoverSettings>) {
    setSettings((prev) => updateModelFailover(prev, providerType, patch));
  }

  function queueEntryLabel(providerId: string) {
    const provider = settings.customProviders.find((item) => item.id === providerId);
    return provider?.name ?? providerId;
  }

  function queueEntryDetail(providerId: string) {
    const provider = settings.customProviders.find((item) => item.id === providerId);
    return provider?.baseUrl ?? "";
  }

  function addQueueEntry(providerId: string) {
    if (!providerId || queueValues.has(providerId)) return;
    patchFailover({ queue: [...failover.queue, providerId] });
  }

  function removeQueueEntry(index: number) {
    patchFailover({ queue: failover.queue.filter((_, i) => i !== index) });
  }

  function moveQueueEntry(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= failover.queue.length) return;
    const queue = failover.queue.slice();
    const [entry] = queue.splice(index, 1);
    queue.splice(target, 0, entry);
    patchFailover({ queue });
  }

  return (
    <section className="py-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Label className="text-[12.5px] font-medium text-foreground/85">
              {t("settings.failoverTitle")}
            </Label>
            <span className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[10.5px] font-medium text-foreground/60">
              <ProviderBrandIcon type={providerType} />
              {getProviderLabel(providerType)}
            </span>
            {failover.enabled ? (
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">
                {t("settings.failoverEnabled")}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/80">
            {t("settings.failoverToggleHint").replaceAll(
              "{vendor}",
              getProviderLabel(providerType),
            )}
          </p>
        </div>
        <DialogSwitch
          checked={failover.enabled}
          onCheckedChange={(checked) => patchFailover({ enabled: checked })}
          ariaLabel={t("settings.failoverTitle")}
        />
      </div>

      <div className="mt-5 space-y-2">
        <Label className="text-[12px] font-medium text-foreground/80">
          {t("settings.failoverQueueTitle")}
        </Label>
        <p className="text-[11px] leading-relaxed text-muted-foreground/80">
          {t("settings.failoverQueueHint").replaceAll("{vendor}", getProviderLabel(providerType))}
        </p>
        {failover.queue.length > 0 ? (
          <div className="space-y-1.5">
            {failover.queue.map((entry, index) => (
              <div
                key={entry}
                className="flex items-center gap-2 rounded-lg border border-foreground/[0.06] bg-white/70 px-2.5 py-1.5 dark:bg-background/40"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-[10.5px] font-semibold text-foreground/70">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/90">
                  {queueEntryLabel(entry)}
                  {queueEntryDetail(entry) ? (
                    <span className="ml-2 text-[11px] text-muted-foreground/70">
                      {queueEntryDetail(entry)}
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-30"
                  onClick={() => moveQueueEntry(index, -1)}
                  disabled={index === 0}
                  title={t("settings.failoverQueueMoveUp")}
                  aria-label={t("settings.failoverQueueMoveUp")}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-30"
                  onClick={() => moveQueueEntry(index, 1)}
                  disabled={index === failover.queue.length - 1}
                  title={t("settings.failoverQueueMoveDown")}
                  aria-label={t("settings.failoverQueueMoveDown")}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-red-500/10 hover:text-red-500"
                  onClick={() => removeQueueEntry(index)}
                  title={t("settings.failoverQueueRemove")}
                  aria-label={t("settings.failoverQueueRemove")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11.5px] leading-relaxed text-amber-700 dark:text-amber-300">
            {t("settings.failoverQueueEmpty")}
          </div>
        )}
        {failover.queue.length < MODEL_FAILOVER_QUEUE_LIMIT && addableProviders.length > 0 ? (
          <Select value="" onValueChange={addQueueEntry}>
            <SelectTrigger
              aria-label={t("settings.failoverQueueAdd")}
              className="h-9 w-full rounded-lg border-foreground/10 bg-white/70 text-[13px] shadow-sm dark:bg-background/40"
            >
              <SelectValue>
                <span className="text-muted-foreground">{t("settings.failoverQueueAdd")}</span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {addableProviders.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{provider.name}</span>
                    <span className="truncate text-[11px] text-muted-foreground/70">
                      {provider.baseUrl}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-3 border-t border-foreground/[0.08] pt-5">
        <FailoverNumberField
          label={t("settings.failoverMaxSwitches")}
          hint={t("settings.failoverMaxSwitchesHint")}
          value={failover.maxSwitches}
          min={1}
          max={10}
          onCommit={(value) => patchFailover({ maxSwitches: value })}
        />
        <FailoverNumberField
          label={t("settings.failoverFailureThreshold")}
          hint={t("settings.failoverFailureThresholdHint")}
          value={failover.failureThreshold}
          min={1}
          max={10}
          onCommit={(value) => patchFailover({ failureThreshold: value })}
        />
        <FailoverNumberField
          label={t("settings.failoverCooldownSeconds")}
          hint={t("settings.failoverCooldownSecondsHint")}
          value={failover.cooldownSeconds}
          min={5}
          max={3600}
          onCommit={(value) => patchFailover({ cooldownSeconds: value })}
        />
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
    <div className="space-y-2 py-4">
      <Label className="text-[12.5px] font-medium text-foreground/85">{label}</Label>
      <p className="text-[11px] leading-relaxed text-muted-foreground/80">{hint}</p>
      <ModelPicker
        options={options}
        value={selectedValue}
        onChange={onChange}
        placeholder={followCurrentLabel}
        noneLabel={followCurrentLabel}
        ariaLabel={label}
        triggerClassName="h-9 rounded-lg border-foreground/10 bg-white/70 text-[13px] shadow-sm dark:bg-background/40"
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

  function handleModelSettingChange(
    key: "conversationTitleModel" | "commitMessageModel",
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
        className="max-w-none border-border bg-background sm:max-w-[440px]"
        closeLabel={t("settings.closeCustomSettings")}
        showCloseButton={false}
      >
        <div className="relative flex items-start gap-3 px-6 pb-4 pt-[22px]">
          <div className="min-w-0 flex-1 max-[720px]:basis-[calc(100%-3rem)]">
            <SheetTitle className="text-[17px] leading-tight tracking-tight text-foreground/95">
              {t("settings.customSettings")}
            </SheetTitle>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground/80 transition-colors hover:bg-foreground/[0.12] hover:text-foreground"
            title={t("settings.closeCustomSettings")}
            aria-label={t("settings.closeCustomSettings")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div
          aria-hidden="true"
          className="relative mx-6 h-px bg-gradient-to-r from-transparent via-foreground/[0.08] to-transparent"
        />

        <div className="relative min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <div className="divide-y divide-foreground/[0.08]">
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
              <div className="py-4">
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11.5px] leading-relaxed text-amber-700 dark:text-amber-300">
                  {t("settings.customSettingsModelEmpty")}
                </div>
              </div>
            ) : null}
            <FailoverSettingsCard
              settings={settings}
              setSettings={setSettings}
              providerType={providerType}
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
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
    <div className="settings-provider-list flex h-full min-h-0 flex-col gap-4">
      <div className="settings-section-heading-row flex shrink-0 items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {filtered.length === 0
            ? t("settings.noProviders")
            : `${filtered.length} ${t("settings.navProviders")}`}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="settings-section-action gap-1.5"
          onClick={onAdd}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("settings.addProvider")}
        </Button>
      </div>

      <div ref={providerScrollContainerRef} className="min-h-0 flex-1 overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-12 text-center">
            <div className="mb-3 flex items-center justify-center text-3xl text-foreground">
              <ProviderBrandIcon type={type} />
            </div>
            <p className="text-sm font-medium">{t("settings.noProvidersHint")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("settings.noProvidersAdd")}</p>
          </div>
        ) : (
          <div className="space-y-2 pb-1">
            {filtered.map((provider) =>
              (() => {
                const usage = usageByProvider[provider.id];
                const refreshing = refreshingProviderIds.has(provider.id);
                const usageDisplay = getProviderUsageCardDisplay(
                  provider,
                  usage,
                  refreshing,
                  usageNow,
                );
                const usageExpanded = expandedUsageProviderIds.has(provider.id);
                const visibleUsagePlans =
                  usageDisplay.plans.length > 1 && !usageExpanded
                    ? usageDisplay.plans.slice(0, 1)
                    : usageDisplay.plans;
                return (
                  <div
                    key={provider.id}
                    {...getProviderReorderProps(provider.id)}
                    className={cn(
                      "settings-card-row group flex items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:bg-accent/30",
                      draggingProviderId === provider.id && "bg-accent shadow-lg",
                    )}
                  >
                    {renderProviderDragHandle(provider.id, provider.name)}
                    <div className="flex w-5 shrink-0 items-center justify-center text-lg text-foreground">
                      <ProviderBrandIcon type={type} />
                    </div>
                    <div className="min-w-0 flex-1 max-[720px]:basis-[calc(100%-3rem)]">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{provider.name}</span>
                        {provider.useSystemProxy ? (
                          <span
                            className="shrink-0 text-blue-500 dark:text-blue-400"
                            title={t("settings.providerUseSystemProxy")}
                          >
                            <Waypoints className="h-3 w-3" />
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {provider.baseUrl || t("settings.noBaseUrl")} {" · "}
                        {provider.activeModels.length} {t("settings.activeModels")}
                      </div>
                      {usageDisplay.show ? (
                        <div className="mt-1 flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
                          {visibleUsagePlans.map((plan, index) => (
                            <UsagePlanLine
                              key={`${plan.title.kind === "text" ? plan.title.text : plan.title.kind}:${
                                // biome-ignore lint/suspicious/noArrayIndexKey: 套餐无稳定 id,索引即位置语义
                                index
                              }`}
                              plan={plan}
                            />
                          ))}
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                            {usageDisplay.plans.length > 1 ? (
                              <button
                                type="button"
                                className="text-primary hover:underline"
                                onClick={() => toggleUsageExpanded(provider.id)}
                              >
                                {usageExpanded
                                  ? t("settings.providerUsageCollapse")
                                  : t("settings.providerUsageMorePlans").replace(
                                      "{count}",
                                      String(usageDisplay.plans.length - 1),
                                    )}
                              </button>
                            ) : null}
                            {usageDisplay.isStale ? (
                              <span title={t("settings.providerUsageStaleTitle")}>
                                {t("settings.providerUsageStale")}
                              </span>
                            ) : null}
                            {usageDisplay.error ? (
                              <span className="text-destructive">{usageDisplay.error}</span>
                            ) : null}
                            {usageDisplay.updatedAt ? (
                              <time>{usageRelativeTimeText(t, usageDisplay.updatedAt)}</time>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <div className="settings-card-actions settings-hover-actions flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      {usageDisplay.show ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          disabled={usageDisplay.refreshDisabled}
                          onClick={() => onRefreshUsage(provider.id)}
                          title={t("settings.providerUsageRefresh")}
                          aria-label={t("settings.providerUsageRefresh")}
                        >
                          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        onClick={() => onEdit(provider)}
                        title={t("settings.edit")}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <ConfirmDeletePopover
                        name={provider.name}
                        onConfirm={() => onDelete(provider.id)}
                      >
                        {(open) => (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={open}
                            title={t("settings.delete")}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </ConfirmDeletePopover>
                    </div>
                  </div>
                );
              })(),
            )}
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
  const { t } = useLocale();

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

  return (
    <>
      <div className="settings-provider-tabs-wrap mb-4 flex shrink-0 items-center justify-between gap-3">
        <div className="settings-provider-tabs inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground">
          {PROVIDER_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all ${
                activeTab === tab
                  ? "bg-background text-foreground shadow"
                  : "hover:text-foreground/80"
              }`}
            >
              <ProviderBrandIcon type={tab} />
              {getProviderLabel(tab)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <ProviderSettingsExtension
            activeTab={activeTab}
            settings={settings}
            setSettings={setSettings}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => setCustomSettingsOpen(true)}
            title={t("settings.openCustomSettings")}
            aria-label={t("settings.openCustomSettings")}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
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
