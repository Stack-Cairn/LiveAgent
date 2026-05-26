import {
  memo,
  useEffect,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { Brain, Globe2, Lightbulb, Loader2, Paperclip, Send, Square, X } from "../../components/icons";

import {
  MentionComposer,
  type MentionComposerHandle,
  type MentionComposerSkill,
} from "../../components/chat/MentionComposer";
import { Button } from "../../components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useLocale } from "../../i18n";
import {
  formatUploadedFileSize,
  type PendingUploadedFile,
} from "../../lib/chat/messages/uploadedFiles";
import { cn } from "../../lib/shared/utils";
import {
  DEFAULT_CHAT_RUNTIME_CONTROLS,
  type ChatRuntimeControls,
  type ReasoningLevel,
} from "../../lib/settings";

const REASONING_I18N_KEYS: Record<ReasoningLevel, string> = {
  off: "settings.reasoning.off",
  minimal: "settings.reasoning.minimal",
  low: "settings.reasoning.low",
  medium: "settings.reasoning.medium",
  high: "settings.reasoning.high",
  xhigh: "settings.reasoning.xhigh",
};

function RuntimeControlTooltip(props: { label: string; children: ReactNode }) {
  return (
    <span className="group/runtime-tooltip relative inline-flex shrink-0">
      {props.children}
      <span
        aria-hidden
        className="pointer-events-none invisible absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border/60 bg-popover px-2 py-1 text-[11px] font-medium text-popover-foreground opacity-0 shadow-md transition-[opacity,visibility] duration-0 group-focus-within/runtime-tooltip:visible group-focus-within/runtime-tooltip:opacity-100 group-focus-within/runtime-tooltip:delay-150 group-focus-within/runtime-tooltip:duration-150 group-hover/runtime-tooltip:visible group-hover/runtime-tooltip:opacity-100 group-hover/runtime-tooltip:delay-150 group-hover/runtime-tooltip:duration-150"
      >
        {props.label}
      </span>
    </span>
  );
}

export const ChatComposerBar = memo(function ChatComposerBar(props: {
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  isSending: boolean;
  isUploadingFiles: boolean;
  isInputDisabled: boolean;
  inputPlaceholder: string;
  workdir: string;
  enabledSkills: MentionComposerSkill[];
  isAgentMode: boolean;
  chatRuntimeControls: ChatRuntimeControls;
  reasoningOptions: ReasoningLevel[];
  onSend: () => void;
  onStop: () => void;
  onComposerBusyChange: (isBusy: boolean) => void;
  onChatRuntimeControlsChange: (patch: Partial<ChatRuntimeControls>) => void;
  onPickReadableFiles: () => void;
  onPasteFiles: (files: File[]) => void;
  pendingUploadedFiles: PendingUploadedFile[];
  onRemovePendingUpload: (relativePath: string) => void;
}) {
  const {
    composerRef,
    isSending,
    isUploadingFiles,
    isInputDisabled,
    inputPlaceholder,
    workdir,
    enabledSkills,
    isAgentMode,
    chatRuntimeControls,
    reasoningOptions,
    onSend,
    onStop,
    onComposerBusyChange,
    onChatRuntimeControlsChange,
    onPickReadableFiles,
    onPasteFiles,
    pendingUploadedFiles,
    onRemovePendingUpload,
  } = props;
  const { t } = useLocale();
  const [composerIsEmpty, setComposerIsEmpty] = useState(true);
  const uploadDisabled = isInputDisabled || isSending || isUploadingFiles || !isAgentMode || !workdir;
  const controlsDisabled = isInputDisabled || isSending;
  const thinkingSupported = reasoningOptions.length > 0;
  const sendDisabled =
    isInputDisabled ||
    isUploadingFiles ||
    (!isSending && composerIsEmpty && pendingUploadedFiles.length === 0);
  const selectedReasoning = reasoningOptions.includes(chatRuntimeControls.reasoning)
    ? chatRuntimeControls.reasoning
    : DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning;
  const uploadTooltip = t("chat.upload.button");
  const thinkingTooltip = !thinkingSupported
    ? t("chat.runtime.thinkingUnavailable")
    : t("chat.runtime.thinkingTooltip");
  const webSearchTooltip = t("chat.runtime.webSearchTooltip");

  useEffect(() => {
    if (
      reasoningOptions.length > 0 &&
      reasoningOptions.includes(chatRuntimeControls.reasoning)
    ) {
      return;
    }
    if (
      reasoningOptions.length === 0 &&
      chatRuntimeControls.reasoning === DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning
    ) {
      return;
    }
    onChatRuntimeControlsChange({ reasoning: DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning });
  }, [chatRuntimeControls.reasoning, onChatRuntimeControlsChange, reasoningOptions]);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4">
      <div className="pointer-events-auto relative w-full max-w-[768px]">
        {/* Pending uploaded files — above the composer card */}
        {pendingUploadedFiles.length > 0 && (
          <div className="upload-file-list mb-2.5 flex gap-2 overflow-x-auto px-0.5 pb-1">
            {pendingUploadedFiles.map((file) => (
              <div
                key={file.relativePath}
                title={file.relativePath}
                className="group flex w-[calc(25%-6px)] min-w-[calc(25%-6px)] items-center gap-2 rounded-xl border border-white/45 bg-white/55 px-2.5 py-1.5 text-[11px] shadow-[0_2px_8px_-2px_rgba(15,23,42,0.06)] backdrop-blur-2xl backdrop-saturate-150 transition-all hover:bg-white/75 hover:shadow-[0_4px_14px_-4px_rgba(15,23,42,0.10)] dark:border-white/10 dark:bg-white/[0.06] dark:hover:bg-white/[0.10]"
              >
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-sky-500/12 dark:bg-sky-400/15">
                  <Paperclip className="h-3 w-3 text-sky-600 dark:text-sky-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium tracking-tight text-foreground/90">
                    {file.fileName}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {formatUploadedFileSize(file.sizeBytes)}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={isInputDisabled || isSending}
                  onClick={() => onRemovePendingUpload(file.relativePath)}
                  className="shrink-0 rounded-full p-1 text-muted-foreground/70 opacity-0 transition-all hover:bg-foreground/5 hover:text-foreground group-hover:opacity-100 disabled:pointer-events-none"
                  aria-label={`${t("chat.upload.removeFile")} ${file.fileName}`}
                  title={t("chat.upload.removeFile")}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="composer-glass-card relative overflow-hidden rounded-[24px] border border-white/55 bg-white/65 shadow-[0_12px_40px_-12px_rgba(15,23,42,0.20),0_2px_6px_-2px_rgba(15,23,42,0.06)] backdrop-blur-xl backdrop-saturate-[180%] transition-all focus-within:border-white/80 focus-within:bg-white/72 focus-within:shadow-[0_18px_48px_-12px_rgba(15,23,42,0.26),0_4px_12px_-4px_rgba(15,23,42,0.08)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:focus-within:border-white/[0.14] dark:focus-within:bg-white/[0.075]">
          {/* macOS material rim-light */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-5 top-0 h-px rounded-full bg-gradient-to-r from-transparent via-white/85 to-transparent dark:via-white/15"
          />
          {/* subtle inner gloss gradient */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[24px] bg-gradient-to-b from-white/30 to-transparent opacity-60 dark:from-white/[0.04] dark:opacity-100"
          />

          <div className="relative px-4 pt-3.5">
            <MentionComposer
              ref={composerRef}
              onSend={onSend}
              onEmptyChange={setComposerIsEmpty}
              onBusyChange={onComposerBusyChange}
              onPasteFiles={onPasteFiles}
              placeholder={inputPlaceholder}
              disabled={isInputDisabled}
              workdir={workdir}
              enabledSkills={enabledSkills}
              className="px-0 py-0"
            />
          </div>

          <div className="relative flex items-center justify-between gap-2 px-3 pb-2 pt-1">
            <div className="flex min-w-0 items-center gap-1">
              <RuntimeControlTooltip label={uploadTooltip}>
                <button
                  type="button"
                  disabled={uploadDisabled}
                  onClick={onPickReadableFiles}
                  aria-label={
                    isUploadingFiles
                      ? t("chat.upload.uploading")
                      : !isAgentMode
                      ? t("chat.upload.onlyInTools")
                      : !workdir
                        ? t("chat.upload.requireWorkdir")
                        : t("chat.upload.selectFiles")
                  }
                  className={cn(
                    "composer-toolbar-action relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-hidden transition-colors",
                    "disabled:pointer-events-none disabled:opacity-40",
                    pendingUploadedFiles.length > 0
                      ? "text-sky-600 hover:text-sky-700 dark:text-sky-300 dark:hover:text-sky-200"
                      : "text-muted-foreground hover:text-foreground dark:hover:text-white",
                  )}
                >
                  {isUploadingFiles ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Paperclip className="h-4 w-4" />
                  )}
                  {pendingUploadedFiles.length > 0 ? (
                    <span
                      aria-hidden
                      className="absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-sky-500 px-[3px] text-[9px] font-semibold leading-none text-white shadow-[0_0_0_1.5px_rgba(255,255,255,0.95)] dark:bg-sky-400 dark:text-slate-900 dark:shadow-[0_0_0_1.5px_rgba(20,22,28,0.9)]"
                    >
                      {pendingUploadedFiles.length}
                    </span>
                  ) : null}
                </button>
              </RuntimeControlTooltip>

              <RuntimeControlTooltip label={thinkingTooltip}>
                <button
                  type="button"
                  disabled={controlsDisabled || !thinkingSupported}
                  onClick={() =>
                    onChatRuntimeControlsChange({
                      thinkingEnabled: !chatRuntimeControls.thinkingEnabled,
                    })
                  }
                  aria-label={
                    !thinkingSupported
                      ? t("chat.runtime.thinkingUnavailable")
                      : chatRuntimeControls.thinkingEnabled
                        ? t("chat.runtime.thinkingOn")
                        : t("chat.runtime.thinkingOff")
                  }
                  className={cn(
                    "composer-toolbar-action inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-hidden transition-colors",
                    "disabled:pointer-events-none disabled:opacity-40",
                    chatRuntimeControls.thinkingEnabled && thinkingSupported
                      ? "text-amber-600 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200"
                      : "text-muted-foreground hover:text-foreground dark:hover:text-white",
                  )}
                >
                  <Lightbulb className="h-4 w-4" />
                </button>
              </RuntimeControlTooltip>

              <RuntimeControlTooltip label={webSearchTooltip}>
                <button
                  type="button"
                  disabled={controlsDisabled}
                  onClick={() =>
                    onChatRuntimeControlsChange({
                      nativeWebSearchEnabled: !chatRuntimeControls.nativeWebSearchEnabled,
                    })
                  }
                  aria-label={
                    chatRuntimeControls.nativeWebSearchEnabled
                      ? t("chat.runtime.webSearchOn")
                      : t("chat.runtime.webSearchOff")
                  }
                  className={cn(
                    "composer-toolbar-action inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-hidden transition-colors",
                    "disabled:pointer-events-none disabled:opacity-40",
                    chatRuntimeControls.nativeWebSearchEnabled
                      ? "text-emerald-600 hover:text-emerald-700 dark:text-emerald-300 dark:hover:text-emerald-200"
                      : "text-muted-foreground hover:text-foreground dark:hover:text-white",
                  )}
                >
                  <Globe2 className="h-4 w-4" />
                </button>
              </RuntimeControlTooltip>

              {reasoningOptions.length > 0 ? (
                <Select
                  value={selectedReasoning}
                  onValueChange={(value) =>
                    onChatRuntimeControlsChange({ reasoning: value as ReasoningLevel })
                  }
                  disabled={controlsDisabled || !chatRuntimeControls.thinkingEnabled}
                >
                  <SelectTrigger
                    className={cn(
                      "composer-reasoning-trigger group/reasoning h-8 w-auto shrink-0 gap-0.5 rounded-full border pl-2 pr-1.5 text-xs font-medium shadow-none outline-hidden transition-all duration-200 ease-out disabled:opacity-45 [&>svg:last-child]:h-3 [&>svg:last-child]:w-3 [&>svg:last-child]:opacity-50 [&>svg:last-child]:transition-transform [&>svg:last-child]:duration-200 [&[data-state=open]>svg:last-child]:rotate-180",
                      chatRuntimeControls.thinkingEnabled
                        ? "border-violet-300/30 bg-violet-50/55 text-foreground hover:border-violet-300/45 hover:bg-violet-50/80 dark:border-violet-300/15 dark:bg-violet-400/[0.07] dark:text-foreground dark:hover:bg-violet-400/[0.13]"
                        : "border-transparent bg-foreground/[0.04] text-muted-foreground hover:bg-foreground/[0.07] dark:bg-white/[0.04] dark:hover:bg-white/[0.08]",
                    )}
                    aria-label={t("chat.runtime.reasoning")}
                  >
                    <span className="flex min-w-0 items-center gap-1">
                      <Brain
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 transition-colors",
                          chatRuntimeControls.thinkingEnabled
                            ? "text-violet-500 dark:text-violet-400"
                            : "",
                        )}
                      />
                      <SelectValue />
                    </span>
                  </SelectTrigger>
                  <SelectContent className="composer-reasoning-dropdown min-w-[7.5rem] rounded-xl border border-violet-200/40 bg-popover/85 p-1 shadow-[0_14px_34px_-16px_rgba(88,28,135,0.38)] ring-1 ring-white/15 backdrop-blur-2xl backdrop-saturate-150 supports-[backdrop-filter]:bg-popover/70 dark:border-violet-300/15 dark:bg-popover/70">
                    {reasoningOptions.map((value, index) => (
                      <SelectItem
                        key={value}
                        value={value}
                        className="composer-reasoning-item rounded-md transition-all duration-150 ease-out focus:translate-x-0.5 focus:bg-violet-50/70 focus:text-foreground data-[state=checked]:bg-violet-50/80 data-[state=checked]:font-medium dark:focus:bg-violet-400/[0.12] dark:data-[state=checked]:bg-violet-400/[0.14]"
                        style={{ animationDelay: `${Math.min(index, 5) * 0.022}s` }}
                      >
                        {t(REASONING_I18N_KEYS[value])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>

            <Button
              disabled={sendDisabled}
              onClick={() => {
                if (isInputDisabled) return;
                if (isSending) {
                  onStop();
                  return;
                }
                onSend();
              }}
              size="icon"
              title={isSending ? t("chat.stopGeneration") : t("chat.sendMessage")}
              aria-label={isSending ? t("chat.stopGeneration") : t("chat.sendMessage")}
              style={
                isSending
                  ? {
                      backgroundColor: "hsl(var(--destructive))",
                      backgroundImage: "none",
                      color: "hsl(var(--destructive-foreground))",
                    }
                  : undefined
              }
              className="h-8 w-8 shrink-0 rounded-full shadow-[0_1px_2px_rgba(15,23,42,0.12)] transition-all disabled:opacity-100 [&:not(:disabled)]:bg-foreground [&:not(:disabled)]:text-background [&:not(:disabled)]:hover:bg-foreground/85 [&:not(:disabled)]:hover:shadow-[0_4px_14px_-2px_rgba(15,23,42,0.28)] [&:not(:disabled)]:active:scale-95 disabled:bg-foreground/10 disabled:text-foreground/35"
            >
              {isSending ? (
                <Square className="h-3 w-3 fill-current" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});
