// GitReview commit composer: the card pinned to the bottom of the change
// list pane with the commit message editor, the AI generation action and the
// commit button. Shown in both the split and the stacked layout, so on
// narrow (mobile) widths committing never requires opening a file diff.
//
// Shared implementation owned by @liveagent/ui. Host-specific Git operations
// and optional platform capabilities enter through the shared contracts.

import { Loader2, Undo2, WandSparkles } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { GitStatusEntry } from "@liveagent/ui/lib/git/types";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../../../lib/shared/utils";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { useRightDockToolContext } from "../RightDockContext";
import {
  buildGitCommitMessagePrompt,
  buildGitCommitMessageSystemPrompt,
  parseGeneratedCommitMessage,
} from "./generateCommitMessage";
import type { GitReviewData } from "./useGitReviewData";

const MAX_COMMIT_MESSAGE_PATCH_CHARS = 64_000;

// Larger hit targets on touch devices without inflating the desktop dock.
const COARSE_POINTER_BUTTON_CLASS = "[@media(pointer:coarse)]:h-9";

// Keyboard hint for the commit shortcut; the handler accepts both Cmd and
// Ctrl, the hint only mirrors the platform's conventional modifier.
const COMMIT_SHORTCUT_HINT = /Mac|iPhone|iPad|iPod/i.test(
  typeof navigator === "undefined" ? "" : `${navigator.userAgent} ${navigator.platform}`,
)
  ? "⌘↩"
  : "Ctrl+↩";

export function GitCommitComposer(props: {
  commitMessage: string;
  data: GitReviewData;
  onCommitMessageChange: (value: string) => void;
  stagedEntries: GitStatusEntry[];
  writeDisabled: boolean;
}) {
  const { commitMessage, data, onCommitMessageChange, stagedEntries, writeDisabled } = props;
  const { busy, cwd, gitClient, runOperation } = data;
  const context = useRightDockToolContext();
  const textGenerationClient = context.clients.textGeneration;
  const { locale, t } = useLocale();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageValueRef = useRef(commitMessage);
  const generationAbortRef = useRef<AbortController | null>(null);
  const generationRequestRef = useRef(0);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");
  // Previous message kept for the one-shot undo affordance after a generation
  // overwrote non-empty user input; programmatic value swaps do not land in
  // the browser undo stack, so Ctrl+Z cannot restore it.
  const [undoMessage, setUndoMessage] = useState<string | null>(null);

  useEffect(() => {
    messageValueRef.current = commitMessage;
  }, [commitMessage]);

  // Autosize: grow with content from one line up, clamped by max-height in
  // CSS (which also caps the composer on short mobile viewports). WebKit has
  // no `field-sizing: content` yet, so the measurement runs in JS.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the message value changes.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, [commitMessage]);

  const operationBusy = busy !== "";
  const generationConfigured = textGenerationClient?.status
    ? textGenerationClient.status() === "ready"
    : true;

  const stagedGenerationKey = useMemo(
    () =>
      JSON.stringify(
        stagedEntries.map((entry) => [entry.indexStatus, entry.oldPath ?? "", entry.path]),
      ),
    [stagedEntries],
  );

  const cancelGeneration = useCallback(() => {
    generationRequestRef.current += 1;
    generationAbortRef.current?.abort();
    generationAbortRef.current = null;
    setGenerating(false);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: cancel in-flight generation when the repo or staged index changes.
  useEffect(() => {
    cancelGeneration();
    return cancelGeneration;
  }, [cancelGeneration, cwd, stagedGenerationKey]);

  const handleGenerate = useCallback(async () => {
    if (generating) {
      cancelGeneration();
      return;
    }
    if (
      !textGenerationClient ||
      !gitClient ||
      !generationConfigured ||
      writeDisabled ||
      operationBusy ||
      stagedEntries.length === 0
    ) {
      return;
    }

    const requestId = generationRequestRef.current + 1;
    generationRequestRef.current = requestId;
    const controller = new AbortController();
    generationAbortRef.current = controller;
    const messageBeforeGeneration = messageValueRef.current;
    setGenerating(true);
    setGenerationError("");

    try {
      const stagedDiff = await gitClient.diff(cwd, "staged");
      const patchWasTrimmed = stagedDiff.patch.length > MAX_COMMIT_MESSAGE_PATCH_CHARS;
      const response = await textGenerationClient.generate({
        systemPrompt: buildGitCommitMessageSystemPrompt(locale),
        userPrompt: buildGitCommitMessagePrompt({
          patch: stagedDiff.patch.slice(0, MAX_COMMIT_MESSAGE_PATCH_CHARS),
          files: stagedEntries,
          truncated: stagedDiff.truncated || patchWasTrimmed,
        }),
        output: "json",
        signal: controller.signal,
      });
      const generatedMessage = parseGeneratedCommitMessage(response, stagedEntries);
      if (
        controller.signal.aborted ||
        generationRequestRef.current !== requestId ||
        messageValueRef.current !== messageBeforeGeneration
      ) {
        return;
      }
      setUndoMessage(messageBeforeGeneration.trim() ? messageBeforeGeneration : null);
      onCommitMessageChange(generatedMessage);
      textareaRef.current?.focus();
    } catch (err) {
      if (controller.signal.aborted || generationRequestRef.current !== requestId) return;
      setGenerationError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generationRequestRef.current === requestId) {
        generationAbortRef.current = null;
        setGenerating(false);
      }
    }
  }, [
    cancelGeneration,
    cwd,
    generating,
    generationConfigured,
    gitClient,
    locale,
    onCommitMessageChange,
    operationBusy,
    stagedEntries,
    textGenerationClient,
    writeDisabled,
  ]);

  // The backend rejects commits with an empty index, so surface that state as
  // a disabled button plus the idle hint instead of a post-click error toast.
  const canCommit =
    !writeDisabled &&
    !operationBusy &&
    !generating &&
    stagedEntries.length > 0 &&
    commitMessage.trim().length > 0;

  const handleCommit = useCallback(() => {
    if (!canCommit || !gitClient) return;
    void runOperation("commit", () => gitClient.commit(cwd, commitMessage), "commit").then((ok) => {
      if (ok) {
        onCommitMessageChange("");
        setUndoMessage(null);
      }
    });
  }, [canCommit, commitMessage, cwd, gitClient, onCommitMessageChange, runOperation]);

  const handleMessageChange = useCallback(
    (value: string) => {
      setUndoMessage(null);
      setGenerationError("");
      onCommitMessageChange(value);
    },
    [onCommitMessageChange],
  );

  const handleUndoGeneration = useCallback(() => {
    if (undoMessage === null) return;
    onCommitMessageChange(undoMessage);
    setUndoMessage(null);
    textareaRef.current?.focus();
  }, [onCommitMessageChange, undoMessage]);

  const handleTextareaKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape" && generating) {
        event.preventDefault();
        cancelGeneration();
        return;
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        handleCommit();
      }
    },
    [cancelGeneration, generating, handleCommit],
  );

  const generateDisabled =
    !generating &&
    (writeDisabled || operationBusy || stagedEntries.length === 0 || !generationConfigured);
  const generateLabel = generating
    ? t("projectTools.gitReview.generateCommitMessageCancel")
    : stagedEntries.length === 0
      ? t("projectTools.gitReview.generateCommitMessageRequiresStaged")
      : !generationConfigured
        ? t("projectTools.gitReview.generateCommitMessageRequiresModel")
        : t("projectTools.gitReview.generateCommitMessage");

  return (
    <div className="@container shrink-0 border-t border-border/60 p-2">
      <div
        className={cn(
          "relative overflow-hidden rounded-xl border border-border/70 bg-muted/25 transition-[border-color,background-color,box-shadow] duration-150",
          "focus-within:border-primary/40 focus-within:bg-background focus-within:shadow-[0_0_0_3px_hsl(var(--primary)/0.08)]",
          generating && "border-primary/30",
        )}
      >
        {generating ? <div aria-hidden="true" className="git-review-generate-progress" /> : null}
        <Textarea
          ref={textareaRef}
          rows={1}
          value={commitMessage}
          onChange={(event) => handleMessageChange(event.target.value)}
          onKeyDown={handleTextareaKeyDown}
          placeholder={t("projectTools.gitReview.commitMessagePlaceholder")}
          disabled={writeDisabled || operationBusy}
          aria-busy={generating}
          className="max-h-[min(10rem,30dvh)] min-h-8 resize-none overflow-y-auto border-0 bg-transparent px-2.5 pb-1 pt-2 text-xs leading-5 shadow-none placeholder:text-xs placeholder:text-muted-foreground/70"
        />
        <div className="flex items-center gap-1.5 px-1.5 pb-1.5">
          {textGenerationClient ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={generateDisabled}
              className={cn(
                "h-7 shrink-0 gap-1 rounded-full border border-border/60 bg-background/70 px-2 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-muted-foreground hover:border-primary/35 hover:text-foreground",
                generating && "border-primary/40 text-primary hover:text-primary",
                COARSE_POINTER_BUTTON_CLASS,
              )}
              title={generateLabel}
              aria-label={generateLabel}
              onClick={() => void handleGenerate()}
            >
              {generating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <WandSparkles className="h-3.5 w-3.5 text-primary" />
              )}
              <span className="hidden @min-[15rem]:inline">
                {generating
                  ? t("projectTools.gitReview.generateCommitMessageCancel")
                  : t("projectTools.gitReview.generateCommitMessageShort")}
              </span>
            </Button>
          ) : null}
          <div
            role="status"
            className="min-w-0 flex-1 text-[calc(11px*var(--zone-font-scale,1))] leading-4"
          >
            {generationError ? (
              <p className="truncate text-destructive" title={generationError}>
                {generationError}
              </p>
            ) : generating ? (
              <p className="truncate text-muted-foreground">
                {t("projectTools.gitReview.generateCommitMessageGenerating")}
              </p>
            ) : undoMessage !== null ? (
              <button
                type="button"
                className="inline-flex max-w-full items-center gap-1 rounded-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={handleUndoGeneration}
              >
                <Undo2 className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {t("projectTools.gitReview.generateCommitMessageUndo")}
                </span>
              </button>
            ) : stagedEntries.length === 0 && !writeDisabled ? (
              <p className="truncate text-muted-foreground/70">
                {t("projectTools.gitReview.commitRequiresStaged")}
              </p>
            ) : null}
          </div>
          <Button
            size="sm"
            disabled={!canCommit}
            className={cn("h-7 shrink-0 gap-1.5 px-2.5", COARSE_POINTER_BUTTON_CLASS)}
            title={`${t("projectTools.gitReview.commitStaged")} (${COMMIT_SHORTCUT_HINT})`}
            onClick={handleCommit}
          >
            {busy === "commit" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                <span>{t("projectTools.gitReview.commit")}</span>
                {stagedEntries.length > 0 ? (
                  <span className="rounded-sm bg-primary-foreground/25 px-1 py-0.5 text-[calc(10px*var(--zone-font-scale,1))] font-semibold leading-none tabular-nums">
                    {stagedEntries.length}
                  </span>
                ) : null}
                <kbd className="hidden font-sans text-[calc(10px*var(--zone-font-scale,1))] font-normal leading-none opacity-70 @min-[19rem]:inline">
                  {COMMIT_SHORTCUT_HINT}
                </kbd>
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
