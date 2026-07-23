import { useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  Folder,
  FolderOpen,
  Globe,
  MessageSquare,
  Plus,
  Terminal,
  X,
} from "../../components/icons";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { useLocale } from "../../i18n";
import {
  type CronTask,
  type CronTaskType,
  DEFAULT_CRON_TIMEOUT_SECONDS,
  MAX_CRON_TIMEOUT_SECONDS,
  MIN_CRON_TIMEOUT_SECONDS,
  validateCronExpression,
} from "../../lib/automation";
import { parseModelValue, toModelValue } from "../../lib/providers/llm";
import {
  type CustomProvider,
  type ExecutionMode,
  getChatRuntimeReasoningLevelsForProvider,
  isAgentExecutionMode,
  isThinkingAlwaysOnForModel,
} from "../../lib/settings";
import { useModalMotion } from "../../lib/shared/modalMotion";
import {
  createEmptyRequestDraft,
  type HttpRequestDraft,
  HttpRequestListEditor,
  parseHttpRequestDrafts,
  requestToDraft,
} from "./httpRequestEditor";
import { ModelPicker, type ModelPickerOption } from "./modelPicker";

export type CronPromptModelOption = ModelPickerOption;

export type CronWorkspaceOption = {
  path: string;
  name: string;
};

/**
 * Radix SelectItem rejects an empty-string value at runtime, so "follow the
 * active workspace" (stored as an empty workdir) uses this sentinel in the
 * select and is mapped back to "" on save.
 */
const FOLLOW_ACTIVE_WORKSPACE_VALUE = "__follow-active-workspace__";

/**
 * "Custom path" entry: the CronTaskManager tool can pin arbitrary paths, so
 * the form offers a free-form path input alongside the workspace list.
 */
const CUSTOM_WORKDIR_VALUE = "__custom-workdir__";

/**
 * Windows paths reach us in several spellings ("\\" vs "/", drive-letter
 * case, trailing separators) depending on which picker produced them, so a
 * pinned workspace path must match its workspace entry shape-insensitively.
 * POSIX paths stay case-sensitive.
 */
function comparableWorkdirPath(path: string) {
  const normalized = path.trim().replace(/\\/g, "/");
  if (!normalized) return "";
  const isWindowsShape = /^[A-Za-z]:/.test(normalized) || normalized.startsWith("//");
  const comparable = isWindowsShape ? normalized.toLowerCase() : normalized;
  if (comparable === "/" || /^[a-z]:\/$/.test(comparable)) return comparable;
  return comparable.replace(/\/+$/, "");
}

function findWorkspaceOptionByPath(options: CronWorkspaceOption[], path: string) {
  const target = comparableWorkdirPath(path);
  if (!target) return null;
  return options.find((option) => comparableWorkdirPath(option.path) === target) ?? null;
}

const CRON_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type CronReasoningLevel = (typeof CRON_REASONING_LEVELS)[number];

const DEFAULT_CRON_REASONING: CronReasoningLevel = "medium";

const REASONING_LEVEL_I18N_KEYS: Record<CronReasoningLevel, string> = {
  off: "settings.reasoning.off",
  minimal: "settings.reasoning.minimal",
  low: "settings.reasoning.low",
  medium: "settings.reasoning.medium",
  high: "settings.reasoning.high",
  xhigh: "settings.reasoning.xhigh",
  max: "settings.reasoning.max",
};

function isCronReasoningLevel(value: string): value is CronReasoningLevel {
  return (CRON_REASONING_LEVELS as readonly string[]).includes(value);
}

function getCronReasoningLevels(
  selectedModelValue: string,
  providers: CustomProvider[],
): CronReasoningLevel[] {
  const selectedModel = parseModelValue(selectedModelValue);
  const provider = selectedModel
    ? providers.find((item) => item.id === selectedModel.customProviderId)
    : undefined;
  if (!selectedModel || !provider) return [...CRON_REASONING_LEVELS];

  const modelConfig = provider.models.find((model) => model.id === selectedModel.model);
  const supportedLevels = getChatRuntimeReasoningLevelsForProvider({
    providerId: provider.type,
    baseUrl: provider.baseUrl,
    requestFormat: provider.requestFormat,
    modelId: selectedModel.model,
    modelConfig,
  }).filter(isCronReasoningLevel);
  const thinkingAlwaysOn = isThinkingAlwaysOnForModel(
    provider.type,
    selectedModel.model,
    provider.baseUrl,
    provider.requestFormat,
    modelConfig,
  );

  return thinkingAlwaysOn ? supportedLevels : ["off", ...supportedLevels];
}

/**
 * Non-reasoning models expose only `off`, so the default (`medium`) may itself
 * be unsupported — fall back to the first offered level in that case.
 */
function coerceCronReasoningLevel(
  levels: CronReasoningLevel[],
  current: CronReasoningLevel,
): CronReasoningLevel {
  if (levels.includes(current)) return current;
  if (levels.includes(DEFAULT_CRON_REASONING)) return DEFAULT_CRON_REASONING;
  return levels[0] ?? DEFAULT_CRON_REASONING;
}

/**
 * Fields the modal edits. `enabled` is deliberately not part of the payload:
 * toggling is its own operation, so saving an edit can never write back a
 * stale enabled flag captured when the modal opened.
 */
export type CronTaskFormData = Omit<CronTask, "id" | "enabled" | "lastError">;

type CronTaskModalProps = {
  mode: "add" | "edit";
  initialData?: CronTask;
  modelOptions: CronPromptModelOption[];
  providers: CustomProvider[];
  workspaceOptions: CronWorkspaceOption[];
  executionMode: ExecutionMode;
  /**
   * Platform directory picker injected by each end's CronSection (native
   * dialog on desktop, remote path prompt on the WebUI). The browse button
   * is hidden when absent.
   */
  onPickWorkdir?: (initialWorkdir: string) => Promise<string | null>;
  onSave: (data: CronTaskFormData) => void | Promise<void>;
  onClose: () => void;
};

export function CronTaskModal({
  mode,
  initialData,
  modelOptions,
  providers,
  workspaceOptions,
  executionMode,
  onPickWorkdir,
  onSave,
  onClose,
}: CronTaskModalProps) {
  const { t } = useLocale();
  const autoPromptSupported = isAgentExecutionMode(executionMode);

  const [name, setName] = useState(initialData?.name ?? "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [cron, setCron] = useState(initialData?.cron ?? "");
  const [remainingExecutions, setRemainingExecutions] = useState(
    initialData?.remainingExecutions == null ? "" : String(initialData.remainingExecutions),
  );
  // Prefilled with the effective value: tasks saved before the field existed
  // run with the default, so showing it is truthful — and clearing the input
  // simply falls back to the same default on save.
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    String(initialData?.timeoutSeconds ?? DEFAULT_CRON_TIMEOUT_SECONDS),
  );
  const [type, setType] = useState<CronTaskType>(initialData?.type ?? "bash");
  const [scriptText, setScriptText] = useState(initialData?.script ?? "");
  const [requests, setRequests] = useState<HttpRequestDraft[]>(() => {
    if (initialData?.requests?.length) {
      return initialData.requests.map((request) => requestToDraft(request));
    }
    return [createEmptyRequestDraft()];
  });
  const [prompt, setPrompt] = useState(initialData?.prompt ?? "");
  const [reasoning, setReasoning] = useState<CronReasoningLevel>(() => {
    const initial = initialData?.reasoning ?? "";
    return isCronReasoningLevel(initial) ? initial : DEFAULT_CRON_REASONING;
  });
  // A Windows pin may spell the same directory differently than the
  // workspace list ("\\" vs "/", drive-letter case); snap it to the list
  // entry's exact spelling so the Select matches it by value.
  const [workdir, setWorkdir] = useState(() => {
    const initialWorkdir = initialData?.workdir ?? "";
    if (!initialWorkdir) return "";
    return findWorkspaceOptionByPath(workspaceOptions, initialWorkdir)?.path ?? initialWorkdir;
  });
  // A pinned path outside the workspace list (e.g. set by the CronTaskManager
  // tool, or whose workspace was removed) opens in custom-path mode so the
  // user sees and can edit the raw path.
  const [customWorkdir, setCustomWorkdir] = useState(() => {
    const initialWorkdir = initialData?.workdir ?? "";
    return Boolean(initialWorkdir && !findWorkspaceOptionByPath(workspaceOptions, initialWorkdir));
  });
  const [selectedModelValue, setSelectedModelValue] = useState(() =>
    initialData?.selectedModel
      ? toModelValue(initialData.selectedModel.customProviderId, initialData.selectedModel.model)
      : "",
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [expandedRequest, setExpandedRequest] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { isClosing, modalState, requestClose } = useModalMotion(onClose);

  const promptModelOptions =
    selectedModelValue &&
    !modelOptions.some((option) => option.value === selectedModelValue) &&
    initialData?.selectedModel
      ? [
          ...modelOptions,
          {
            value: selectedModelValue,
            label: initialData.selectedModel.model,
            providerName: initialData.selectedModel.customProviderId,
          },
        ]
      : modelOptions;

  const cronReasoningLevels = getCronReasoningLevels(selectedModelValue, providers);

  const selectedWorkspaceOption = customWorkdir
    ? null
    : findWorkspaceOptionByPath(workspaceOptions, workdir);

  const formReady =
    Boolean(name.trim()) &&
    Boolean(cron.trim()) &&
    (type !== "bash" || Boolean(scriptText.trim())) &&
    (type !== "prompt" || Boolean(prompt.trim() && parseModelValue(selectedModelValue)));

  async function handleSave() {
    try {
      setIsSaving(true);
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error(`${t("settings.cronTaskName")} is required`);
      if (!cron.trim()) throw new Error(`${t("settings.cronExpression")} is required`);
      const trimmedRemainingExecutions = remainingExecutions.trim();
      const parsedRemainingExecutions = trimmedRemainingExecutions
        ? Number(trimmedRemainingExecutions)
        : undefined;
      if (
        parsedRemainingExecutions !== undefined &&
        (!Number.isSafeInteger(parsedRemainingExecutions) || parsedRemainingExecutions < 0)
      ) {
        throw new Error(t("settings.cronRemainingExecutionsInvalid"));
      }
      const trimmedTimeoutSeconds = timeoutSeconds.trim();
      const parsedTimeoutSeconds = trimmedTimeoutSeconds
        ? Number(trimmedTimeoutSeconds)
        : DEFAULT_CRON_TIMEOUT_SECONDS;
      if (
        !Number.isSafeInteger(parsedTimeoutSeconds) ||
        parsedTimeoutSeconds < MIN_CRON_TIMEOUT_SECONDS ||
        parsedTimeoutSeconds > MAX_CRON_TIMEOUT_SECONDS
      ) {
        throw new Error(t("settings.cronTimeoutSecondsInvalid"));
      }

      await validateCronExpression(cron.trim());

      const trimmedPrompt = prompt.trim();
      const trimmedScript = scriptText.trim();
      const parsedSelectedModel = type === "prompt" ? parseModelValue(selectedModelValue) : null;
      if (type === "bash" && !trimmedScript) {
        throw new Error(t("settings.cronCommandRequired"));
      }
      if (type === "prompt") {
        if (!autoPromptSupported) {
          throw new Error(t("settings.cronPromptAgentModeRequired"));
        }
        if (!trimmedPrompt) {
          throw new Error(t("settings.cronPromptRequired"));
        }
        if (!parsedSelectedModel) {
          throw new Error(
            promptModelOptions.length === 0
              ? t("settings.cronPromptModelEmpty")
              : t("settings.cronPromptModelRequired"),
          );
        }
      }

      const data: CronTaskFormData = {
        name: trimmedName,
        description: description.trim(),
        cron: cron.trim(),
        remainingExecutions: parsedRemainingExecutions,
        timeoutSeconds: parsedTimeoutSeconds,
        type,
        script: type === "bash" ? trimmedScript : undefined,
        requests: type === "http" ? parseHttpRequestDrafts(requests, t) : undefined,
        prompt: type === "prompt" ? trimmedPrompt : undefined,
        selectedModel: type === "prompt" ? (parsedSelectedModel ?? undefined) : undefined,
        // Prompt tasks always carry a concrete level (default "medium");
        // other kinds clear the field.
        reasoning: type === "prompt" ? reasoning : "",
        // Always carried: an empty string is the explicit "follow the active
        // workspace" signal — omitting the key would make merge_patch keep a
        // stale pin forever.
        workdir: type === "http" ? "" : workdir.trim(),
      };

      await onSave(data);
      requestClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }

  const scriptLineCount = scriptText.split(/\r?\n/).filter((l) => l.trim()).length;

  const modalTitle = mode === "add" ? t("settings.cronModalAdd") : t("settings.cronModalEdit");

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={requestClose} />

      <div className="settings-modal-panel relative z-10 flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl">
        {/* Header */}
        <div className="settings-modal-header flex items-center gap-3 border-b border-border/40 px-6 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
            <Clock3 className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{modalTitle}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("settings.cronExpressionHint")}
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            title={t("settings.cancel")}
            aria-label={t("settings.cancel")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="settings-modal-body flex-1 overflow-y-auto">
          {/* Step 1: Basic Info */}
          <div className="border-b border-border/30 px-6 py-5">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-[11px] font-bold text-primary">
                1
              </div>
              <span className="text-sm font-semibold">{t("settings.cronStepBasic")}</span>
            </div>

            <div className="space-y-4">
              <div className="settings-form-grid grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem]">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    {t("settings.cronTaskName")}
                  </Label>
                  <Input
                    value={name}
                    placeholder={t("settings.cronTaskNamePlaceholder")}
                    onChange={(e) => {
                      setFormError(null);
                      setName(e.currentTarget.value);
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    {t("settings.cronExpression")}
                  </Label>
                  <Input
                    value={cron}
                    placeholder={t("settings.cronExpressionPlaceholder")}
                    className="font-mono"
                    onChange={(e) => {
                      setFormError(null);
                      setCron(e.currentTarget.value);
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    {t("settings.cronRemainingExecutions")}
                  </Label>
                  <Input
                    value={remainingExecutions}
                    inputMode="numeric"
                    placeholder={t("settings.cronRemainingExecutionsPlaceholder")}
                    onChange={(e) => {
                      const next = e.currentTarget.value.trim();
                      if (next && !/^\d+$/.test(next)) return;
                      setFormError(null);
                      setRemainingExecutions(next);
                    }}
                  />
                </div>
              </div>
              <div className="settings-form-grid grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    {t("settings.cronTaskDesc")}
                  </Label>
                  <Input
                    value={description}
                    placeholder={t("settings.cronTaskDescPlaceholder")}
                    onChange={(e) => {
                      setFormError(null);
                      setDescription(e.currentTarget.value);
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    {t("settings.cronTimeoutSeconds")}
                  </Label>
                  <Input
                    value={timeoutSeconds}
                    inputMode="numeric"
                    placeholder={String(DEFAULT_CRON_TIMEOUT_SECONDS)}
                    onChange={(e) => {
                      const next = e.currentTarget.value.trim();
                      if (next && !/^\d+$/.test(next)) return;
                      setFormError(null);
                      setTimeoutSeconds(next);
                    }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Step 2: Task Type */}
          <div className="border-b border-border/30 px-6 py-5">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-[11px] font-bold text-primary">
                2
              </div>
              <span className="text-sm font-semibold">{t("settings.cronStepType")}</span>
            </div>

            <div className="settings-choice-grid settings-cron-type-grid grid grid-cols-3 gap-3">
              {/* Bash */}
              <button
                type="button"
                onClick={() => {
                  setFormError(null);
                  setType("bash");
                }}
                className={`group relative flex items-start gap-3 rounded-xl border-2 p-4 text-left transition-all ${
                  type === "bash"
                    ? "border-blue-500/50 bg-blue-500/5 shadow-sm shadow-blue-500/10"
                    : "border-border/60 bg-background hover:border-border hover:bg-muted/20"
                }`}
              >
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
                    type === "bash"
                      ? "bg-blue-500/15 text-blue-500"
                      : "bg-muted/60 text-muted-foreground"
                  }`}
                >
                  <Terminal className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-sm font-semibold ${type === "bash" ? "text-blue-600 dark:text-blue-400" : "text-foreground"}`}
                  >
                    {t("settings.cronTypeBash")}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {t("settings.cronTypeBashHint")}
                  </p>
                </div>
                {type === "bash" ? (
                  <div className="absolute right-3 top-3">
                    <CheckCircle2 className="h-4.5 w-4.5 text-blue-500" />
                  </div>
                ) : null}
              </button>

              {/* HTTP */}
              <button
                type="button"
                onClick={() => {
                  setFormError(null);
                  setType("http");
                }}
                className={`group relative flex items-start gap-3 rounded-xl border-2 p-4 text-left transition-all ${
                  type === "http"
                    ? "border-emerald-500/50 bg-emerald-500/5 shadow-sm shadow-emerald-500/10"
                    : "border-border/60 bg-background hover:border-border hover:bg-muted/20"
                }`}
              >
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
                    type === "http"
                      ? "bg-emerald-500/15 text-emerald-500"
                      : "bg-muted/60 text-muted-foreground"
                  }`}
                >
                  <Globe className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-sm font-semibold ${type === "http" ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"}`}
                  >
                    {t("settings.cronTypeHttp")}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {t("settings.cronTypeHttpHint")}
                  </p>
                </div>
                {type === "http" ? (
                  <div className="absolute right-3 top-3">
                    <CheckCircle2 className="h-4.5 w-4.5 text-emerald-500" />
                  </div>
                ) : null}
              </button>

              {/* Prompt */}
              <button
                type="button"
                onClick={() => {
                  setFormError(null);
                  setType("prompt");
                }}
                className={`group relative flex items-start gap-3 rounded-xl border-2 p-4 text-left transition-all ${
                  type === "prompt"
                    ? "border-violet-500/50 bg-violet-500/5 shadow-sm shadow-violet-500/10"
                    : "border-border/60 bg-background hover:border-border hover:bg-muted/20"
                }`}
              >
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
                    type === "prompt"
                      ? "bg-violet-500/15 text-violet-500"
                      : "bg-muted/60 text-muted-foreground"
                  }`}
                >
                  <MessageSquare className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-sm font-semibold ${type === "prompt" ? "text-violet-600 dark:text-violet-400" : "text-foreground"}`}
                  >
                    {t("settings.cronTypePrompt")}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {t("settings.cronTypePromptHint")}
                  </p>
                </div>
                {type === "prompt" ? (
                  <div className="absolute right-3 top-3">
                    <CheckCircle2 className="h-4.5 w-4.5 text-violet-500" />
                  </div>
                ) : null}
              </button>
            </div>

            {/* Prompt-type run semantics belong to the type choice, not the config step */}
            {type === "prompt" ? (
              <div className="mt-3 rounded-xl border border-violet-500/15 bg-violet-500/[0.04] px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">
                {t("settings.cronPromptRunHint")}
              </div>
            ) : null}
          </div>

          {/* Step 3: Configuration */}
          <div className="px-6 py-5">
            <div className="settings-modal-step-row mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-[11px] font-bold text-primary">
                  3
                </div>
                <span className="text-sm font-semibold">{t("settings.cronStepConfig")}</span>
              </div>

              {type === "bash" ? (
                <span className="rounded-md bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
                  {scriptLineCount} {t("settings.cronCommandsCount")}
                </span>
              ) : type === "http" ? (
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                    {requests.length} {t("settings.cronRequestsCount")}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 px-2.5 text-xs"
                    onClick={() => {
                      setFormError(null);
                      const draft = createEmptyRequestDraft();
                      setRequests((prev) => [...prev, draft]);
                      setExpandedRequest(draft.id);
                    }}
                  >
                    <Plus className="h-3 w-3" />
                    {t("settings.add")}
                  </Button>
                </div>
              ) : null}
            </div>

            {/* Workspace pin — first row of the config step; bash/prompt run
                inside a directory, http does not */}
            {type !== "http" ? (
              <div className="mb-4 space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">
                  {t("settings.cronWorkdirLabel")}
                </Label>
                <Select
                  value={
                    customWorkdir ? CUSTOM_WORKDIR_VALUE : workdir || FOLLOW_ACTIVE_WORKSPACE_VALUE
                  }
                  onValueChange={(value) => {
                    setFormError(null);
                    if (value === FOLLOW_ACTIVE_WORKSPACE_VALUE) {
                      setCustomWorkdir(false);
                      setWorkdir("");
                    } else if (value === CUSTOM_WORKDIR_VALUE) {
                      setCustomWorkdir(true);
                    } else {
                      setCustomWorkdir(false);
                      setWorkdir(value);
                    }
                  }}
                >
                  <SelectTrigger className="h-10">
                    <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
                          customWorkdir || workdir
                            ? "bg-amber-500/10 text-amber-500"
                            : "bg-muted/60 text-muted-foreground"
                        }`}
                      >
                        <Folder className="h-3.5 w-3.5" />
                      </span>
                      <SelectValue
                        className="truncate"
                        placeholder={t("settings.cronWorkdirFollowActive")}
                      >
                        {customWorkdir
                          ? t("settings.cronWorkdirCustom")
                          : selectedWorkspaceOption
                            ? selectedWorkspaceOption.name
                            : t("settings.cronWorkdirFollowActive")}
                      </SelectValue>
                    </span>
                  </SelectTrigger>
                  <SelectContent className="max-h-60">
                    <SelectItem
                      value={FOLLOW_ACTIVE_WORKSPACE_VALUE}
                      className="py-2 text-muted-foreground focus:text-foreground data-[highlighted]:text-foreground"
                    >
                      {t("settings.cronWorkdirFollowActive")}
                    </SelectItem>
                    <SelectItem value={CUSTOM_WORKDIR_VALUE} className="py-2">
                      {t("settings.cronWorkdirCustom")}
                    </SelectItem>
                    {workspaceOptions.length > 0 ? (
                      <div className="mx-2 my-1 h-px bg-border/60" />
                    ) : null}
                    {workspaceOptions.map((option) => (
                      <SelectItem
                        key={option.path}
                        value={option.path}
                        title={option.path}
                        description={<span className="font-mono">{option.path}</span>}
                        className="py-2"
                      >
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {customWorkdir ? (
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={workdir}
                      placeholder={t("settings.cronWorkdirCustomPlaceholder")}
                      className="flex-1 font-mono text-xs"
                      onChange={(e) => {
                        setFormError(null);
                        setWorkdir(e.currentTarget.value);
                      }}
                    />
                    {onPickWorkdir ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-9 w-9 shrink-0"
                        title={t("settings.cronWorkdirBrowse")}
                        aria-label={t("settings.cronWorkdirBrowse")}
                        onClick={() => {
                          void (async () => {
                            try {
                              const picked = await onPickWorkdir(workdir.trim());
                              const path = picked?.trim();
                              if (!path) return;
                              setFormError(null);
                              setWorkdir(path);
                            } catch (err) {
                              setFormError(err instanceof Error ? err.message : String(err));
                            }
                          })();
                        }}
                      >
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                ) : workdir ? (
                  <div
                    className="truncate font-mono text-[11px] text-muted-foreground/80"
                    title={workdir}
                  >
                    {workdir}
                  </div>
                ) : (
                  <div className="text-[11px] text-muted-foreground/60">
                    {t("settings.cronWorkdirHint")}
                  </div>
                )}
              </div>
            ) : null}

            {/* Shell script config */}
            {type === "bash" ? (
              <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/20">
                <div className="flex items-center justify-between border-b border-border/30 px-3 py-2">
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Terminal className="h-3 w-3" />
                    <span className="font-medium">{t("settings.cronCommandList")}</span>
                  </div>
                  <span className="text-[11px] text-muted-foreground/60">
                    {t("settings.cronCommandHint")}
                  </span>
                </div>
                <Textarea
                  value={scriptText}
                  placeholder={"pnpm install\npnpm build\npnpm test"}
                  className="min-h-[180px] resize-y rounded-none border-0 bg-transparent font-mono text-xs leading-relaxed focus-visible:ring-0"
                  onChange={(e) => {
                    setFormError(null);
                    setScriptText(e.currentTarget.value);
                  }}
                />
              </div>
            ) : null}

            {/* HTTP request config */}
            {type === "http" ? (
              <HttpRequestListEditor
                requests={requests}
                expandedRequestId={expandedRequest}
                onExpand={setExpandedRequest}
                onChange={setRequests}
                onDirty={() => setFormError(null)}
                urlPlaceholder="https://example.com/webhook"
              />
            ) : null}

            {/* Prompt config */}
            {type === "prompt" ? (
              <div className="space-y-3">
                {!autoPromptSupported ? (
                  <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-3.5 py-3 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                    {t("settings.cronPromptAgentModeOnlyHint")}
                  </div>
                ) : null}

                <div className="settings-form-grid grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground">
                      {t("settings.cronPromptModelLabel")}
                    </Label>
                    <ModelPicker
                      options={promptModelOptions}
                      value={selectedModelValue}
                      disabled={promptModelOptions.length === 0}
                      placeholder={t("settings.cronPromptModelPlaceholder")}
                      onChange={(value) => {
                        setFormError(null);
                        setSelectedModelValue(value);
                        const nextReasoningLevels = getCronReasoningLevels(value, providers);
                        setReasoning((current) =>
                          coerceCronReasoningLevel(nextReasoningLevels, current),
                        );
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground">
                      {t("settings.cronReasoningLabel")}
                    </Label>
                    <Select
                      value={reasoning}
                      onValueChange={(value) => {
                        setFormError(null);
                        if (isCronReasoningLevel(value)) {
                          setReasoning(value);
                        }
                      }}
                    >
                      <SelectTrigger className="h-10">
                        <SelectValue>{t(REASONING_LEVEL_I18N_KEYS[reasoning])}</SelectValue>
                      </SelectTrigger>
                      <SelectContent className="max-h-60">
                        {cronReasoningLevels.map((level) => (
                          <SelectItem key={level} value={level}>
                            {t(REASONING_LEVEL_I18N_KEYS[level])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {promptModelOptions.length === 0 ? (
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    {t("settings.cronPromptModelEmpty")}
                  </div>
                ) : null}

                <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/20">
                  <div className="flex items-center gap-1.5 border-b border-border/30 px-3 py-2 text-[11px] text-muted-foreground">
                    <MessageSquare className="h-3 w-3" />
                    <span className="font-medium">{t("settings.cronPromptLabel")}</span>
                  </div>
                  <Textarea
                    value={prompt}
                    placeholder={t("settings.cronPromptPlaceholder")}
                    className="min-h-[180px] resize-y rounded-none border-0 bg-transparent text-sm leading-relaxed focus-visible:ring-0"
                    onChange={(e) => {
                      setFormError(null);
                      setPrompt(e.currentTarget.value);
                    }}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* Footer */}
        <div className="settings-modal-footer flex items-center justify-between border-t border-border/40 px-6 py-4">
          <div className="min-w-0 flex-1">
            {formError ? (
              <div className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{formError}</span>
              </div>
            ) : formReady ? (
              <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                <span>{t("settings.agentsReady")}</span>
              </div>
            ) : null}
          </div>
          <div className="settings-modal-actions flex items-center gap-2">
            <Button variant="outline" onClick={requestClose}>
              {t("settings.cancel")}
            </Button>
            <Button
              onClick={() => void handleSave()}
              disabled={!name.trim() || !cron.trim() || isSaving || isClosing}
            >
              {t("settings.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
