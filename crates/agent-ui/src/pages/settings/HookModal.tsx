import { AlertTriangle, Plus } from "@liveagent/ui/components/IconSet";
import { FormField, FormFieldLabel } from "@liveagent/ui/components/settings/FormField";
import { SettingsNotice } from "@liveagent/ui/components/settings/SettingsNotice";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  HOOK_EVENT_TRANSLATION_KEYS,
  type HookDef,
  type HookEvent,
  type HookType,
} from "@liveagent/ui/lib/automation/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState } from "react";
import {
  SettingsSelectContent,
  SettingsSelectTrigger,
} from "../../components/settings/SettingsSelect";
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
import { Select, SelectItem, SelectValue } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
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
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  const scriptLineCount = scriptText.split(/\r?\n/).filter((line) => line.trim()).length;

  return (
    <Dialog open onOpenChange={(open) => !open && !isSaving && onClose()}>
      <DialogContent
        className="flex h-[min(46rem,calc(100dvh-2rem))] max-w-xl flex-col"
        closeDisabled={isSaving}
        closeLabel={t("settings.cancel")}
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>{isEditing ? t("settings.hooksEdit") : t("settings.hooksAdd")}</DialogTitle>
          <DialogDescription>{t(HOOK_EVENT_TRANSLATION_KEYS[event])}</DialogDescription>
        </DialogHeader>

        <DialogBody className="p-0 max-[820px]:p-0">
          <div className="px-6 pt-5 pb-1">
            <div className="space-y-4">
              <div className="space-y-4">
                <FormField density="compact">
                  <FormFieldLabel htmlFor="hook-name" size="compact">
                    {t("settings.hooksName")}
                  </FormFieldLabel>
                  <Input
                    variant="plain"
                    id="hook-name"
                    value={name}
                    placeholder={t("settings.hooksNamePlaceholder")}
                    onChange={(e) => {
                      setFormError(null);
                      setName(e.currentTarget.value);
                    }}
                  />
                </FormField>
                <FormField density="compact">
                  <FormFieldLabel htmlFor="hook-description" size="compact">
                    {t("settings.hooksDescription")}
                  </FormFieldLabel>
                  <Input
                    variant="plain"
                    id="hook-description"
                    value={description}
                    placeholder={t("settings.hooksDescriptionPlaceholder")}
                    onChange={(e) => {
                      setFormError(null);
                      setDescription(e.currentTarget.value);
                    }}
                  />
                </FormField>
              </div>
            </div>
          </div>

          <FormField className="px-6 py-4">
            <FormFieldLabel htmlFor="hook-type" className="block" size="compact">
              {t("settings.hooksType")}
            </FormFieldLabel>
            <Select
              value={type}
              onValueChange={(value) => {
                setType(value as HookType);
                setFormError(null);
              }}
            >
              <SettingsSelectTrigger
                id="hook-type"
                className={cn(
                  "flex h-9 w-full max-w-none justify-between px-3",
                  "rounded-lg bg-settings-tile-hover shadow-none",
                )}
              >
                <SelectValue>
                  {t(type === "command" ? "settings.hooksTypeCommand" : "settings.hooksTypeHttp")}
                </SelectValue>
              </SettingsSelectTrigger>
              <SettingsSelectContent>
                <SelectItem value="command">{t("settings.hooksTypeCommand")}</SelectItem>
                <SelectItem value="http">{t("settings.hooksTypeHttp")}</SelectItem>
              </SettingsSelectContent>
            </Select>
          </FormField>

          <div className="px-6 py-5">
            <DialogSectionHeader>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">
                  {type === "command"
                    ? t("settings.hooksCommandList")
                    : t("settings.hooksHttpRequests")}
                </span>
              </div>
              {type === "command" ? (
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-settings-tile px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {scriptLineCount} {t("settings.hooksScriptLinesCount")}
                  </span>
                  <span className="rounded-md bg-muted/50 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {t("settings.hooksSequential")}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-settings-tile px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {requests.length} {t("settings.hooksRequestsCount")}
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
              )}
            </DialogSectionHeader>

            {type === "command" ? (
              <div className="space-y-3">
                <div className="space-y-2">
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t("settings.hooksCommandHint")}
                  </p>
                  <Textarea
                    variant="plain"
                    aria-label={t("settings.hooksCommandList")}
                    value={scriptText}
                    placeholder={"pnpm install\npnpm build\npnpm test"}
                    className={cn("min-h-44 resize-y rounded-lg font-mono text-xs leading-relaxed")}
                    onChange={(e) => {
                      setFormError(null);
                      setScriptText(e.currentTarget.value);
                    }}
                  />
                </div>
                <div className="space-y-4">
                  <FormField density="compact">
                    <FormFieldLabel htmlFor="hook-timeout" size="compact">
                      {t("settings.hooksTimeout")}
                    </FormFieldLabel>
                    <Input
                      variant="plain"
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
                  </FormField>
                </div>
              </div>
            ) : (
              <HttpRequestListEditor
                plain
                alwaysExpanded
                requests={requests}
                expandedRequestId={expandedRequest}
                onExpand={setExpandedRequest}
                onChange={setRequests}
                onDirty={() => setFormError(null)}
                urlPlaceholder="https://example.com/hook"
              />
            )}
          </div>
        </DialogBody>

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
            <Button size="sm" variant="outline" onClick={onClose} disabled={isSaving}>
              {t("settings.cancel")}
            </Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={!name.trim() || isSaving}>
              {t("settings.save")}
            </Button>
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
