// 高级设置抽屉：生成模型、澄清提示词、上下文占用展示、错误重试。原来挂在
// 供应商页顶部操作组里；故障转移已迁到各供应商详情的"可用性"分区。

import { type SelectedModel, updateCustomSettings } from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { Activity, WandSparkles, X } from "@liveagent/ui/components/IconSet";
import { SegmentedSlider } from "@liveagent/ui/components/ui/segmented-slider";
import { Sheet, SheetContent, SheetTitle } from "@liveagent/ui/components/ui/sheet";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import { buildModelOptions } from "@liveagent/ui/lib/models/modelOptions";
import { parseModelValue, toModelValue } from "@liveagent/ui/lib/models/modelValue";
import { ModelPicker, type ModelPickerOption } from "@liveagent/ui/pages/settings/modelPicker";
import { useMemo } from "react";
import { DrawerFieldLabel, DrawerSectionHeader } from "../ProviderPresentation";
import { RetryErrorSection } from "../RetryErrorSection";

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
  const options =
    selected && !modelOptions.some((option) => option.value === selectedValue)
      ? [
          ...modelOptions,
          { value: selectedValue, label: selected.model, providerName: selected.customProviderId },
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
        triggerClassName="h-9 rounded-lg border-foreground/10 bg-white/70 text-[13px] shadow-sm dark:bg-background/40"
      />
    </div>
  );
}

export function ProviderCustomSettingsDrawer(
  props: SettingsSectionProps & { onClose: () => void },
) {
  const { settings, setSettings, onClose } = props;
  const { t } = useLocale();
  const modelOptions = useMemo(() => buildModelOptions(settings), [settings]);
  const contextDisplayModeDesc = {
    statsBar: t("settings.composerContextDisplayStatsBarDesc"),
    both: t("settings.composerContextDisplayBothDesc"),
    ring: t("settings.composerContextDisplayRingDesc"),
  } as const;

  function handleModelSettingChange(
    key: "conversationTitleModel" | "commitMessageModel" | "promptClarifyModel",
    value: string,
  ) {
    setSettings((prev) =>
      updateCustomSettings(prev, { [key]: parseModelValue(value) ?? undefined }),
    );
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        variant="inset"
        className="settings-provider-custom-sheet max-w-none border-border bg-background sm:max-w-[440px]"
        closeLabel={t("settings.closeCustomSettings")}
        showCloseButton={false}
      >
        <div className="settings-provider-custom-sheet-header relative flex items-center gap-3 px-6 pb-4 pt-[22px]">
          <SheetTitle className="min-w-0 flex-1 text-[17px] leading-tight tracking-tight text-foreground/95">
            {t("settings.customSettings")}
          </SheetTitle>
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
        <div className="settings-provider-custom-sheet-body relative min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <div className="divide-y divide-foreground/[0.06]">
            <section className="py-5 first:pt-4">
              <DrawerSectionHeader
                icon={<WandSparkles className="h-3.5 w-3.5" />}
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
                  <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                    {t("settings.customSettingsModelEmpty")}
                  </div>
                ) : null}
              </div>
            </section>
            <section className="py-5">
              <DrawerSectionHeader
                icon={<WandSparkles className="h-3.5 w-3.5" />}
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
                className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
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
            <section className="py-5">
              <DrawerSectionHeader
                icon={<Activity className="h-3.5 w-3.5" />}
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
                <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                  {contextDisplayModeDesc[settings.customSettings.composerContextDisplay]}
                </p>
              </div>
            </section>
            <RetryErrorSection settings={settings} setSettings={setSettings} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
