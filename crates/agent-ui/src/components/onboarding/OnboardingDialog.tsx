import "@liveagent/ui/i18n/namespaces/onboarding";
import "@liveagent/ui/i18n/namespaces/settings";
import { useDirectoryPicker } from "@liveagent/adapters/directoryPicker";
import {
  discoverProviderModels,
  ProviderSettingsExtension,
  providerImportAvailable,
} from "@liveagent/adapters/providerSettings";
import { useSandboxCapability } from "@liveagent/adapters/sandboxCapability";
import {
  NotificationSettingsRows,
  notificationSettingsAvailable,
} from "@liveagent/adapters/systemSettings";
import {
  type AppSettings,
  type CommandSafetyMode,
  DEFAULT_WORKSPACE_PROJECT_ID,
  type ProviderId,
  setSelectedModel,
  THEME_OPTIONS,
  type Theme,
  updateSystem,
} from "@liveagent/app/lib/settings";
import {
  commandSafetyModeAvailability,
  MODE_I18N_KEYS,
  modeIcon,
  SAFETY_MODES,
} from "@liveagent/ui/components/chat/CommandSafetyModeSelector";
import { WorkspaceFolderTrustSection } from "@liveagent/ui/components/chat/workspace-project-settings/WorkspaceFolderTrustSection";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  FolderOpen,
  Loader2,
  MessageSquareText,
  Settings,
  Sparkles,
} from "@liveagent/ui/components/IconSet";
import {
  SettingsToggleGroup,
  SettingsToggleGroupItem,
} from "@liveagent/ui/components/settings/SettingsToggleGroup";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@liveagent/ui/components/ui/radio-group";
import type { WorkspaceFolderTrustClient } from "@liveagent/ui/contracts/workspaceFolderTrust";
import { type Locale, SUPPORTED_LOCALES, useLocale } from "@liveagent/ui/i18n/index";
import { buildModelOptions } from "@liveagent/ui/lib/models/modelOptions";
import { parseModelValue, toModelValue } from "@liveagent/ui/lib/models/modelValue";
import {
  nextOnboardingStep,
  type OnboardingStep,
  onboardingProgress,
  onboardingSteps,
  previousOnboardingStep,
} from "@liveagent/ui/lib/onboarding/onboardingState";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { ModelPicker, type ModelPickerOption } from "@liveagent/ui/pages/settings/modelPicker";
import { ProviderModal } from "@liveagent/ui/pages/settings/ProviderModal";
import { ProviderBrandIcon } from "@liveagent/ui/pages/settings/ProviderPresentation";
import {
  appendCustomProvider,
  ProviderServiceList,
} from "@liveagent/ui/pages/settings/ProviderServiceList";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

export const ONBOARDING_TRY_PROMPT_KEYS = [
  "onboarding.prompt.explore",
  "onboarding.prompt.tests",
  "onboarding.prompt.readme",
  "onboarding.prompt.plan",
] as const;

export type OnboardingWorkspaceHost = {
  /** Adds (or re-activates) a workspace for the picked folder. */
  onAddWorkspace: (path: string) => void;
  trustClient?: WorkspaceFolderTrustClient;
  onOpenProjectSettings?: (path: string) => void;
};

export type OnboardingDialogProps = {
  open: boolean;
  initialStep: OnboardingStep;
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  workspace?: OnboardingWorkspaceHost;
  onStepChange?: (step: OnboardingStep) => void;
  /** Closed without finishing (skip button, Escape, outside click). */
  onSkip: (step: OnboardingStep) => void;
  /** Finished; `prompt` is the chosen "try this" prompt, if any. */
  onFinish: (prompt?: string) => void;
};

function formatMessage(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

function StepHeading(props: { title: string; description: string }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-sm font-semibold text-foreground">{props.title}</h3>
      <p className="text-xs leading-5 text-muted-foreground">{props.description}</p>
    </div>
  );
}

function FieldLabel(props: { children: ReactNode; id?: string }) {
  return (
    <div id={props.id} className="text-xs font-medium text-foreground">
      {props.children}
    </div>
  );
}

function WelcomeStep(props: Pick<OnboardingDialogProps, "settings" | "setSettings">) {
  const { t } = useLocale();
  const { settings, setSettings } = props;
  const themeLabel = (theme: Theme) =>
    theme === "light"
      ? t("settings.light")
      : theme === "dark"
        ? t("settings.dark")
        : t("settings.auto");
  return (
    <div className="space-y-5">
      <StepHeading
        title={t("onboarding.welcome.title")}
        description={t("onboarding.welcome.description")}
      />
      <div className="space-y-2">
        <FieldLabel id="onboarding-language-label">{t("onboarding.welcome.language")}</FieldLabel>
        <SettingsToggleGroup
          aria-labelledby="onboarding-language-label"
          value={[settings.locale]}
          onValueChange={(values) => {
            const locale = SUPPORTED_LOCALES.find((option) => option === values[0]);
            if (locale) setSettings((prev) => ({ ...prev, locale: locale as Locale }));
          }}
        >
          {SUPPORTED_LOCALES.map((locale) => (
            <SettingsToggleGroupItem
              key={locale}
              value={locale}
              data-testid={`onboarding-locale-${locale}`}
            >
              {locale === "zh-CN" ? t("settings.chinese") : t("settings.english")}
            </SettingsToggleGroupItem>
          ))}
        </SettingsToggleGroup>
      </div>
      <div className="space-y-2">
        <FieldLabel id="onboarding-theme-label">{t("onboarding.welcome.theme")}</FieldLabel>
        <SettingsToggleGroup
          aria-labelledby="onboarding-theme-label"
          value={[settings.theme]}
          onValueChange={(values) => {
            const theme = THEME_OPTIONS.find((option) => option === values[0]);
            if (theme) setSettings((prev) => ({ ...prev, theme }));
          }}
        >
          {THEME_OPTIONS.map((theme) => (
            <SettingsToggleGroupItem
              key={theme}
              value={theme}
              data-testid={`onboarding-theme-${theme}`}
            >
              {themeLabel(theme)}
            </SettingsToggleGroupItem>
          ))}
        </SettingsToggleGroup>
      </div>
    </div>
  );
}

function ProviderStep(
  props: Pick<OnboardingDialogProps, "settings" | "setSettings"> & {
    onEditingChange: (editing: boolean) => void;
  },
) {
  const { t } = useLocale();
  const { settings, setSettings, onEditingChange } = props;
  const [modalType, setModalType] = useState<ProviderId | null>(null);
  useEffect(() => onEditingChange(modalType !== null), [modalType, onEditingChange]);
  return (
    <div className="space-y-4">
      <StepHeading
        title={t("onboarding.provider.title")}
        description={t("onboarding.provider.description")}
      />
      {settings.customProviders.length > 0 ? (
        <div className="space-y-2">
          <FieldLabel>{t("onboarding.provider.existing")}</FieldLabel>
          <ul className="space-y-1.5">
            {settings.customProviders.map((provider) => (
              <li
                key={provider.id}
                className="flex items-center gap-2.5 rounded-lg bg-settings-tile px-3 py-2 text-xs"
              >
                <ProviderBrandIcon type={provider.type} />
                <span className="min-w-0 flex-1 truncate font-medium">{provider.name}</span>
                <span className="text-muted-foreground">
                  {formatMessage(t("onboarding.provider.modelCount"), {
                    count: provider.activeModels.length,
                  })}
                </span>
                <CheckCircle2 className="size-3.5 text-success" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="space-y-2">
        <FieldLabel>{t("onboarding.provider.chooseService")}</FieldLabel>
        <div className="grid gap-1.5 sm:grid-cols-2">
          <ProviderServiceList onSelect={setModalType} />
        </div>
      </div>
      {providerImportAvailable ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {t("onboarding.provider.importHint")}
          </p>
          <ProviderSettingsExtension
            settings={settings}
            setSettings={setSettings}
            triggerClassName="h-8 rounded-lg bg-settings-tile px-3 text-xs font-medium hover:bg-settings-tile-hover"
          />
        </div>
      ) : null}
      {modalType ? (
        <ProviderModal
          providerType={modalType}
          onSave={(data) => setSettings((prev) => appendCustomProvider(prev, data))}
          onClose={() => setModalType(null)}
        />
      ) : null}
    </div>
  );
}

type ConnectionTest =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "ok"; count: number; listed: boolean }
  | { phase: "failed"; error: string };

function ModelStep(props: Pick<OnboardingDialogProps, "settings" | "setSettings">) {
  const { t } = useLocale();
  const { settings, setSettings } = props;
  const options = useMemo<ModelPickerOption[]>(
    () =>
      buildModelOptions(settings, { floatSelectedFirst: false }).map((option) => ({
        value: option.value,
        label: option.label,
        providerName: option.providerName,
        providerId: option.providerId,
        providerType: option.providerType,
      })),
    [settings],
  );
  const selectedValue = settings.selectedModel
    ? toModelValue(settings.selectedModel.customProviderId, settings.selectedModel.model)
    : "";
  const selectedIsValid = options.some((option) => option.value === selectedValue);
  const firstOption = options[0]?.value;
  // A fresh provider has no default yet: preselect its first enabled model so
  // "Continue" works without an extra click.
  useEffect(() => {
    if (selectedIsValid || !firstOption) return;
    const parsed = parseModelValue(firstOption);
    if (parsed) setSettings((prev) => setSelectedModel(prev, parsed));
  }, [selectedIsValid, firstOption, setSettings]);

  const [test, setTest] = useState<ConnectionTest>({ phase: "idle" });
  const testGeneration = useRef(0);
  useEffect(() => {
    // A different model invalidates the previous result.
    if (!selectedValue) return;
    testGeneration.current += 1;
    setTest({ phase: "idle" });
  }, [selectedValue]);

  const runTest = async () => {
    const selection = settings.selectedModel;
    const provider = settings.customProviders.find(
      (candidate) => candidate.id === selection?.customProviderId,
    );
    if (!selection || !provider) return;
    const generation = ++testGeneration.current;
    setTest({ phase: "testing" });
    try {
      // The same discovery request the provider editor uses; an empty key makes
      // the backend use the stored one.
      const models = await discoverProviderModels({
        type: provider.type,
        requestFormat: provider.requestFormat,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey ?? "",
        useSystemProxy: provider.useSystemProxy,
        isFullUrl: provider.isFullUrl,
        modelsUrl: provider.type === "gemini" ? "" : provider.modelsUrl,
        providerId: provider.id,
        customHeaders: provider.customHeaders,
      });
      if (generation !== testGeneration.current) return;
      setTest({
        phase: "ok",
        count: models.length,
        listed: models.some((model) => model.id === selection.model),
      });
    } catch (error) {
      if (generation !== testGeneration.current) return;
      setTest({ phase: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="space-y-4">
      <StepHeading
        title={t("onboarding.model.title")}
        description={t("onboarding.model.description")}
      />
      {options.length === 0 ? (
        <p className="rounded-lg bg-settings-tile px-3 py-2.5 text-xs text-muted-foreground">
          {t("onboarding.model.none")}
        </p>
      ) : (
        <>
          <ModelPicker
            options={options}
            value={selectedIsValid ? selectedValue : ""}
            onChange={(value) => {
              const parsed = parseModelValue(value);
              if (parsed) setSettings((prev) => setSelectedModel(prev, parsed));
            }}
            placeholder={t("onboarding.model.placeholder")}
            ariaLabel={t("onboarding.model.title")}
            searchPlaceholder={t("onboarding.model.search")}
            emptyLabel={t("onboarding.model.empty")}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!selectedIsValid || test.phase === "testing"}
              onClick={() => void runTest()}
              data-testid="onboarding-test-connection"
            >
              {test.phase === "testing" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {test.phase === "testing"
                ? t("onboarding.model.testing")
                : t("onboarding.model.test")}
            </Button>
            <output
              aria-live="polite"
              className={cn(
                "min-w-0 flex-1 text-xs",
                test.phase === "ok" && test.listed && "text-success",
                test.phase === "ok" && !test.listed && "text-warning",
                test.phase === "failed" && "text-destructive",
              )}
            >
              {test.phase === "ok"
                ? formatMessage(
                    t(
                      test.listed
                        ? "onboarding.model.testOkListed"
                        : "onboarding.model.testNotListed",
                    ),
                    { count: test.count },
                  )
                : test.phase === "failed"
                  ? formatMessage(t("onboarding.model.testFailed"), { error: test.error })
                  : ""}
            </output>
          </div>
        </>
      )}
    </div>
  );
}

function WorkspaceStep(
  props: Pick<OnboardingDialogProps, "settings" | "workspace"> & {
    onPickerSuspend: (suspended: boolean) => void;
  },
) {
  const { t } = useLocale();
  const { settings, workspace, onPickerSuspend } = props;
  const { pickDirectory, suspendsParentModal, directoryPickerElement } = useDirectoryPicker();
  const userProjects = settings.system.workspaceProjects.filter(
    (project) => project.id !== DEFAULT_WORKSPACE_PROJECT_ID && project.path.trim() !== "",
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(
    () =>
      userProjects.find((project) => project.id === settings.system.activeWorkspaceProjectId)
        ?.path ??
      userProjects[0]?.path ??
      null,
  );
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    setError(null);
    if (suspendsParentModal) onPickerSuspend(true);
    try {
      const picked = (await pickDirectory(selectedPath ?? settings.system.workdir ?? ""))?.trim();
      if (!picked) return;
      workspace?.onAddWorkspace(picked);
      setSelectedPath(picked);
    } catch (failure) {
      setError(
        formatMessage(t("onboarding.workspace.pickFailed"), {
          error: failure instanceof Error ? failure.message : String(failure),
        }),
      );
    } finally {
      if (suspendsParentModal) onPickerSuspend(false);
    }
  };

  return (
    <div className="space-y-4">
      <StepHeading
        title={t("onboarding.workspace.title")}
        description={t("onboarding.workspace.description")}
      />
      {userProjects.length > 0 ? (
        <div className="space-y-2">
          <FieldLabel id="onboarding-workspaces-label">
            {t("onboarding.workspace.current")}
          </FieldLabel>
          <fieldset
            className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0"
            aria-labelledby="onboarding-workspaces-label"
          >
            {userProjects.map((project) => (
              <Button
                key={project.id}
                type="button"
                size="sm"
                variant="ghost"
                aria-pressed={project.path === selectedPath}
                title={project.path}
                className={cn(
                  "h-8 max-w-full gap-1.5 rounded-lg bg-settings-tile px-2.5 text-xs hover:bg-settings-tile-hover",
                  project.path === selectedPath && "ring-1 ring-primary/50",
                )}
                onClick={() => setSelectedPath(project.path)}
              >
                <FolderOpen className="size-3.5 shrink-0" />
                <span className="truncate">{project.name}</span>
              </Button>
            ))}
          </fieldset>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void choose()}
          data-testid="onboarding-choose-folder"
        >
          <FolderOpen className="size-3.5" />
          {userProjects.length > 0
            ? t("onboarding.workspace.chooseAnother")
            : t("onboarding.workspace.choose")}
        </Button>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
      <div className="space-y-2 rounded-xl border border-border/70 p-3">
        <div className="text-xs font-medium text-foreground">
          {t("onboarding.workspace.trustTitle")}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {t("onboarding.workspace.trustDescription")}
        </p>
        {selectedPath && workspace?.trustClient ? (
          <WorkspaceFolderTrustSection path={selectedPath} client={workspace.trustClient} />
        ) : null}
        {selectedPath && workspace?.onOpenProjectSettings ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0 text-xs"
            onClick={() => workspace.onOpenProjectSettings?.(selectedPath)}
          >
            <Settings className="size-3.5" />
            {t("onboarding.workspace.openProjectSettings")}
          </Button>
        ) : null}
      </div>
      {directoryPickerElement}
    </div>
  );
}

function SafetyStep(props: Pick<OnboardingDialogProps, "settings" | "setSettings">) {
  const { t } = useLocale();
  const { settings, setSettings } = props;
  const capability = useSandboxCapability();
  const { sandboxUnavailable, offlineUnavailable, disabledHint, modeDescKey } =
    commandSafetyModeAvailability(capability, t);
  const current =
    settings.system.commandSafetyMode === "auto" ? "always" : settings.system.commandSafetyMode;
  const select = (mode: CommandSafetyMode) =>
    setSettings((prev) => updateSystem(prev, { commandSafetyMode: mode }));
  return (
    <div className="space-y-4">
      <StepHeading
        title={t("onboarding.safety.title")}
        description={t("onboarding.safety.description")}
      />
      <RadioGroup
        className="grid gap-1.5"
        aria-label={t("chat.safety.label")}
        value={current}
        onValueChange={(value) => select(value as CommandSafetyMode)}
      >
        {SAFETY_MODES.map((mode) => {
          const disabled =
            mode === "sandbox"
              ? sandboxUnavailable
              : mode === "sandboxOffline"
                ? offlineUnavailable
                : false;
          const selected = current === mode;
          return (
            <RadioGroupItem
              key={mode}
              value={mode}
              disabled={disabled}
              data-testid={`onboarding-safety-${mode}`}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[disabled]:cursor-not-allowed data-[disabled]:opacity-55",
                selected
                  ? "border-primary/50 bg-primary/5"
                  : "border-transparent bg-settings-tile hover:bg-settings-tile-hover",
              )}
            >
              {modeIcon(mode, "mt-0.5 size-3.5 shrink-0 text-muted-foreground")}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 font-medium leading-4 text-foreground">
                  {t(MODE_I18N_KEYS[mode])}
                  {mode === "ask" ? (
                    <span className="rounded bg-primary/10 px-1.5 text-tiny font-medium text-primary">
                      {t("onboarding.safety.recommended")}
                    </span>
                  ) : null}
                </span>
                <span className="text-tiny leading-4 text-muted-foreground">
                  {disabled ? disabledHint : t(modeDescKey(mode))}
                </span>
              </span>
              {selected ? <Check className="mt-0.5 size-3.5 shrink-0 text-primary" /> : null}
            </RadioGroupItem>
          );
        })}
      </RadioGroup>
    </div>
  );
}

function NotificationsStep(props: Pick<OnboardingDialogProps, "settings" | "setSettings">) {
  const { t } = useLocale();
  return (
    <div className="space-y-4">
      <StepHeading
        title={t("onboarding.notifications.title")}
        description={t("onboarding.notifications.description")}
      />
      <NotificationSettingsRows settings={props.settings} setSettings={props.setSettings} />
    </div>
  );
}

function FinishStep(props: Pick<OnboardingDialogProps, "settings" | "onFinish">) {
  const { t } = useLocale();
  const { settings } = props;
  const provider = settings.customProviders.find(
    (candidate) => candidate.id === settings.selectedModel?.customProviderId,
  );
  const workspaceCount = settings.system.workspaceProjects.filter(
    (project) => project.id !== DEFAULT_WORKSPACE_PROJECT_ID && project.path.trim() !== "",
  ).length;
  const rows: Array<{ label: string; value: string | null }> = [
    {
      label: t("onboarding.finish.summaryProvider"),
      value: provider?.name ?? settings.customProviders[0]?.name ?? null,
    },
    {
      label: t("onboarding.finish.summaryModel"),
      value: provider ? (settings.selectedModel?.model ?? null) : null,
    },
    {
      label: t("onboarding.finish.summaryWorkspace"),
      value: workspaceCount > 0 ? String(workspaceCount) : null,
    },
    {
      label: t("onboarding.finish.summarySafety"),
      value: t(
        MODE_I18N_KEYS[
          settings.system.commandSafetyMode === "auto"
            ? "always"
            : settings.system.commandSafetyMode
        ],
      ),
    },
  ];
  return (
    <div className="space-y-4">
      <StepHeading
        title={t("onboarding.finish.title")}
        description={t("onboarding.finish.description")}
      />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl bg-settings-tile px-3 py-2.5 text-xs">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd
              className={cn(
                "min-w-0 truncate",
                row.value ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {row.value ?? t("onboarding.finish.notSet")}
            </dd>
          </div>
        ))}
      </dl>
      <div className="space-y-2">
        <FieldLabel>{t("onboarding.finish.tryThis")}</FieldLabel>
        <ul className="grid gap-1.5">
          {ONBOARDING_TRY_PROMPT_KEYS.map((key) => (
            <li key={key}>
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start gap-2.5 whitespace-normal rounded-lg bg-settings-tile px-3 py-2 text-left text-xs font-normal hover:bg-settings-tile-hover"
                onClick={() => props.onFinish(t(key))}
                data-testid={`onboarding-try-${key.split(".").pop()}`}
              >
                <MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">{t(key)}</span>
                <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Short, skippable first-run guide. Every step edits the real settings through
 * the same helpers and components as Settings, so nothing here is a copy of a
 * settings page.
 */
export function OnboardingDialog(props: OnboardingDialogProps) {
  const { t } = useLocale();
  const { open, initialStep, settings, setSettings, workspace, onStepChange, onSkip, onFinish } =
    props;
  // Keyed on presence, not identity: the host rebuilds `workspace` on every
  // settings change, and a new step list must not reset the current step.
  const hasWorkspace = workspace !== undefined;
  const steps = useMemo(
    () =>
      onboardingSteps({ notificationsSupported: notificationSettingsAvailable() }).filter(
        (step) => step !== "workspace" || hasWorkspace,
      ),
    [hasWorkspace],
  );
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const [nestedEditing, setNestedEditing] = useState(false);
  const [pickerSuspended, setPickerSuspended] = useState(false);
  useEffect(() => {
    if (open) setStep(steps.includes(initialStep) ? initialStep : (steps[0] ?? "welcome"));
  }, [open, initialStep, steps]);
  useEffect(() => {
    if (open) onStepChange?.(step);
  }, [open, step, onStepChange]);

  const { index, total } = onboardingProgress(steps, step);
  const previous = previousOnboardingStep(steps, step);
  const isLast = step === "finish";

  return (
    <Dialog
      open={open && !pickerSuspended}
      onOpenChange={(next) => {
        // Nested provider editor dialogs own Escape while they are open.
        if (!next && !nestedEditing) onSkip(step);
      }}
    >
      <DialogContent
        className="flex max-h-[min(720px,calc(100dvh-32px))] max-w-2xl flex-col"
        layout="fullscreen-mobile"
        data-testid="onboarding-dialog"
        data-step={step}
      >
        <DialogHeader className="border-b border-border/60">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <DialogTitle>{t("onboarding.title")}</DialogTitle>
            <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
              {formatMessage(t("onboarding.progress"), { current: index + 1, total })}
            </span>
          </div>
          <DialogDescription className="sr-only">{t(`onboarding.step.${step}`)}</DialogDescription>
          <ol className="flex gap-1" aria-label={t("onboarding.stepsLabel")}>
            {steps.map((item, itemIndex) => (
              <li
                key={item}
                aria-current={item === step ? "step" : undefined}
                title={t(`onboarding.step.${item}`)}
                className={cn(
                  "h-1 flex-1 rounded-full",
                  itemIndex <= index ? "bg-primary" : "bg-muted",
                )}
              >
                <span className="sr-only">{t(`onboarding.step.${item}`)}</span>
              </li>
            ))}
          </ol>
        </DialogHeader>
        <DialogBody className="px-5 py-4">
          {step === "welcome" ? (
            <WelcomeStep settings={settings} setSettings={setSettings} />
          ) : null}
          {step === "provider" ? (
            <ProviderStep
              settings={settings}
              setSettings={setSettings}
              onEditingChange={setNestedEditing}
            />
          ) : null}
          {step === "model" ? <ModelStep settings={settings} setSettings={setSettings} /> : null}
          {step === "workspace" ? (
            <WorkspaceStep
              settings={settings}
              workspace={workspace}
              onPickerSuspend={setPickerSuspended}
            />
          ) : null}
          {step === "safety" ? <SafetyStep settings={settings} setSettings={setSettings} /> : null}
          {step === "notifications" ? (
            <NotificationsStep settings={settings} setSettings={setSettings} />
          ) : null}
          {step === "finish" ? <FinishStep settings={settings} onFinish={onFinish} /> : null}
        </DialogBody>
        <DialogFooter className="justify-between border-t border-border/60 max-[820px]:flex-row max-[820px]:items-center">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onSkip(step)}
            data-testid="onboarding-skip"
          >
            {t("onboarding.skip")}
          </Button>
          <div className="flex items-center gap-2">
            {previous ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setStep(previous)}>
                {t("onboarding.back")}
              </Button>
            ) : null}
            {isLast ? (
              <Button
                type="button"
                size="sm"
                onClick={() => onFinish()}
                data-testid="onboarding-finish"
              >
                {t("onboarding.finish")}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={() => setStep(nextOnboardingStep(steps, step))}
                data-testid="onboarding-next"
              >
                {t("onboarding.next")}
                <ArrowRight className="size-3.5" />
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
