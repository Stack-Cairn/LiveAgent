import {
  type CustomProvider,
  type ExecutionMode,
  getChatRuntimeReasoningLevelsForProvider,
  isAgentExecutionMode,
  isThinkingAlwaysOnForModel,
} from "@liveagent/app/lib/settings";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  MessageSquare,
  Plus,
  Terminal,
} from "@liveagent/ui/components/IconSet";
import { FormField, FormFieldLabel } from "@liveagent/ui/components/settings/FormField";
import { SettingsNotice } from "@liveagent/ui/components/settings/SettingsNotice";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type CronTask,
  type CronTaskType,
  DEFAULT_CRON_TIMEOUT_SECONDS,
  MIN_CRON_TIMEOUT_SECONDS,
  maxCronTimeoutSeconds,
  validateCronExpression,
} from "@liveagent/ui/lib/automation/index";
import { parseModelValue, toModelValue } from "@liveagent/ui/lib/models/modelValue";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { ModelPicker, type ModelPickerOption } from "@liveagent/ui/pages/settings/modelPicker";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSectionHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import {
  createEmptyRequestDraft,
  type HttpRequestDraft,
  HttpRequestListEditor,
  parseHttpRequestDrafts,
  requestToDraft,
} from "./httpRequestEditor";

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

  const supportedLevels = getChatRuntimeReasoningLevelsForProvider({
    providerId: provider.type,
    requestFormat: provider.requestFormat,
    modelId: selectedModel.model,
  }).filter(isCronReasoningLevel);
  const thinkingAlwaysOn = isThinkingAlwaysOnForModel(provider.type, selectedModel.model);

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
  const [choosingType, setChoosingType] = useState(mode === "add");
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
      const timeoutMax = maxCronTimeoutSeconds(type);
      if (
        !Number.isSafeInteger(parsedTimeoutSeconds) ||
        parsedTimeoutSeconds < MIN_CRON_TIMEOUT_SECONDS ||
        parsedTimeoutSeconds > timeoutMax
      ) {
        throw new Error(
          t("settings.cronTimeoutSecondsInvalid")
            .replace("{min}", String(MIN_CRON_TIMEOUT_SECONDS))
            .replace("{max}", String(timeoutMax)),
        );
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
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }

  const scriptLineCount = scriptText.split(/\r?\n/).filter((l) => l.trim()).length;

  const modalTitle = mode === "add" ? t("settings.cronModalAdd") : t("settings.cronModalEdit");

  return (
    <Dialog open onOpenChange={(open) => !open && !isSaving && onClose()}>
      <DialogContent
        className={cn(
          "flex max-w-xl flex-col p-0",
          choosingType ? "" : "h-[min(48rem,calc(100dvh-2rem))]",
        )}
        closeDisabled={isSaving}
        closeLabel={t("settings.cancel")}
        showCloseButton
      >
        <DialogHeader className="flex-row items-center gap-3">
          {!choosingType && mode === "add" ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("settings.cronChooseType")}
              onClick={() => setChoosingType(true)}
              disabled={isSaving}
            >
              <ArrowLeft className="size-4" />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            <DialogTitle>{choosingType ? t("settings.cronChooseType") : modalTitle}</DialogTitle>
            {!choosingType ? (
              <DialogDescription>
                {t(
                  type === "bash"
                    ? "settings.cronTypeBash"
                    : type === "http"
                      ? "settings.cronTypeHttp"
                      : "settings.cronTypePrompt",
                )}
              </DialogDescription>
            ) : null}
          </div>
        </DialogHeader>
        {choosingType ? (
          <DialogBody className="space-y-2">
            {(["bash", "http", "prompt"] as const).map((kind) => {
              const titleKey =
                kind === "bash"
                  ? "settings.cronTypeBash"
                  : kind === "http"
                    ? "settings.cronTypeHttp"
                    : "settings.cronTypePrompt";
              const hintKey =
                kind === "bash"
                  ? "settings.cronTypeBashHint"
                  : kind === "http"
                    ? "settings.cronTypeHttpHint"
                    : "settings.cronTypePromptHint";
              return (
                <Button
                  key={kind}
                  variant="ghost"
                  className={cn(
                    "h-auto w-full justify-between gap-3 px-4 py-4",
                    "rounded-xl bg-settings-tile text-left whitespace-normal hover:bg-settings-tile-hover",
                  )}
                  onClick={() => {
                    setType(kind);
                    setFormError(null);
                    setChoosingType(false);
                  }}
                >
                  <span className="space-y-1">
                    <span className="block text-sm font-medium">{t(titleKey)}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {t(hintKey)}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Button>
              );
            })}
          </DialogBody>
        ) : (
          <>
            {/* Body */}
            <DialogBody className="p-0 max-[820px]:p-0">
              <div className="border-b border-border/30 px-6 py-5">
                <div className="space-y-4">
                  <div className="grid gap-4">
                    <FormField density="compact">
                      <FormFieldLabel size="compact">{t("settings.cronTaskName")}</FormFieldLabel>
                      <Input
                        variant="plain"
                        value={name}
                        placeholder={t("settings.cronTaskNamePlaceholder")}
                        onChange={(e) => {
                          setFormError(null);
                          setName(e.currentTarget.value);
                        }}
                      />
                    </FormField>
                    <FormField density="compact">
                      <FormFieldLabel size="compact">{t("settings.cronExpression")}</FormFieldLabel>
                      <Select
                        value={
                          ["0 0 * * * *", "0 0 9 * * *", "0 0 9 * * 1-5"].includes(cron)
                            ? cron
                            : "custom"
                        }
                        onValueChange={(value) => {
                          setCron(value === "custom" ? "" : value);
                          setFormError(null);
                        }}
                      >
                        <SelectTrigger
                          className="w-full border-0 bg-settings-tile-hover shadow-none"
                          aria-label={t("settings.cronSchedulePreset")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="custom">{t("settings.cronScheduleCustom")}</SelectItem>
                          <SelectItem value="0 0 * * * *">
                            {t("settings.cronScheduleHourly")}
                          </SelectItem>
                          <SelectItem value="0 0 9 * * *">
                            {t("settings.cronScheduleDaily")}
                          </SelectItem>
                          <SelectItem value="0 0 9 * * 1-5">
                            {t("settings.cronScheduleWeekdays")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        variant="plain"
                        aria-label={t("settings.cronExpression")}
                        value={cron}
                        placeholder={t("settings.cronExpressionPlaceholder")}
                        className="font-mono"
                        onChange={(e) => {
                          setFormError(null);
                          setCron(e.currentTarget.value);
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("settings.cronExpressionHint")}
                      </p>
                    </FormField>
                  </div>
                  <div className="grid gap-4">
                    <FormField density="compact">
                      <FormFieldLabel size="compact">{t("settings.cronTaskDesc")}</FormFieldLabel>
                      <Input
                        variant="plain"
                        value={description}
                        placeholder={t("settings.cronTaskDescPlaceholder")}
                        onChange={(e) => {
                          setFormError(null);
                          setDescription(e.currentTarget.value);
                        }}
                      />
                    </FormField>
                  </div>
                </div>
              </div>

              {mode === "edit" ? (
                <FormField className="px-6 py-3">
                  <FormFieldLabel size="compact">{t("settings.cronStepType")}</FormFieldLabel>
                  <Select
                    value={type}
                    onValueChange={(value) => {
                      setType(value as CronTaskType);
                      setFormError(null);
                    }}
                  >
                    <SelectTrigger
                      className="w-full border-0 bg-settings-tile-hover shadow-none"
                      aria-label={t("settings.cronStepType")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bash">{t("settings.cronTypeBash")}</SelectItem>
                      <SelectItem value="http">{t("settings.cronTypeHttp")}</SelectItem>
                      <SelectItem value="prompt">{t("settings.cronTypePrompt")}</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
              ) : null}
              {type === "prompt" ? (
                <p className="px-6 text-xs leading-relaxed text-muted-foreground">
                  {t("settings.cronPromptRunHint")}
                </p>
              ) : null}
              <div className="px-6 py-5">
                <DialogSectionHeader>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{t("settings.cronStepConfig")}</span>
                  </div>

                  {type === "bash" ? (
                    <span className="rounded-md bg-settings-tile px-2 py-0.5 text-xs text-muted-foreground">
                      {scriptLineCount} {t("settings.cronCommandsCount")}
                    </span>
                  ) : type === "http" ? (
                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-settings-tile px-2 py-0.5 text-xs text-muted-foreground">
                        {requests.length} {t("settings.cronRequestsCount")}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1"
                        onClick={() => {
                          setFormError(null);
                          const draft = createEmptyRequestDraft();
                          setRequests((prev) => [...prev, draft]);
                          setExpandedRequest(draft.id);
                        }}
                      >
                        <Plus className="size-3" />
                        {t("settings.add")}
                      </Button>
                    </div>
                  ) : null}
                </DialogSectionHeader>

                {/* Workspace pin — first row of the config step; bash/prompt run
                inside a directory, http does not */}
                {type !== "http" ? (
                  <FormField density="compact" className="mb-4">
                    <FormFieldLabel size="compact">{t("settings.cronWorkdirLabel")}</FormFieldLabel>
                    <Select
                      value={
                        customWorkdir
                          ? CUSTOM_WORKDIR_VALUE
                          : workdir || FOLLOW_ACTIVE_WORKSPACE_VALUE
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
                      <SelectTrigger className="h-9 w-full border-0 bg-settings-tile-hover shadow-none">
                        <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
                          <span
                            className={cn(
                              "flex size-6 shrink-0 items-center justify-center rounded-md transition-colors",
                              customWorkdir || workdir
                                ? "bg-settings-tile text-muted-foreground"
                                : "bg-muted/60 text-muted-foreground",
                            )}
                          >
                            <Folder className="size-3.5" />
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
                          variant="plain"
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
                            size="icon-sm"
                            className="shrink-0"
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
                            <FolderOpen className="size-4" />
                          </Button>
                        ) : null}
                      </div>
                    ) : workdir ? (
                      <div
                        className="truncate font-mono text-xs text-muted-foreground/80"
                        title={workdir}
                      >
                        {workdir}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground/60">
                        {t("settings.cronWorkdirHint")}
                      </div>
                    )}
                  </FormField>
                ) : null}

                {/* Shell script config */}
                {type === "bash" ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between border-b border-border/30 px-3 py-2">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Terminal className="size-3" />
                        <span className="font-medium">{t("settings.cronCommandList")}</span>
                      </div>
                      <span className="text-xs text-muted-foreground/60">
                        {t("settings.cronCommandHint")}
                      </span>
                    </div>
                    <Textarea
                      variant="plain"
                      aria-label={t("settings.cronCommandList")}
                      value={scriptText}
                      placeholder={"pnpm install\npnpm build\npnpm test"}
                      className="min-h-44 resize-y font-mono text-xs leading-relaxed"
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
                    plain
                    alwaysExpanded
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
                      <div
                        className={cn(
                          "rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-3.5 py-3",
                          "text-xs leading-relaxed text-amber-700 dark:text-amber-300",
                        )}
                      >
                        {t("settings.cronPromptAgentModeOnlyHint")}
                      </div>
                    ) : null}

                    <div className="grid gap-4">
                      <FormField density="compact">
                        <FormFieldLabel size="compact">
                          {t("settings.cronPromptModelLabel")}
                        </FormFieldLabel>
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
                      </FormField>
                      <FormField density="compact">
                        <FormFieldLabel size="compact">
                          {t("settings.cronReasoningLabel")}
                        </FormFieldLabel>
                        <Select
                          value={reasoning}
                          onValueChange={(value) => {
                            setFormError(null);
                            if (isCronReasoningLevel(value)) {
                              setReasoning(value);
                            }
                          }}
                        >
                          <SelectTrigger className="h-9 w-full border-0 bg-settings-tile-hover shadow-none">
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
                      </FormField>
                    </div>
                    {promptModelOptions.length === 0 ? (
                      <div
                        className={cn(
                          "rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2 text-xs text-amber-700",
                          "dark:text-amber-300",
                        )}
                      >
                        {t("settings.cronPromptModelEmpty")}
                      </div>
                    ) : null}

                    <div className="space-y-2">
                      <div
                        className={cn(
                          "flex items-center gap-1.5 border-b border-border/30 px-3 py-2",
                          "text-xs text-muted-foreground",
                        )}
                      >
                        <MessageSquare className="size-3" />
                        <span className="font-medium">{t("settings.cronPromptLabel")}</span>
                      </div>
                      <Textarea
                        variant="plain"
                        aria-label={t("settings.cronPromptLabel")}
                        value={prompt}
                        placeholder={t("settings.cronPromptPlaceholder")}
                        className="min-h-44 resize-y text-sm leading-relaxed"
                        onChange={(e) => {
                          setFormError(null);
                          setPrompt(e.currentTarget.value);
                        }}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
              <details className="mx-6 mb-5 rounded-xl bg-settings-tile p-4">
                <summary className="cursor-pointer text-sm font-medium">
                  {t("settings.cronExecutionOptions")}
                </summary>
                <div className="mt-4 grid gap-4">
                  <FormField density="compact">
                    <FormFieldLabel size="compact">
                      {t("settings.cronRemainingExecutions")}
                    </FormFieldLabel>
                    <Input
                      variant="plain"
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
                  </FormField>
                  <FormField density="compact">
                    <FormFieldLabel size="compact">
                      {t("settings.cronTimeoutSeconds")}
                    </FormFieldLabel>
                    <Input
                      variant="plain"
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
                    <p className="text-xs text-muted-foreground/70">
                      {t("settings.cronTimeoutSecondsMaxHint").replace(
                        "{max}",
                        String(maxCronTimeoutSeconds(type)),
                      )}
                    </p>
                  </FormField>
                </div>
              </details>
            </DialogBody>

            {/* Footer */}
            <DialogFooter className="min-[821px]:justify-between">
              <div className="min-w-0 flex-1">
                {formError ? (
                  <SettingsNotice variant="inline-error">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    <span className="truncate">{formError}</span>
                  </SettingsNotice>
                ) : null}
              </div>
              <DialogActions>
                <Button variant="outline" size="sm" onClick={onClose} disabled={isSaving}>
                  {t("settings.cancel")}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleSave()}
                  disabled={!formReady || isSaving}
                >
                  {t("settings.save")}
                </Button>
              </DialogActions>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
