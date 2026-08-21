import { getUsagePlanDisplay } from "@liveagent/app/lib/providers/usageQuery";
import {
  CODEX_REQUEST_FORMAT_LABELS,
  type CodexRequestFormat,
  PROMPT_CACHE_HINT_MODES,
  type PromptCacheHintMode,
  type UsageQueryMode,
} from "@liveagent/app/lib/settings";
import {
  Check,
  ClipboardPaste,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  Key,
  Link2,
  List,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Waypoints,
  X,
  Zap,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  applyUsageQueryModePreset,
  formatTokenCount,
  setUsageQueryScript,
  USAGE_QUERY_CODING_PLAN_PROVIDERS,
} from "@liveagent/ui/pages/settings/providerUtils";
import { createPortal } from "react-dom";
import type { ProviderModalViewModel } from "./ProviderModal";
import {
  customHeaderIssueMessage,
  DialogSwitch,
  getCustomHeaderIssue,
  PROMPT_CACHE_HINT_LABEL_KEYS,
  ProviderBrandIcon,
  USAGE_QUERY_SCRIPT_HELP_EXAMPLE,
  UsagePlanLine,
} from "./ProviderPresentation";

export function ProviderModalView({ viewModel }: { viewModel: ProviderModalViewModel }) {
  const {
    activeCodingPlanProvider,
    activeModels,
    activePanel,
    addCustomHeader,
    addingModel,
    allVisibleModelsSelected,
    apiKey,
    apiKeyForRequest,
    apiKeyIsRedactedDisplay,
    applyHeaderSuggestion,
    applyModelBulkState,
    baseUrl,
    canSaveEditingModel,
    cancelCustomHeaderImport,
    commitUsageTimeoutInput,
    customHeaders,
    draggingModelId,
    editingModel,
    editingModelContextWindow,
    editingModelMaxOutputToken,
    exitModelBulkMode,
    fetchError,
    fetchingModels,
    focusCustomHeader,
    getModelReorderProps,
    handleAddModel,
    handleImportCustomHeaders,
    handleRefresh,
    handleSave,
    handleTestUsageQuery,
    headerImportErrorMessage,
    headerImportOpen,
    headerImportSummaryMessage,
    headerImportText,
    headerIssueMessage,
    headerKeyRefs,
    headerSuggest,
    headerSuggestActiveIndex,
    headerSuggestItems,
    headerValidationSubmitted,
    headerValueRefs,
    dialogOpen,
    isEditing,
    isFullUrl,
    isGatewayWebui,
    matchedBalanceProviders,
    modelBulkDisableCount,
    modelBulkEnableCount,
    modelBulkMode,
    modelBulkSelection,
    modelListRef,
    modelScrollContainerRef,
    modelSearch,
    modelSearchQuery,
    models,
    modelsUrl,
    name,
    newModelName,
    newModelPhases,
    onClose,
    openHeaderSuggest,
    openModelSettings,
    persistedUsageQueryProviderId,
    promptCacheHintMode,
    promptCacheRetention,
    promptCachingEnabled,
    providerType,
    removeCustomHeader,
    removeModel,
    renderModelDragHandle,
    requestClose,
    requestFormat,
    saveInlineModelSettings,
    selectVisibleModels,
    setActivePanel,
    setAddingModel,
    setApiKey,
    setBaseUrl,
    setEditingModel,
    setHeaderImportError,
    setHeaderImportOpen,
    setHeaderImportSummary,
    setHeaderImportText,
    setHeaderSuggest,
    setHeaderSuggestActive,
    setIsFullUrl,
    setModelBulkSelection,
    setModelSearch,
    setModelsUrl,
    setName,
    setNewModelName,
    setPromptCacheHintMode,
    setPromptCacheRetention,
    setPromptCachingEnabled,
    setRequestFormat,
    setShowApiKey,
    setShowUsageVariableApiKey,
    setUsageQuery,
    setUsageTimeoutInput,
    setUseSystemProxy,
    showApiKey,
    showUsageVariableApiKey,
    t,
    toggleModel,
    toggleModelBulkMode,
    toggleModelBulkSelection,
    typeLabel,
    updateCustomHeader,
    usageQuery,
    usageQueryConfirmDialog,
    usageQueryTest,
    usageTimeoutInput,
    usageVariableApiKey,
    usageVariableBaseUrl,
    useSystemProxy,
    visibleModels,
  } = viewModel;
  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex h-[min(600px,calc(100dvh-2rem))] max-w-[860px] flex-col p-0"
        closeLabel={t("settings.close")}
        layout="fullscreen-mobile"
        showCloseButton
      >
        <DialogHeader className="flex-row items-center gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center text-xl text-foreground">
              <ProviderBrandIcon type={providerType} />
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <DialogTitle className="text-sm leading-normal">
                {isEditing ? t("settings.editProvider") : t("settings.addProvider")}
              </DialogTitle>
              <span className="rounded-full border bg-muted/60 px-2.5 py-0.5 text-[11px] text-muted-foreground">
                {typeLabel} {t("settings.compatible")}
              </span>
            </div>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 max-[720px]:flex-col">
          <nav
            className="flex w-[172px] shrink-0 flex-col gap-1 border-r bg-muted/30 p-2.5 max-[720px]:w-full max-[720px]:flex-row max-[720px]:overflow-x-auto max-[720px]:border-b max-[720px]:border-r-0 max-[720px]:px-2.5 max-[720px]:py-2"
            aria-label={t("settings.providerDialogNavigation")}
          >
            <button
              type="button"
              className={cn(
                "flex h-10 items-center gap-2 rounded-lg px-3 text-left text-sm text-muted-foreground max-[720px]:min-w-max max-[720px]:flex-1 max-[720px]:justify-center max-[720px]:px-2 max-[720px]:text-xs transition-colors hover:bg-accent/50 hover:text-foreground",
                activePanel === "general" && "bg-primary/10 font-medium text-primary",
              )}
              onClick={() => setActivePanel("general")}
              aria-current={activePanel === "general" ? "page" : undefined}
            >
              <Settings className="h-4 w-4 shrink-0 max-[720px]:h-3.5 max-[720px]:w-3.5" />
              {t("settings.providerDialogGeneral")}
            </button>
            <button
              type="button"
              className={cn(
                "flex h-10 items-center gap-2 rounded-lg px-3 text-left text-sm text-muted-foreground max-[720px]:min-w-max max-[720px]:flex-1 max-[720px]:justify-center max-[720px]:px-2 max-[720px]:text-xs transition-colors hover:bg-accent/50 hover:text-foreground",
                activePanel === "request" && "bg-primary/10 font-medium text-primary",
              )}
              onClick={() => {
                exitModelBulkMode();
                setActivePanel("request");
              }}
              aria-current={activePanel === "request" ? "page" : undefined}
            >
              <Globe className="h-4 w-4 shrink-0 max-[720px]:h-3.5 max-[720px]:w-3.5" />
              <span className="min-w-0 flex-1 max-[720px]:flex-none max-[720px]:basis-auto">
                {t("settings.providerDialogRequest")}
              </span>
              {customHeaders.length > 0 ? (
                <span
                  className={cn(
                    "min-w-5 rounded-full bg-muted px-1.5 py-0.5 text-center text-[10px] tabular-nums text-muted-foreground",
                    activePanel === "request" && "bg-primary text-primary-foreground",
                  )}
                >
                  {customHeaders.length}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              className={cn(
                "flex h-10 items-center gap-2 rounded-lg px-3 text-left text-sm text-muted-foreground max-[720px]:min-w-max max-[720px]:flex-1 max-[720px]:justify-center max-[720px]:px-2 max-[720px]:text-xs transition-colors hover:bg-accent/50 hover:text-foreground",
                activePanel === "usage" && "bg-primary/10 font-medium text-primary",
              )}
              onClick={() => {
                exitModelBulkMode();
                setActivePanel("usage");
              }}
              aria-current={activePanel === "usage" ? "page" : undefined}
            >
              <Key className="h-4 w-4 shrink-0 max-[720px]:h-3.5 max-[720px]:w-3.5" />
              {t("settings.providerUsageQuery")}
            </button>
          </nav>

          <DialogBody
            ref={modelScrollContainerRef}
            className="min-w-0 [overflow-anchor:none] px-6 py-5"
            onScroll={() => setHeaderSuggest(null)}
          >
            {activePanel === "general" ? (
              <section key="general" className="provider-panel-enter">
                <div className="text-sm font-semibold">{t("settings.basicInformation")}</div>

                <div className="mt-3 space-y-1.5">
                  <Label htmlFor="modal-name">{t("settings.providerName")}</Label>
                  <Input
                    id="modal-name"
                    value={name}
                    onChange={(event) => setName(event.currentTarget.value)}
                  />
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                  <div className="space-y-1.5">
                    <div className="flex min-h-7 flex-wrap items-center gap-2.5">
                      <Label htmlFor="modal-baseurl">{t("settings.baseUrl")}</Label>
                      <div className="flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2 py-0.5">
                        <Link2
                          className={cn(
                            "h-3.5 w-3.5",
                            isFullUrl ? "text-sky-500" : "text-muted-foreground",
                          )}
                        />
                        <span
                          className={cn(
                            "text-xs font-medium",
                            isFullUrl ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {t("settings.providerFullUrl")}
                        </span>
                        <Switch
                          checked={isFullUrl}
                          onCheckedChange={setIsFullUrl}
                          aria-label={t("settings.providerFullUrl")}
                          title={t("settings.providerFullUrl")}
                        />
                      </div>
                    </div>
                    <Input
                      id="modal-baseurl"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.currentTarget.value)}
                    />
                    {isFullUrl ? (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t("settings.providerFullUrlHint")}
                      </p>
                    ) : null}
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex min-h-7 items-center">
                      <Label htmlFor="modal-apikey">API Key</Label>
                    </div>
                    <div className="relative">
                      <Input
                        id="modal-apikey"
                        type={showApiKey ? "text" : "password"}
                        value={apiKey}
                        className="pr-10"
                        onChange={(event) => setApiKey(event.currentTarget.value)}
                        onFocus={(event) => {
                          if (apiKeyIsRedactedDisplay) event.currentTarget.select();
                        }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-10 w-10 text-muted-foreground hover:bg-transparent hover:text-foreground"
                        onClick={() => setShowApiKey((prev) => !prev)}
                        title={showApiKey ? t("settings.hideApiKey") : t("settings.showApiKey")}
                        aria-label={
                          showApiKey ? t("settings.hideApiKey") : t("settings.showApiKey")
                        }
                      >
                        {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                </div>

                {providerType !== "gemini" ? (
                  <div className="mt-3 space-y-1.5">
                    <Label htmlFor="modal-models-url">{t("settings.providerModelsUrl")}</Label>
                    <Input
                      id="modal-models-url"
                      value={modelsUrl}
                      placeholder={t("settings.providerModelsUrlPlaceholder")}
                      onChange={(event) => setModelsUrl(event.currentTarget.value)}
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t("settings.providerModelsUrlHint")}
                    </p>
                  </div>
                ) : null}

                {providerType === "codex" ? (
                  <div className="mt-4 space-y-1.5">
                    <Label>{t("settings.requestFormat")}</Label>
                    <Select
                      value={requestFormat}
                      onValueChange={(value) => setRequestFormat(value as CodexRequestFormat)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue>{CODEX_REQUEST_FORMAT_LABELS[requestFormat]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(CODEX_REQUEST_FORMAT_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}

                <div className="mt-6 text-sm font-semibold">{t("settings.models")}</div>
                <div className="mt-3 overflow-hidden rounded-xl border">
                  <div className="flex items-center gap-2 border-b bg-muted/30 p-2.5 max-[720px]:flex-wrap">
                    <div className="relative min-w-0 flex-1 max-[720px]:basis-full">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={modelSearch}
                        className="h-9 pl-9 pr-9 text-xs"
                        placeholder={t("settings.searchModels")}
                        aria-label={t("settings.searchModels")}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setModelSearch(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setModelSearch("");
                        }}
                      />
                      {modelSearch ? (
                        <button
                          type="button"
                          className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          onClick={() => setModelSearch("")}
                          title={t("settings.clearModelSearch")}
                          aria-label={t("settings.clearModelSearch")}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant={modelBulkMode ? "secondary" : "outline"}
                      size="sm"
                      className="h-9 gap-1.5 max-[720px]:h-10 max-[720px]:min-w-36 max-[720px]:flex-1"
                      aria-pressed={modelBulkMode}
                      title={
                        modelBulkMode
                          ? t("settings.skillsBulkDone")
                          : t("settings.skillsBulkSelect")
                      }
                      onClick={toggleModelBulkMode}
                    >
                      <List className="h-3.5 w-3.5" />
                      {modelBulkMode
                        ? t("settings.skillsBulkDone")
                        : t("settings.skillsBulkSelect")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 gap-1.5 max-[720px]:h-10 max-[720px]:min-w-36 max-[720px]:flex-1"
                      onClick={handleRefresh}
                      disabled={fetchingModels}
                    >
                      <RefreshCw className={cn("h-3.5 w-3.5", fetchingModels && "animate-spin")} />
                      {fetchingModels ? t("settings.fetching") : t("settings.refreshModels")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 gap-1.5 max-[720px]:h-10 max-[720px]:min-w-36 max-[720px]:flex-1"
                      onClick={() => setAddingModel(true)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("settings.manualAddModel")}
                    </Button>
                  </div>

                  {modelBulkMode ? (
                    <div className="flex flex-wrap items-center justify-end gap-1.5 border-b bg-background px-2.5 py-2 dark:bg-popover">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        disabled={visibleModels.length === 0 || allVisibleModelsSelected}
                        onClick={selectVisibleModels}
                      >
                        {t("settings.skillsBulkSelectAll")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        disabled={modelBulkSelection.size === 0}
                        onClick={() => setModelBulkSelection(new Set())}
                      >
                        {t("settings.skillsBulkClear")}
                      </Button>
                    </div>
                  ) : null}

                  {fetchError ? (
                    <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {fetchError}
                    </div>
                  ) : null}

                  {addingModel ? (
                    <div className="settings-inline-form flex gap-2 border-b bg-muted/20 p-2.5 max-[720px]:flex-wrap">
                      <Input
                        autoFocus
                        value={newModelName}
                        className="h-9 text-sm max-[720px]:h-10 max-[720px]:basis-full"
                        placeholder={t("settings.modelName")}
                        onChange={(event) => setNewModelName(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") handleAddModel();
                          if (event.key === "Escape") setAddingModel(false);
                        }}
                      />
                      <Button size="sm" className="h-9" onClick={handleAddModel}>
                        {t("settings.add")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-9"
                        onClick={() => setAddingModel(false)}
                      >
                        {t("settings.cancel")}
                      </Button>
                    </div>
                  ) : null}

                  <div ref={modelListRef} className="divide-y">
                    {visibleModels.length === 0 ? (
                      <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                        {models.length > 0 && modelSearchQuery
                          ? t("settings.noMatchingModels")
                          : baseUrl.trim() && apiKeyForRequest
                            ? t("settings.fetchFailed")
                            : t("settings.fetchHint")}
                      </div>
                    ) : (
                      visibleModels.map((model) => {
                        const isEditingModel = editingModel?.model.id === model.id;
                        const newModelPhase = newModelPhases.get(model.id);
                        return (
                          // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useAriaPropsSupportedByRole: The row becomes an accessible checkbox only while bulk mode is active.
                          <div
                            key={model.id}
                            {...getModelReorderProps(model.id)}
                            data-model-row-id={model.id}
                            className={cn(
                              "settings-model-row group transition-colors duration-500 hover:bg-accent/30",
                              draggingModelId === model.id && "bg-accent shadow-lg",
                              modelBulkMode && "cursor-pointer",
                              modelBulkSelection.has(model.id) && "bg-primary/5",
                              newModelPhase === "visible" && "bg-primary/10 hover:bg-primary/15",
                              newModelPhase === "fading" && "bg-primary/[0.04]",
                            )}
                            role={modelBulkMode ? "checkbox" : undefined}
                            aria-checked={
                              modelBulkMode ? modelBulkSelection.has(model.id) : undefined
                            }
                            tabIndex={modelBulkMode ? 0 : undefined}
                            onClick={() => {
                              if (modelBulkMode) toggleModelBulkSelection(model.id);
                            }}
                            onKeyDown={(event) => {
                              if (
                                !modelBulkMode ||
                                event.target !== event.currentTarget ||
                                (event.key !== "Enter" && event.key !== " ")
                              ) {
                                return;
                              }
                              event.preventDefault();
                              toggleModelBulkSelection(model.id);
                            }}
                          >
                            <div className="flex items-center gap-2 px-3 py-2 max-[720px]:grid max-[720px]:grid-cols-[auto_minmax(0,1fr)_2.5rem_2.5rem]">
                              <div className="flex shrink-0 items-center gap-1">
                                {renderModelDragHandle(model.id, model.id)}
                                {modelBulkMode ? (
                                  <label
                                    className="relative flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center"
                                    title={t("settings.skillsHubBulkSelectLabel")}
                                    onClick={(event) => event.stopPropagation()}
                                    onKeyDown={(event) => event.stopPropagation()}
                                  >
                                    <input
                                      type="checkbox"
                                      className="peer sr-only"
                                      checked={modelBulkSelection.has(model.id)}
                                      aria-label={`${t("settings.skillsHubBulkSelectLabel")}: ${model.id}`}
                                      onChange={() => toggleModelBulkSelection(model.id)}
                                    />
                                    <span
                                      aria-hidden="true"
                                      className={cn(
                                        "pointer-events-none flex h-5 w-5 items-center justify-center rounded-full border transition-colors",
                                        modelBulkSelection.has(model.id)
                                          ? "border-primary bg-primary text-primary-foreground"
                                          : "border-border bg-background group-hover:border-foreground/40",
                                      )}
                                    >
                                      {modelBulkSelection.has(model.id) ? (
                                        <Check className="h-3 w-3" />
                                      ) : null}
                                    </span>
                                  </label>
                                ) : (
                                  <DialogSwitch
                                    checked={activeModels.has(model.id)}
                                    onCheckedChange={() => toggleModel(model.id)}
                                    ariaLabel={model.id}
                                  />
                                )}
                              </div>
                              <div className="min-w-0 flex-1 max-[720px]:col-[2/5] max-[720px]:row-start-1">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className="truncate text-sm font-medium">{model.id}</span>
                                  {newModelPhase ? (
                                    <span
                                      className={cn(
                                        "shrink-0 rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold leading-none tracking-wide text-primary transition-all duration-500 max-[420px]:px-1.5",
                                        newModelPhase === "fading" && "scale-95 opacity-0",
                                      )}
                                    >
                                      {t("settings.newModelBadge")}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                              <div className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground max-[720px]:col-[1/3] max-[720px]:row-start-2 max-[720px]:min-w-0">
                                {formatTokenCount(model.contextWindow)} ctx ·{" "}
                                {formatTokenCount(model.maxOutputToken)} out
                                {model.limitsSource === "fallback" ? (
                                  <span className="ml-1.5 rounded-full border border-border/70 bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
                                    {t("settings.estimatedLimitsBadge")}
                                  </span>
                                ) : null}
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className={cn(
                                  "h-10 w-10 shrink-0 text-muted-foreground hover:text-foreground max-[720px]:col-start-3 max-[720px]:row-start-2",
                                  isEditingModel && "bg-primary/10 text-primary",
                                )}
                                disabled={modelBulkMode}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openModelSettings(model.id);
                                }}
                                title={t("settings.modelSettings")}
                                aria-label={t("settings.modelSettings")}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-10 w-10 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive max-[720px]:col-start-4 max-[720px]:row-start-2"
                                disabled={modelBulkMode}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  removeModel(model.id);
                                }}
                                title={t("settings.delete")}
                                aria-label={t("settings.delete")}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>

                            {isEditingModel && editingModel ? (
                              <div className="mx-3 mb-3 rounded-lg border bg-muted/20 p-3">
                                <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                                  <div className="space-y-1.5">
                                    <Label>{t("settings.contextWindow")}</Label>
                                    <Input
                                      inputMode="numeric"
                                      aria-invalid={
                                        editingModelContextWindow === null ? true : undefined
                                      }
                                      className={cn(
                                        editingModelContextWindow === null &&
                                          "ring-1 ring-inset ring-destructive focus-visible:ring-destructive",
                                      )}
                                      value={editingModel.contextWindow}
                                      onChange={(event) => {
                                        const value = event.currentTarget.value;
                                        setEditingModel((prev) =>
                                          prev ? { ...prev, contextWindow: value } : prev,
                                        );
                                      }}
                                    />
                                  </div>
                                  <div className="space-y-1.5">
                                    <Label>{t("settings.maxOutputToken")}</Label>
                                    <Input
                                      inputMode="numeric"
                                      aria-invalid={
                                        editingModelMaxOutputToken === null ? true : undefined
                                      }
                                      className={cn(
                                        editingModelMaxOutputToken === null &&
                                          "ring-1 ring-inset ring-destructive focus-visible:ring-destructive",
                                      )}
                                      value={editingModel.maxOutputToken}
                                      onChange={(event) => {
                                        const value = event.currentTarget.value;
                                        setEditingModel((prev) =>
                                          prev ? { ...prev, maxOutputToken: value } : prev,
                                        );
                                      }}
                                    />
                                  </div>
                                  {providerType === "codex" ? (
                                    <div className="col-span-2 space-y-1.5 max-[720px]:col-span-1">
                                      <Label>{t("settings.promptCacheHintModelOverride")}</Label>
                                      <Select
                                        value={editingModel.model.promptCacheHintMode ?? "inherit"}
                                        onValueChange={(value) =>
                                          setEditingModel((prev) =>
                                            prev
                                              ? {
                                                  ...prev,
                                                  model: {
                                                    ...prev.model,
                                                    promptCacheHintMode:
                                                      value === "inherit"
                                                        ? undefined
                                                        : (value as PromptCacheHintMode),
                                                  },
                                                }
                                              : prev,
                                          )
                                        }
                                      >
                                        <SelectTrigger>
                                          {/* value≠label：闭合态必须显式渲染本地化标签。 */}
                                          <SelectValue>
                                            {t(
                                              editingModel.model.promptCacheHintMode
                                                ? PROMPT_CACHE_HINT_LABEL_KEYS[
                                                    editingModel.model.promptCacheHintMode
                                                  ]
                                                : "settings.promptCacheHintMode.inherit",
                                            )}
                                          </SelectValue>
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="inherit">
                                            {t("settings.promptCacheHintMode.inherit")}
                                          </SelectItem>
                                          {PROMPT_CACHE_HINT_MODES.map((mode) => (
                                            <SelectItem key={mode} value={mode}>
                                              {t(PROMPT_CACHE_HINT_LABEL_KEYS[mode])}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  ) : null}
                                </div>

                                {!canSaveEditingModel ? (
                                  <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                                    {t("settings.positiveIntegerRequired")}
                                  </div>
                                ) : null}

                                <div className="mt-3 flex justify-end gap-2">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setEditingModel(null)}
                                  >
                                    {t("settings.cancel")}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    disabled={!canSaveEditingModel}
                                    onClick={saveInlineModelSettings}
                                  >
                                    {t("settings.save")}
                                  </Button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </section>
            ) : activePanel === "request" ? (
              <section key="request" className="provider-panel-enter">
                <div className="text-sm font-semibold">{t("settings.providerDialogRequest")}</div>

                <div
                  className={cn(
                    "mt-3 flex items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors",
                    useSystemProxy && "border-primary/35 bg-primary/[0.04]",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors",
                      useSystemProxy && "bg-primary/15 text-primary",
                    )}
                  >
                    <Waypoints className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1 text-sm font-medium">
                    {t("settings.providerUseSystemProxy")}
                  </div>
                  <DialogSwitch
                    checked={useSystemProxy}
                    onCheckedChange={setUseSystemProxy}
                    ariaLabel={t("settings.providerUseSystemProxy")}
                  />
                </div>

                {providerType !== "gemini" &&
                providerType !== "xai" &&
                providerType !== "deepseek" ? (
                  <div
                    className={cn(
                      "mt-3 rounded-xl border bg-card px-4 py-3 transition-colors",
                      (providerType === "codex"
                        ? promptCacheHintMode !== "none"
                        : promptCachingEnabled) && "border-primary/35 bg-primary/[0.04]",
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={cn(
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors",
                          (providerType === "codex"
                            ? promptCacheHintMode !== "none"
                            : promptCachingEnabled) && "bg-primary/15 text-primary",
                        )}
                      >
                        <Zap className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{t("settings.promptCaching")}</div>
                        <div className="text-xs text-muted-foreground">
                          {providerType === "claude_code"
                            ? t("settings.promptCachingDescClaude")
                            : t("settings.promptCachingDescCodex")}
                        </div>
                      </div>
                      {providerType === "claude_code" ? (
                        <DialogSwitch
                          checked={promptCachingEnabled}
                          onCheckedChange={setPromptCachingEnabled}
                          ariaLabel={t("settings.promptCaching")}
                        />
                      ) : null}
                    </div>
                    {providerType === "codex" ? (
                      <div className="mt-3 border-t pt-3">
                        <Select
                          value={promptCacheHintMode}
                          onValueChange={(value) =>
                            setPromptCacheHintMode(value as PromptCacheHintMode)
                          }
                        >
                          <SelectTrigger aria-label={t("settings.promptCacheHintMode")}>
                            {/* value≠label：闭合态必须显式渲染本地化标签。 */}
                            <SelectValue>
                              {t(PROMPT_CACHE_HINT_LABEL_KEYS[promptCacheHintMode])}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {PROMPT_CACHE_HINT_MODES.map((mode) => (
                              <SelectItem key={mode} value={mode}>
                                {t(PROMPT_CACHE_HINT_LABEL_KEYS[mode])}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : null}
                    {providerType === "claude_code" && promptCachingEnabled ? (
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
                        <span className="text-xs text-muted-foreground">
                          {t("settings.promptCacheRetention")}
                        </span>
                        {(
                          [
                            ["short", "settings.promptCacheRetentionShort"],
                            ["long", "settings.promptCacheRetentionLong"],
                          ] as const
                        ).map(([value, labelKey]) => (
                          <button
                            key={value}
                            type="button"
                            className={cn(
                              "rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary",
                              promptCacheRetention === value &&
                                "border-primary bg-primary/10 text-primary",
                            )}
                            aria-pressed={promptCacheRetention === value}
                            onClick={() => setPromptCacheRetention(value)}
                          >
                            {t(labelKey)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2 max-[720px]:w-full">
                    <span className="text-sm font-semibold">{t("settings.customHeaders")}</span>
                    {customHeaders.length > 0 ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                        {customHeaders.length}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-2 max-[720px]:w-full">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={cn(
                        "h-8 shrink-0 gap-1.5 max-[720px]:h-11 max-[720px]:flex-1",
                        headerImportOpen && "border-primary/50 bg-primary/10 text-primary",
                      )}
                      aria-expanded={headerImportOpen}
                      onClick={() => {
                        setHeaderImportOpen((open) => !open);
                        setHeaderImportError(null);
                        setHeaderImportSummary(null);
                        setHeaderSuggest(null);
                      }}
                    >
                      <ClipboardPaste className="h-3.5 w-3.5" />
                      {t("settings.importCustomHeaders")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0 gap-1.5 max-[720px]:h-11 max-[720px]:flex-1"
                      /* 导入视图占据了列表位置,此时新增行不可见,禁用避免静默无响应。 */
                      disabled={headerImportOpen}
                      onClick={() => addCustomHeader()}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("settings.addCustomHeader")}
                    </Button>
                  </div>
                </div>

                {headerImportOpen ? (
                  <div className="provider-panel-enter mt-3 min-w-0 rounded-xl border bg-card p-3">
                    <Label
                      htmlFor="provider-custom-header-import"
                      className="mb-2 block text-xs font-medium"
                    >
                      {t("settings.customHeaderImportLabel")}
                    </Label>
                    <Textarea
                      id="provider-custom-header-import"
                      value={headerImportText}
                      className="min-h-[120px] w-full min-w-0 resize-y font-mono text-xs leading-relaxed"
                      placeholder={t("settings.customHeaderImportPlaceholder")}
                      aria-invalid={headerImportErrorMessage ? true : undefined}
                      aria-describedby={
                        headerImportErrorMessage ? "provider-custom-header-import-error" : undefined
                      }
                      spellCheck={false}
                      autoFocus
                      onChange={(event) => {
                        setHeaderImportText(event.currentTarget.value);
                        setHeaderImportError(null);
                        setHeaderImportSummary(null);
                      }}
                    />
                    {headerImportErrorMessage ? (
                      <p
                        id="provider-custom-header-import-error"
                        className="mt-2 text-xs text-destructive"
                        role="alert"
                      >
                        {headerImportErrorMessage}
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap justify-end gap-2 max-[720px]:w-full">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-9 max-[720px]:h-11 max-[720px]:flex-1"
                        onClick={cancelCustomHeaderImport}
                      >
                        {t("settings.cancelCustomHeaderImport")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-9 max-[720px]:h-11 max-[720px]:flex-1"
                        onClick={handleImportCustomHeaders}
                      >
                        {t("settings.parseAndImportCustomHeaders")}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {headerImportSummaryMessage ? (
                  <p
                    className="mt-3 rounded-lg border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
                    role="status"
                    aria-live="polite"
                  >
                    {headerImportSummaryMessage}
                  </p>
                ) : null}

                {/* 导入视图与请求头列表互斥:解析成功后回到列表,直接看到增量导入的结果。 */}
                {headerImportOpen ? null : customHeaders.length === 0 ? (
                  <button
                    type="button"
                    className="mt-3 flex w-full flex-col items-center gap-1 rounded-xl border border-dashed px-4 py-8 text-center transition-colors hover:border-primary/50 hover:bg-accent/20"
                    onClick={() => addCustomHeader()}
                  >
                    <List className="h-5 w-5 text-muted-foreground/60" />
                    <span className="mt-1 text-xs font-medium text-muted-foreground">
                      {t("settings.noCustomHeaders")}
                    </span>
                    <span className="text-[11px] text-muted-foreground/75">
                      {t("settings.noCustomHeadersHint")}
                    </span>
                  </button>
                ) : (
                  <div className="mt-3 space-y-2">
                    <div
                      className="-m-0.5 max-h-[196px] space-y-2 overflow-y-auto p-0.5 max-[720px]:max-h-[360px]"
                      onScroll={() => setHeaderSuggest(null)}
                    >
                      {customHeaders.map((header, index) => {
                        const issue = getCustomHeaderIssue(header, headerValidationSubmitted);
                        const issueTitle = issue ? customHeaderIssueMessage(issue, t) : undefined;
                        const valueIssue = issue === "invalid-value";
                        const keyIssue = issue !== null && !valueIssue;
                        const suggestOpen =
                          headerSuggest?.index === index && headerSuggestItems.length > 0;

                        return (
                          <div
                            // biome-ignore lint/suspicious/noArrayIndexKey: Header rows are an ordered, controlled editor whose mutation API is intentionally index-based; content-derived keys would remount inputs on every keystroke.
                            key={index}
                            className={cn(
                              "provider-panel-enter group relative flex items-stretch overflow-hidden rounded-lg border bg-card transition-all focus-within:border-primary/45 focus-within:ring-2 focus-within:ring-primary/10 hover:border-muted-foreground/30 max-[720px]:flex-wrap",
                              issue &&
                                "border-destructive/60 focus-within:border-destructive focus-within:ring-destructive/10",
                            )}
                          >
                            <Input
                              ref={(element) => {
                                headerKeyRefs.current[index] = element;
                              }}
                              value={header.key}
                              className={cn(
                                "h-10 w-[210px] shrink-0 rounded-none border-0 border-r bg-muted/30 px-3 font-mono text-xs shadow-none focus-visible:ring-0 max-[720px]:w-full max-[720px]:border-b max-[720px]:border-r-0 max-[720px]:bg-muted/40",
                                keyIssue && "text-destructive",
                              )}
                              placeholder={t("settings.customHeaderKeyPlaceholder")}
                              aria-label={t("settings.customHeaderName")}
                              aria-invalid={keyIssue ? true : undefined}
                              role="combobox"
                              aria-expanded={suggestOpen}
                              aria-controls={suggestOpen ? "provider-header-suggest" : undefined}
                              aria-autocomplete="list"
                              title={issueTitle}
                              autoComplete="off"
                              spellCheck={false}
                              onChange={(event) => {
                                updateCustomHeader(index, "key", event.currentTarget.value);
                                openHeaderSuggest(index);
                              }}
                              onFocus={() => openHeaderSuggest(index)}
                              onBlur={() => setHeaderSuggest(null)}
                              onKeyDown={(event) => {
                                if (event.key === "ArrowDown") {
                                  event.preventDefault();
                                  if (suggestOpen) {
                                    setHeaderSuggestActive(
                                      (headerSuggestActiveIndex + 1) % headerSuggestItems.length,
                                    );
                                  } else {
                                    openHeaderSuggest(index);
                                  }
                                  return;
                                }
                                if (event.key === "ArrowUp" && suggestOpen) {
                                  event.preventDefault();
                                  setHeaderSuggestActive(
                                    (headerSuggestActiveIndex - 1 + headerSuggestItems.length) %
                                      headerSuggestItems.length,
                                  );
                                  return;
                                }
                                if (event.key === "Escape" && headerSuggest) {
                                  event.preventDefault();
                                  setHeaderSuggest(null);
                                  return;
                                }
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                if (suggestOpen) {
                                  applyHeaderSuggestion(
                                    headerSuggestItems[headerSuggestActiveIndex],
                                  );
                                  return;
                                }
                                focusCustomHeader(index, "value");
                              }}
                            />
                            <div className="relative min-w-0 flex-1 max-[720px]:basis-full">
                              <Input
                                ref={(element) => {
                                  headerValueRefs.current[index] = element;
                                }}
                                type="text"
                                value={header.value}
                                className={cn(
                                  "h-10 w-full rounded-none border-0 bg-transparent pl-3 pr-11 font-mono text-xs shadow-none focus-visible:ring-0",
                                  valueIssue && "text-destructive",
                                )}
                                placeholder={t("settings.customHeaderValue")}
                                aria-label={t("settings.customHeaderValue")}
                                aria-invalid={valueIssue ? true : undefined}
                                title={valueIssue ? issueTitle : undefined}
                                autoComplete="off"
                                spellCheck={false}
                                onChange={(event) =>
                                  updateCustomHeader(index, "value", event.currentTarget.value)
                                }
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter") return;
                                  event.preventDefault();
                                  if (index === customHeaders.length - 1) addCustomHeader();
                                  else focusCustomHeader(index + 1, "key");
                                }}
                              />
                              <div className="settings-hover-actions absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 max-[720px]:opacity-100">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                  onClick={() => removeCustomHeader(index)}
                                  title={t("settings.removeCustomHeader")}
                                  aria-label={t("settings.removeCustomHeader")}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {headerIssueMessage && !headerImportOpen ? (
                  <p className="mt-2 text-xs leading-relaxed text-destructive" role="alert">
                    {headerIssueMessage}
                  </p>
                ) : null}

                {headerSuggest && headerSuggestItems.length > 0
                  ? createPortal(
                      <div
                        id="provider-header-suggest"
                        role="listbox"
                        className="layer-popover fixed overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
                        style={{
                          left: headerSuggest.rect.left,
                          top: headerSuggest.rect.top,
                          width: headerSuggest.rect.width,
                        }}
                      >
                        {headerSuggestItems.map((preset, itemIndex) => (
                          <button
                            key={preset}
                            type="button"
                            role="option"
                            aria-selected={itemIndex === headerSuggestActiveIndex}
                            className={cn(
                              "flex w-full items-center rounded-md px-2.5 py-2 text-left font-mono text-xs text-muted-foreground transition-colors",
                              itemIndex === headerSuggestActiveIndex && "bg-accent text-foreground",
                            )}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseEnter={() => setHeaderSuggestActive(itemIndex)}
                            onClick={() => applyHeaderSuggestion(preset)}
                          >
                            {preset}
                          </button>
                        ))}
                      </div>,
                      document.body,
                    )
                  : null}
              </section>
            ) : (
              <section key="usage" className="provider-panel-enter">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{t("settings.providerUsageQuery")}</div>
                  </div>
                  <DialogSwitch
                    checked={usageQuery.enabled}
                    onCheckedChange={(enabled) =>
                      setUsageQuery((previous) => ({ ...previous, enabled }))
                    }
                    ariaLabel={t("settings.providerUsageEnabled")}
                  />
                </div>

                {/* 未启用时隐藏全部配置与测试入口,只留开关。 */}
                {usageQuery.enabled ? (
                  <>
                    {/* 功能出处:居中带字分隔线,项目名是带图标的主色链接。 */}
                    <div className="mt-3 flex items-center gap-2 text-xs leading-5 text-muted-foreground">
                      <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-border" />
                      <span className="shrink-0">{t("settings.providerUsageCredit")}</span>
                      <a
                        href="https://github.com/farion1231/cc-switch"
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex shrink-0 items-center gap-1 font-medium text-primary transition-colors hover:underline"
                        title={t("settings.providerUsageCreditOpen")}
                        aria-label={t("settings.providerUsageCreditOpen")}
                      >
                        cc-switch
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                      <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-border" />
                    </div>

                    <div className="mt-4 space-y-1.5">
                      <Label>{t("settings.providerUsageMode")}</Label>
                      <Select
                        value={usageQuery.mode}
                        onValueChange={(mode) =>
                          setUsageQuery((previous) =>
                            applyUsageQueryModePreset(previous, mode as UsageQueryMode),
                          )
                        }
                      >
                        <SelectTrigger className="w-full">
                          {/* value≠label:闭合态必须显式渲染本地化标签(coding-plan → codingPlan 键)。 */}
                          <SelectValue>
                            {t(
                              usageQuery.mode === "coding-plan"
                                ? "settings.providerUsageMode.codingPlan"
                                : `settings.providerUsageMode.${usageQuery.mode}`,
                            )}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="custom">
                            {t("settings.providerUsageMode.custom")}
                          </SelectItem>
                          <SelectItem value="general">
                            {t("settings.providerUsageMode.general")}
                          </SelectItem>
                          <SelectItem value="newapi">
                            {t("settings.providerUsageMode.newapi")}
                          </SelectItem>
                          <SelectItem value="balance">
                            {t("settings.providerUsageMode.balance")}
                          </SelectItem>
                          <SelectItem value="coding-plan">
                            {t("settings.providerUsageMode.codingPlan")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {usageQuery.mode !== "custom" ? (
                      <p className="mt-3 rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
                        {usageQuery.mode === "general"
                          ? t("settings.providerUsageTemplate.general")
                          : usageQuery.mode === "newapi"
                            ? t("settings.providerUsageTemplate.newapi")
                            : usageQuery.mode === "balance"
                              ? t("settings.providerUsageTemplate.balance")
                              : t("settings.providerUsageTemplate.codingPlan")}
                      </p>
                    ) : null}

                    {/* 官方余额:按 Base URL 匹配到的供应商徽章。 */}
                    {usageQuery.mode === "balance" && matchedBalanceProviders.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {matchedBalanceProviders.map((entry) => (
                          <span
                            key={entry.id}
                            className="inline-flex items-center rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
                          >
                            {entry.label}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    {/* 只有通用模板需要用户自行填写 baseUrl / apiKey 覆盖。 */}
                    {usageQuery.mode === "general" ? (
                      <div className="mt-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                        <div className="space-y-1.5">
                          <Label htmlFor="usage-query-base-url">
                            {t("settings.providerUsageBaseUrl")}
                          </Label>
                          <Input
                            id="usage-query-base-url"
                            value={usageQuery.baseUrl}
                            placeholder={baseUrl.trim() || undefined}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              setUsageQuery((previous) => ({
                                ...previous,
                                baseUrl: value,
                              }));
                            }}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="usage-query-api-key">
                            {t("settings.providerUsageApiKey")}
                          </Label>
                          <Input
                            id="usage-query-api-key"
                            type="password"
                            value={usageQuery.apiKey}
                            autoComplete="off"
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              setUsageQuery((previous) => ({
                                ...previous,
                                apiKey: value,
                              }));
                            }}
                          />
                        </div>
                      </div>
                    ) : null}

                    {/* 自定义模式:只读展示变量的实际生效值(对齐 cc-switch 支持的变量区)。 */}
                    {usageQuery.mode === "custom" ? (
                      <div className="mt-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs leading-5">
                        <div className="font-medium text-foreground">
                          {t("settings.providerUsageVariables")}
                        </div>
                        <div className="mt-2 flex min-w-0 items-center gap-2">
                          <code className="shrink-0 font-mono text-emerald-600 dark:text-emerald-400">
                            {"{{baseUrl}}"}
                          </code>
                          <span className="text-muted-foreground/60">=</span>
                          {usageVariableBaseUrl ? (
                            <code className="break-all font-mono text-muted-foreground">
                              {usageVariableBaseUrl}
                            </code>
                          ) : (
                            <span className="text-muted-foreground/60 italic">
                              {t("settings.providerUsageVariableNotSet")}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex min-w-0 items-center gap-2">
                          <code className="shrink-0 font-mono text-emerald-600 dark:text-emerald-400">
                            {"{{apiKey}}"}
                          </code>
                          <span className="text-muted-foreground/60">=</span>
                          {usageVariableApiKey ? (
                            <>
                              <code className="break-all font-mono text-muted-foreground">
                                {!isGatewayWebui && showUsageVariableApiKey
                                  ? usageVariableApiKey
                                  : "••••••••"}
                              </code>
                              {/* WebUI 永不下发明文 apiKey,查看按钮只在桌面端提供。 */}
                              {!isGatewayWebui ? (
                                <button
                                  type="button"
                                  className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                                  onClick={() =>
                                    setShowUsageVariableApiKey((previous) => !previous)
                                  }
                                  title={
                                    showUsageVariableApiKey
                                      ? t("settings.hideApiKey")
                                      : t("settings.showApiKey")
                                  }
                                  aria-label={
                                    showUsageVariableApiKey
                                      ? t("settings.hideApiKey")
                                      : t("settings.showApiKey")
                                  }
                                >
                                  {showUsageVariableApiKey ? (
                                    <EyeOff className="h-3 w-3" />
                                  ) : (
                                    <Eye className="h-3 w-3" />
                                  )}
                                </button>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-muted-foreground/60 italic">
                              {t("settings.providerUsageVariableNotSet")}
                            </span>
                          )}
                        </div>
                      </div>
                    ) : null}

                    {usageQuery.mode === "newapi" ? (
                      <div className="mt-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                        <div className="space-y-1.5">
                          <Label htmlFor="usage-query-access-token">
                            {t("settings.providerUsageAccessToken")}
                          </Label>
                          <Input
                            id="usage-query-access-token"
                            type="password"
                            value={usageQuery.accessToken}
                            autoComplete="off"
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              setUsageQuery((previous) => ({
                                ...previous,
                                accessToken: value,
                              }));
                            }}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="usage-query-user-id">
                            {t("settings.providerUsageUserId")}
                          </Label>
                          <Input
                            id="usage-query-user-id"
                            value={usageQuery.userId}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              setUsageQuery((previous) => ({
                                ...previous,
                                userId: value,
                              }));
                            }}
                          />
                        </div>
                      </div>
                    ) : null}

                    {usageQuery.mode === "coding-plan" ? (
                      <>
                        {/* 内置供应商选择(一比一复刻 cc-switch Token Plan):
                            显式选择优先,否则按 Base URL 自动检测高亮。 */}
                        <div className="mt-4 flex flex-wrap gap-2">
                          {USAGE_QUERY_CODING_PLAN_PROVIDERS.map((entry) => (
                            <Button
                              key={entry.id}
                              type="button"
                              size="sm"
                              variant={
                                activeCodingPlanProvider === entry.id ? "default" : "outline"
                              }
                              onClick={() =>
                                setUsageQuery((previous) => ({
                                  ...previous,
                                  codingPlanProvider: entry.id,
                                }))
                              }
                            >
                              {entry.label}
                            </Button>
                          ))}
                        </div>

                        {activeCodingPlanProvider === "zenmux" ? (
                          <div className="mt-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                            <div className="space-y-1.5">
                              <Label htmlFor="usage-query-zenmux-base-url">
                                {t("settings.providerUsageBaseUrl")}
                              </Label>
                              <Input
                                id="usage-query-zenmux-base-url"
                                value={usageQuery.baseUrl}
                                placeholder="https://api.zenmux.com/v1/..."
                                onChange={(event) => {
                                  const value = event.currentTarget.value;
                                  setUsageQuery((previous) => ({
                                    ...previous,
                                    baseUrl: value,
                                  }));
                                }}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor="usage-query-zenmux-api-key">
                                {t("settings.providerUsageApiKey")}
                              </Label>
                              <Input
                                id="usage-query-zenmux-api-key"
                                type="password"
                                value={usageQuery.apiKey}
                                autoComplete="off"
                                placeholder="sk-..."
                                onFocus={(event) => event.currentTarget.select()}
                                onChange={(event) => {
                                  const value = event.currentTarget.value;
                                  setUsageQuery((previous) => ({
                                    ...previous,
                                    apiKey: value,
                                  }));
                                }}
                              />
                            </div>
                          </div>
                        ) : null}

                        {activeCodingPlanProvider === "zhipu_team" ? (
                          <>
                            <p className="mt-3 rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
                              {t("settings.providerUsageZhipuTeamHint")}{" "}
                              {t("settings.providerUsageZhipuTeamConsoleLink")}{" "}
                              <a
                                href="https://bigmodel.cn/coding-plan/team/usage-stats"
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary hover:underline"
                              >
                                bigmodel.cn/coding-plan/team/usage-stats
                              </a>
                            </p>
                            <div className="mt-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                              <div className="space-y-1.5">
                                <Label htmlFor="usage-query-team-organization-id">
                                  {t("settings.providerUsageOrganizationId")}
                                </Label>
                                <Input
                                  id="usage-query-team-organization-id"
                                  value={usageQuery.teamOrganizationId}
                                  placeholder={t("settings.providerUsageOrganizationIdPlaceholder")}
                                  onChange={(event) => {
                                    const value = event.currentTarget.value;
                                    setUsageQuery((previous) => ({
                                      ...previous,
                                      teamOrganizationId: value,
                                    }));
                                  }}
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label htmlFor="usage-query-team-project-id">
                                  {t("settings.providerUsageProjectId")}
                                </Label>
                                <Input
                                  id="usage-query-team-project-id"
                                  value={usageQuery.teamProjectId}
                                  placeholder={t("settings.providerUsageProjectIdPlaceholder")}
                                  onChange={(event) => {
                                    const value = event.currentTarget.value;
                                    setUsageQuery((previous) => ({
                                      ...previous,
                                      teamProjectId: value,
                                    }));
                                  }}
                                />
                              </div>
                            </div>
                          </>
                        ) : null}

                        {activeCodingPlanProvider === "volcengine" ? (
                          <>
                            <p className="mt-3 rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
                              {t("settings.providerUsageVolcengineHint")}{" "}
                              {t("settings.providerUsageVolcengineConsoleLink")}{" "}
                              <a
                                href="https://console.volcengine.com/iam/keymanage"
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary hover:underline"
                              >
                                console.volcengine.com/iam/keymanage
                              </a>
                            </p>
                            <div className="mt-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                              <div className="space-y-1.5">
                                <Label htmlFor="usage-query-access-key-id">
                                  {t("settings.providerUsageAccessKeyId")}
                                </Label>
                                <Input
                                  id="usage-query-access-key-id"
                                  value={usageQuery.accessKeyId}
                                  onChange={(event) => {
                                    const value = event.currentTarget.value;
                                    setUsageQuery((previous) => ({
                                      ...previous,
                                      accessKeyId: value,
                                    }));
                                  }}
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label htmlFor="usage-query-secret-access-key">
                                  {t("settings.providerUsageSecretAccessKey")}
                                </Label>
                                <Input
                                  id="usage-query-secret-access-key"
                                  type="password"
                                  value={usageQuery.secretAccessKey}
                                  autoComplete="off"
                                  onFocus={(event) => event.currentTarget.select()}
                                  onChange={(event) => {
                                    const value = event.currentTarget.value;
                                    setUsageQuery((previous) => ({
                                      ...previous,
                                      secretAccessKey: value,
                                    }));
                                  }}
                                />
                              </div>
                            </div>
                          </>
                        ) : null}
                      </>
                    ) : null}

                    <div className="mt-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                      <div className="space-y-1.5">
                        <Label htmlFor="usage-query-timeout">
                          {t("settings.providerUsageTimeout")}
                        </Label>
                        <Input
                          id="usage-query-timeout"
                          inputMode="numeric"
                          value={usageTimeoutInput}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setUsageTimeoutInput(value);
                          }}
                          onBlur={commitUsageTimeoutInput}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t("settings.providerUsageTimeoutHint")}
                        </p>
                      </div>
                    </div>

                    {usageQuery.mode === "custom" ||
                    usageQuery.mode === "general" ||
                    usageQuery.mode === "newapi" ? (
                      <div className="mt-4 space-y-1.5">
                        <Label htmlFor="usage-query-script">
                          {t("settings.providerUsageScript")}
                        </Label>
                        <Textarea
                          id="usage-query-script"
                          value={usageQuery.script}
                          className="min-h-36 font-mono text-xs"
                          placeholder={t("settings.providerUsageScriptPlaceholder")}
                          spellCheck={false}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            // 同步写入当前模式的独立脚本槽位,切换查询方式互不串扰。
                            setUsageQuery((previous) => setUsageQueryScript(previous, value));
                          }}
                        />
                      </div>
                    ) : null}

                    {/* 测试查询:独占一行的 card——按钮居左,结果内容就地靠左展示。 */}
                    <div className="mt-4 flex items-center gap-3 rounded-xl border bg-card px-4 py-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-10 shrink-0 gap-1.5"
                        disabled={
                          !persistedUsageQueryProviderId || usageQueryTest.status === "running"
                        }
                        onClick={() => void handleTestUsageQuery()}
                        title={t("settings.providerUsageTest")}
                        aria-label={t("settings.providerUsageTest")}
                      >
                        <RefreshCw
                          className={cn(
                            "h-3.5 w-3.5",
                            usageQueryTest.status === "running" && "animate-spin",
                          )}
                        />
                        {t("settings.providerUsageTest")}
                      </Button>
                      <div className="min-w-0 flex-1 text-xs" role="status" aria-live="polite">
                        {usageQueryTest.status === "running" ? (
                          <span className="text-muted-foreground">
                            {t("settings.providerUsageTestRunning")}
                          </span>
                        ) : null}
                        {usageQueryTest.status === "error" ? (
                          <span className="text-destructive">
                            {t("settings.providerUsageTestFailed")}
                            {usageQueryTest.error ? `: ${usageQueryTest.error}` : ""}
                          </span>
                        ) : null}
                        {usageQueryTest.status === "success" ? (
                          usageQueryTest.data.length > 0 ? (
                            <div className="flex flex-col gap-1">
                              {usageQueryTest.data.map((plan, index) => (
                                <UsagePlanLine
                                  key={`${plan.planName ?? ""}:${
                                    // biome-ignore lint/suspicious/noArrayIndexKey: 套餐无稳定 id,索引即位置语义
                                    index
                                  }`}
                                  plan={getUsagePlanDisplay(plan)}
                                />
                              ))}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">
                              {t("settings.providerUsageTestEmpty")}
                            </span>
                          )
                        ) : null}
                        {usageQueryTest.status === "idle" && !persistedUsageQueryProviderId ? (
                          <span className="text-muted-foreground">
                            {t("settings.providerUsageTestSavedHint")}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {usageQuery.mode === "custom" ||
                    usageQuery.mode === "general" ||
                    usageQuery.mode === "newapi" ? (
                      <div className="mt-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
                        <div className="font-medium text-foreground">
                          {t("settings.providerUsageScriptHelp")}
                        </div>
                        <div className="mt-2 font-medium">
                          {t("settings.providerUsageScriptHelpFormat")}
                        </div>
                        <pre className="mt-1 overflow-x-auto rounded-md border bg-background/60 p-2 font-mono text-[11px] leading-4">
                          {USAGE_QUERY_SCRIPT_HELP_EXAMPLE}
                        </pre>
                        <div className="mt-2 font-medium">
                          {t("settings.providerUsageScriptHelpExtractor")}
                        </div>
                        <ul className="mt-1 list-disc space-y-0.5 pl-4">
                          <li>{t("settings.providerUsageScriptHelpField.planName")}</li>
                          <li>{t("settings.providerUsageScriptHelpField.total")}</li>
                          <li>{t("settings.providerUsageScriptHelpField.used")}</li>
                          <li>{t("settings.providerUsageScriptHelpField.remaining")}</li>
                          <li>{t("settings.providerUsageScriptHelpField.unit")}</li>
                          <li>{t("settings.providerUsageScriptHelpField.isValid")}</li>
                          <li>{t("settings.providerUsageScriptHelpField.invalidMessage")}</li>
                          <li>{t("settings.providerUsageScriptHelpField.extra")}</li>
                        </ul>
                        <div className="mt-2 font-medium">
                          {t("settings.providerUsageScriptHelpTips")}
                        </div>
                        <ul className="mt-1 list-disc space-y-0.5 pl-4">
                          <li>{t("settings.providerUsageScriptHelpTip.variables")}</li>
                          <li>{t("settings.providerUsageScriptHelpTip.sandbox")}</li>
                          <li>{t("settings.providerUsageScriptHelpTip.wrap")}</li>
                          <li>{t("settings.providerUsageScriptHelpTip.origin")}</li>
                        </ul>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </section>
            )}
          </DialogBody>
        </div>

        {modelBulkMode && activePanel === "general" ? (
          <div className="flex shrink-0 flex-wrap items-center justify-center gap-1.5 border-t bg-background px-4 py-2 text-xs dark:bg-popover max-[420px]:gap-1 max-[420px]:px-2.5">
            <span className="whitespace-nowrap text-foreground/85">
              {t("settings.skillsBulkSelectedCount").replace(
                "{count}",
                String(modelBulkSelection.size),
              )}
            </span>
            <span className="text-muted-foreground/50 max-[420px]:hidden" aria-hidden="true">
              ·
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs max-[420px]:px-2"
              disabled={modelBulkEnableCount === 0}
              onClick={() => applyModelBulkState(true)}
            >
              {`${t("settings.skillsBulkEnable")} (${modelBulkEnableCount})`}
            </Button>
            <span className="text-muted-foreground/50 max-[420px]:hidden" aria-hidden="true">
              ·
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs max-[420px]:px-2"
              disabled={modelBulkDisableCount === 0}
              onClick={() => applyModelBulkState(false)}
            >
              {`${t("settings.skillsBulkDisable")} (${modelBulkDisableCount})`}
            </Button>
            <span className="text-muted-foreground/50 max-[420px]:hidden" aria-hidden="true">
              ·
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7 gap-1 px-2.5 text-xs max-[420px]:px-2"
              onClick={exitModelBulkMode}
            >
              <X className="h-3.5 w-3.5" />
              {t("settings.skillsBulkDone")}
            </Button>
          </div>
        ) : null}

        <DialogFooter className="bg-muted/20 py-3.5">
          <DialogActions>
            <Button
              variant="outline"
              onClick={requestClose}
              className="max-[720px]:h-10 max-[720px]:flex-1"
            >
              {t("settings.cancel")}
            </Button>
            <Button
              onClick={handleSave}
              disabled={!name.trim() || !dialogOpen}
              className="max-[720px]:h-10 max-[720px]:flex-1"
            >
              {t("settings.save")}
            </Button>
          </DialogActions>
        </DialogFooter>
        {usageQueryConfirmDialog}
      </DialogContent>
    </Dialog>
  );
}
