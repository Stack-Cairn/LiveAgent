import { useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Globe,
  Plus,
  Terminal,
  X,
  Zap,
} from "../../components/icons";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { useLocale } from "../../i18n";
import {
  HOOK_EVENT_TRANSLATION_KEYS,
  type HookDef,
  type HookEvent,
  type HookType,
} from "../../lib/automation";
import { useModalMotion } from "../../lib/shared/modalMotion";
import {
  createEmptyRequestDraft,
  type HttpRequestDraft,
  HttpRequestListEditor,
  parseHttpRequestDrafts,
  requestToDraft,
} from "./httpRequestEditor";

const DEFAULT_HOOK_TIMEOUT_SECONDS = 60;

type HookModalProps = {
  event: HookEvent;
  initialData?: HookDef;
  onSave: (data: Omit<HookDef, "id">) => void | Promise<void>;
  onClose: () => void;
};

export function HookModal({ event, initialData, onSave, onClose }: HookModalProps) {
  const { t } = useLocale();
  const [name, setName] = useState(initialData?.name ?? "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [type, setType] = useState<HookType>(initialData?.type ?? "command");
  const [scriptText, setScriptText] = useState(initialData?.script ?? "");
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    initialData?.timeoutMs == null ? "" : String(Math.round(initialData.timeoutMs / 1000)),
  );
  const [requests, setRequests] = useState<HttpRequestDraft[]>(() => {
    if (initialData?.requests?.length) {
      return initialData.requests.map((request) => requestToDraft(request));
    }
    return [createEmptyRequestDraft()];
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [expandedRequest, setExpandedRequest] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { isClosing, modalState, requestClose } = useModalMotion(onClose);

  const isEditing = Boolean(initialData);

  async function handleSave() {
    try {
      setIsSaving(true);
      const trimmedName = name.trim();
      if (!trimmedName) {
        throw new Error(t("settings.hooksNameRequired"));
      }
      const trimmedScript = scriptText.trim();
      if (type === "command" && !trimmedScript) {
        throw new Error(t("settings.hooksCommandRequired"));
      }
      const trimmedTimeout = timeoutSeconds.trim();
      const parsedTimeoutSeconds = trimmedTimeout ? Number(trimmedTimeout) : undefined;
      if (
        parsedTimeoutSeconds !== undefined &&
        (!Number.isSafeInteger(parsedTimeoutSeconds) || parsedTimeoutSeconds <= 0)
      ) {
        throw new Error(t("settings.hooksTimeoutInvalid"));
      }

      await onSave({
        event,
        name: trimmedName,
        description: description.trim(),
        enabled: initialData?.enabled ?? true,
        type,
        script: type === "command" ? trimmedScript : undefined,
        requests: type === "http" ? parseHttpRequestDrafts(requests, t) : undefined,
        timeoutMs:
          type === "command" && parsedTimeoutSeconds !== undefined
            ? parsedTimeoutSeconds * 1000
            : undefined,
      });
      requestClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  const scriptLineCount = scriptText.split(/\r?\n/).filter((line) => line.trim()).length;

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={requestClose} />

      <div className="settings-modal-panel relative z-10 flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl">
        <div className="settings-modal-header flex items-center gap-3 border-b border-border/40 px-6 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
            <Zap className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">
              {isEditing ? t("settings.hooksEdit") : t("settings.hooksAdd")}
            </h2>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="rounded-md bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                {event}
              </span>
              <span className="text-xs text-muted-foreground">
                {t(HOOK_EVENT_TRANSLATION_KEYS[event])}
              </span>
            </div>
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

        <div className="settings-modal-body flex-1 overflow-y-auto">
          <div className="border-b border-border/30 px-6 py-5">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-[11px] font-bold text-primary">
                1
              </div>
              <span className="text-sm font-semibold">{t("settings.hooksName")}</span>
            </div>

            <div className="space-y-4">
              <div className="settings-form-grid grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="hook-name" className="text-xs font-medium text-muted-foreground">
                    {t("settings.hooksName")}
                  </Label>
                  <Input
                    id="hook-name"
                    value={name}
                    placeholder={t("settings.hooksNamePlaceholder")}
                    onChange={(e) => {
                      setFormError(null);
                      setName(e.currentTarget.value);
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label
                    htmlFor="hook-description"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t("settings.hooksDescription")}
                  </Label>
                  <Input
                    id="hook-description"
                    value={description}
                    placeholder={t("settings.hooksDescriptionPlaceholder")}
                    onChange={(e) => {
                      setFormError(null);
                      setDescription(e.currentTarget.value);
                    }}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="border-b border-border/30 px-6 py-5">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-[11px] font-bold text-primary">
                2
              </div>
              <span className="text-sm font-semibold">{t("settings.hooksType")}</span>
            </div>

            <div className="settings-choice-grid grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  setFormError(null);
                  setType("command");
                }}
                className={`group relative flex items-start gap-3 rounded-xl border-2 p-4 text-left transition-all ${
                  type === "command"
                    ? "border-blue-500/50 bg-blue-500/5 shadow-sm shadow-blue-500/10"
                    : "border-border/60 bg-background hover:border-border hover:bg-muted/20"
                }`}
              >
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
                    type === "command"
                      ? "bg-blue-500/15 text-blue-500"
                      : "bg-muted/60 text-muted-foreground"
                  }`}
                >
                  <Terminal className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-sm font-semibold ${
                      type === "command" ? "text-blue-600 dark:text-blue-400" : "text-foreground"
                    }`}
                  >
                    {t("settings.hooksTypeCommand")}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {t("settings.hooksCommandHint")}
                  </p>
                </div>
                {type === "command" ? (
                  <div className="absolute right-3 top-3">
                    <CheckCircle2 className="h-4.5 w-4.5 text-blue-500" />
                  </div>
                ) : null}
              </button>

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
                    className={`text-sm font-semibold ${
                      type === "http" ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"
                    }`}
                  >
                    {t("settings.hooksTypeHttp")}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {t("settings.hooksHttpHint")}
                  </p>
                </div>
                {type === "http" ? (
                  <div className="absolute right-3 top-3">
                    <CheckCircle2 className="h-4.5 w-4.5 text-emerald-500" />
                  </div>
                ) : null}
              </button>
            </div>
          </div>

          <div className="px-6 py-5">
            <div className="settings-modal-step-row mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-[11px] font-bold text-primary">
                  3
                </div>
                <span className="text-sm font-semibold">
                  {type === "command"
                    ? t("settings.hooksCommandList")
                    : t("settings.hooksHttpRequests")}
                </span>
              </div>
              {type === "command" ? (
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
                    {scriptLineCount} {t("settings.hooksScriptLinesCount")}
                  </span>
                  <span className="rounded-md bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {t("settings.hooksSequential")}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                    {requests.length} {t("settings.hooksRequestsCount")}
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
              )}
            </div>

            {type === "command" ? (
              <div className="space-y-3">
                <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/20">
                  <div className="flex items-center justify-between border-b border-border/30 px-3 py-2">
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Terminal className="h-3 w-3" />
                      <span className="font-medium">{t("settings.hooksCommandList")}</span>
                    </div>
                    <span className="text-[11px] text-muted-foreground/60">
                      {t("settings.hooksCommandHint")}
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
                <div className="settings-form-grid grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="hook-timeout"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      {t("settings.hooksTimeout")}
                    </Label>
                    <Input
                      id="hook-timeout"
                      value={timeoutSeconds}
                      inputMode="numeric"
                      placeholder={String(DEFAULT_HOOK_TIMEOUT_SECONDS)}
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
            ) : (
              <HttpRequestListEditor
                requests={requests}
                expandedRequestId={expandedRequest}
                onExpand={setExpandedRequest}
                onChange={setRequests}
                onDirty={() => setFormError(null)}
                urlPlaceholder="https://example.com/hook"
              />
            )}
          </div>
        </div>

        <div className="settings-modal-footer flex items-center justify-between border-t border-border/40 px-6 py-4">
          <div className="min-w-0 flex-1">
            {formError ? (
              <div className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{formError}</span>
              </div>
            ) : name.trim() && (type !== "command" || scriptText.trim()) ? (
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
              disabled={!name.trim() || isSaving || isClosing}
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
