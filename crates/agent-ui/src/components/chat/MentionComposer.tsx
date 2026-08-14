import {
  readComposerClipboardText,
  usesCustomComposerContextMenu,
} from "@liveagent/adapters/composerClipboard";
import {
  caretPromptHistoryLine,
  type PromptHistorySession,
  type PromptHistoryStash,
  stepPromptHistory,
} from "@liveagent/ui/components/chat/promptHistory";
import { ClipboardPaste, Copy, ScanText, Scissors } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  insertPlainTextWithUndo,
  normalizeLogicalLineEndings,
} from "@liveagent/ui/lib/chat/composerText";
import {
  type CodeMentionReference,
  formatCodeMentionToken,
  formatFileMentionToken,
} from "@liveagent/ui/lib/chat/mentionReferences";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { invokeFs } from "@liveagent/ui/lib/tools/fsBackend";
import {
  type ClipboardEvent,
  type FocusEvent,
  forwardRef,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  COMMIT_MENTION_SHA_ATTR,
  CommitMentionTooltip,
  type ComposerContextMenuState,
  clampComposerContextMenuPosition,
  commitMentionFromElement,
  countLargePasteLines,
  createCodeMentionChip,
  createCommitMentionChip,
  createFileMentionChip,
  createGitFileMentionChip,
  createLargePasteChip,
  createSkillMentionChip,
  deleteChipAfterCursor,
  deleteChipBeforeCursor,
  deleteComposerSelection,
  detectMention,
  editorHasNoContent,
  editorRangeIsInsideRoot,
  editorSelectionRange,
  editorTextIsEmpty,
  ejectCaretFromChip,
  ensureTrailingCaretAnchor,
  extractClipboardFiles,
  formatCommitMentionToken,
  formatGitFileMentionToken,
  formatSkillMentionToken,
  hasLegacyImeKeyboardSignal,
  IME_COMPOSITION_END_ENTER_TAIL_MS,
  IME_ENTER_SUPPRESS_WINDOW_MS,
  insertComposerSegmentsAtSelection,
  insertMentionChip,
  insertNodeAtCursor,
  insertSkillMentionChip,
  isActiveImeKeyboardEvent,
  isEnterKeyboardEvent,
  isImeKeyboardEvent,
  isLargePasteText,
  LARGE_PASTE_TAG_ATTR,
  MAX_SUGGESTIONS,
  MENTION_INDEX_MAX_RESULTS,
  MENTION_REFETCH_DEBOUNCE_MS,
  type MentionComposerCommitMention,
  type MentionComposerDraft,
  type MentionComposerGitFileMention,
  type MentionComposerHandle,
  type MentionComposerLargePaste,
  type MentionComposerProps,
  type MentionComposerSkillMention,
  type MentionContext,
  type MentionFetchSnapshot,
  type MentionFileEntry,
  type MentionListResponse,
  type MentionSearchEntry,
  type MentionSuggestion,
  mentionContextEquals,
  mentionSnapshotCoversQuery,
  normalizeCaretAfterChip,
  normalizeLargePastePreview,
  normalizeMentionQuery,
  normalizeSerializedText,
  Popup,
  parseSerializedComposerText,
  placeComposerCaretFromPoint,
  readComposerClipboardSegments,
  rebuildClipboardSegmentsForPaste,
  removeStaleCaretAnchorsAroundSelection,
  resolveComposerSelection,
  resolveComposerSelectionText,
  scheduleComposerSelectionScroll,
  selectComposerContents,
  selectionContainsPoint,
  serializeChildren,
  serializeChildrenToSegments,
  stepCaretOverChip,
  TYPEWRITER_CHAR_FADE_MS,
  writeComposerClipboardSnapshot,
  writeTextToClipboard,
} from "./MentionComposerInternals";

export type {
  MentionComposerCommitMention,
  MentionComposerDraft,
  MentionComposerDraftSegment,
  MentionComposerGitFileMention,
  MentionComposerHandle,
  MentionComposerLargePaste,
  MentionComposerProps,
  MentionComposerSkill,
  MentionComposerSkillMention,
} from "./MentionComposerInternals";
export {
  COMPOSER_CLIPBOARD_MIME,
  mentionSnapshotCoversQuery,
  parseComposerClipboardPayload,
  parseSerializedComposerText,
  rebuildClipboardSegmentsForPaste,
  serializeChildrenToSegments,
  serializeComposerClipboardPayload,
  usesCustomComposerContextMenu,
} from "./MentionComposerInternals";

/* ------------------------------------------------------------------ */
/*  MentionComposer                                                    */
/* ------------------------------------------------------------------ */

export const MentionComposer = memo(
  forwardRef<MentionComposerHandle, MentionComposerProps>(function MentionComposer(
    {
      onSend,
      onEmptyChange,
      onBusyChange,
      onPasteFiles,
      loadHistoryPrompts,
      disabled = false,
      placeholder = "",
      workdir,
      enabledSkills = [],
      className,
    }: MentionComposerProps,
    ref,
  ) {
    const { locale, t } = useLocale();
    const editorRef = useRef<HTMLDivElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const composerContextMenuRef = useRef<HTMLDivElement>(null);
    const composerContextMenuRangeRef = useRef<Range | null>(null);
    const commitTooltipCloseTimerRef = useRef<number | null>(null);
    const commitTooltipChipRef = useRef<HTMLElement | null>(null);
    const [isDomEmpty, setIsDomEmpty] = useState(true);
    const lastIsEmptyRef = useRef(true);
    const lastIsDomEmptyRef = useRef(true);
    const isComposingRef = useRef(false);
    const compositionEnterKeyRef = useRef(false);
    const lastCompositionEndAtRef = useRef(0);
    const imeEnterSuppressUntilRef = useRef(0);
    const busyReleaseTimerRef = useRef<number | null>(null);
    const isBusyRef = useRef(false);
    const largePastesRef = useRef(new Map<string, MentionComposerLargePaste>());
    const largePasteCounterRef = useRef(0);
    // Active ↑/↓ prompt-history recall; null while the user is editing.
    const promptHistorySessionRef = useRef<PromptHistorySession<MentionComposerLargePaste> | null>(
      null,
    );
    const resetPromptHistoryRecall = useCallback(() => {
      promptHistorySessionRef.current = null;
    }, []);
    const [composerContextMenu, setComposerContextMenu] = useState<ComposerContextMenuState | null>(
      null,
    );
    const [commitTooltip, setCommitTooltip] = useState<{
      commit: MentionComposerCommitMention;
      rect: DOMRect;
    } | null>(null);

    const closeCommitTooltip = useCallback(() => {
      commitTooltipChipRef.current = null;
      setCommitTooltip(null);
    }, []);

    const closeComposerContextMenu = useCallback(() => {
      composerContextMenuRangeRef.current = null;
      setComposerContextMenu(null);
    }, []);

    const lastEditorSelectionRef = useRef<Range | null>(null);
    const rememberEditorSelection = useCallback(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const range = editorSelectionRange(editor);
      if (range) {
        lastEditorSelectionRef.current = range.cloneRange();
      }
    }, []);
    const focusEditorAtSavedSelection = useCallback(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const range = lastEditorSelectionRef.current;
      editor.focus({ preventScroll: true });
      if (!range || !editorRangeIsInsideRoot(editor, range)) return;
      const selection = window.getSelection();
      if (!selection) return;
      selection.removeAllRanges();
      selection.addRange(range.cloneRange());
    }, []);

    useEffect(() => {
      document.addEventListener("selectionchange", rememberEditorSelection);
      return () => document.removeEventListener("selectionchange", rememberEditorSelection);
    }, [rememberEditorSelection]);

    const setBusy = useCallback(
      (nextBusy: boolean) => {
        if (isBusyRef.current === nextBusy) return;
        isBusyRef.current = nextBusy;
        onBusyChange?.(nextBusy);
      },
      [onBusyChange],
    );

    const scheduleBusyRelease = useCallback(() => {
      if (busyReleaseTimerRef.current !== null) {
        window.clearTimeout(busyReleaseTimerRef.current);
      }
      busyReleaseTimerRef.current = window.setTimeout(() => {
        busyReleaseTimerRef.current = null;
        setBusy(false);
      }, 140);
    }, [setBusy]);

    // ---- File list ----
    const normalizedWorkdir = workdir.trim();
    const [mentionSessionEntries, setMentionSessionEntries] = useState<MentionFileEntry[]>([]);
    const [mentionSessionLoading, setMentionSessionLoading] = useState(false);
    const [mentionSessionError, setMentionSessionError] = useState<string | null>(null);
    const mentionSessionRequestSeqRef = useRef(0);
    const mentionActiveRef = useRef(false);
    const mentionSessionQueryRef = useRef("");
    const mentionFetchRef = useRef<MentionFetchSnapshot | null>(null);
    const mentionRefetchTimerRef = useRef<number | null>(null);
    const [mentionRefetchPending, setMentionRefetchPending] = useState(false);

    // ---- Mention state ----
    const [mentionCtx, setMentionCtx] = useState<MentionContext | null>(null);
    const [highlightIdx, setHighlightIdx] = useState(0);

    const cancelMentionRefetch = useCallback(() => {
      if (mentionRefetchTimerRef.current !== null) {
        window.clearTimeout(mentionRefetchTimerRef.current);
        mentionRefetchTimerRef.current = null;
      }
      setMentionRefetchPending(false);
    }, []);

    const resetMentionSession = useCallback(() => {
      mentionSessionRequestSeqRef.current += 1;
      mentionSessionQueryRef.current = "";
      mentionFetchRef.current = null;
      cancelMentionRefetch();
      setMentionSessionEntries([]);
      setMentionSessionLoading(false);
      setMentionSessionError(null);
    }, [cancelMentionRefetch]);

    const closeMentionSession = useCallback(() => {
      mentionActiveRef.current = false;
      setMentionCtx(null);
      setHighlightIdx(0);
      resetMentionSession();
    }, [resetMentionSession]);

    const startMentionSession = useCallback(
      (ctx: MentionContext, opts?: { keepEntries?: boolean }) => {
        cancelMentionRefetch();
        const requestSeq = ++mentionSessionRequestSeqRef.current;
        const isFileFetch = ctx.trigger === "file" && Boolean(normalizedWorkdir);
        mentionSessionQueryRef.current = ctx.query;
        mentionFetchRef.current = {
          trigger: ctx.trigger,
          query: normalizeMentionQuery(ctx.query),
          // Pessimistic while the fetch is in flight so keystrokes racing the
          // response keep refetching; the response corrects it. Skill and
          // workdir-less sessions never fetch, so their snapshot is complete.
          truncated: isFileFetch,
        };
        if (!opts?.keepEntries) {
          setMentionSessionEntries([]);
        }
        setMentionSessionLoading(isFileFetch);
        setMentionSessionError(null);

        if (ctx.trigger === "skill") {
          return;
        }
        if (!normalizedWorkdir) {
          return;
        }

        invokeFs<MentionListResponse>("fs_mention_list", {
          workdir: normalizedWorkdir,
          max_results: MENTION_INDEX_MAX_RESULTS,
          query: ctx.query,
        })
          .then((resp) => {
            if (requestSeq !== mentionSessionRequestSeqRef.current) return;
            setMentionSessionEntries(resp.entries);
            if (mentionFetchRef.current) {
              mentionFetchRef.current = { ...mentionFetchRef.current, truncated: resp.truncated };
            }
          })
          .catch(() => {
            if (requestSeq !== mentionSessionRequestSeqRef.current) return;
            setMentionSessionEntries([]);
            setMentionSessionError("Could not index files");
          })
          .finally(() => {
            if (requestSeq !== mentionSessionRequestSeqRef.current) return;
            setMentionSessionLoading(false);
          });
      },
      [cancelMentionRefetch, normalizedWorkdir],
    );

    const scheduleMentionRefetch = useCallback(
      (ctx: MentionContext) => {
        if (mentionRefetchTimerRef.current !== null) {
          window.clearTimeout(mentionRefetchTimerRef.current);
        }
        setMentionRefetchPending(true);
        mentionRefetchTimerRef.current = window.setTimeout(() => {
          mentionRefetchTimerRef.current = null;
          setMentionRefetchPending(false);
          startMentionSession(ctx, { keepEntries: true });
        }, MENTION_REFETCH_DEBOUNCE_MS);
      },
      [startMentionSession],
    );

    const mentionSessionSearchIndex = useMemo<MentionSearchEntry[]>(
      () =>
        mentionSessionEntries.map((entry) => ({
          entry,
          searchPath: entry.path.toLowerCase(),
        })),
      [mentionSessionEntries],
    );

    useEffect(() => {
      closeMentionSession();
    }, [closeMentionSession]);

    useEffect(() => {
      return () => {
        mentionSessionRequestSeqRef.current += 1;
        if (mentionRefetchTimerRef.current !== null) {
          window.clearTimeout(mentionRefetchTimerRef.current);
        }
        if (busyReleaseTimerRef.current !== null) {
          window.clearTimeout(busyReleaseTimerRef.current);
        }
        setBusy(false);
      };
    }, [setBusy]);

    useEffect(() => {
      if (!disabled) return;
      closeMentionSession();
      setBusy(false);
    }, [disabled, closeMentionSession, setBusy]);

    useEffect(() => {
      if (!composerContextMenu) return;

      const handlePointerDown = (event: PointerEvent) => {
        const target = event.target;
        if (!(target instanceof Node)) {
          closeComposerContextMenu();
          return;
        }
        if (composerContextMenuRef.current?.contains(target)) {
          return;
        }
        closeComposerContextMenu();
      };

      const handleKeyDown = (event: globalThis.KeyboardEvent) => {
        if (event.key === "Escape") {
          closeComposerContextMenu();
        }
      };

      const handleClose = () => {
        closeComposerContextMenu();
      };

      window.addEventListener("pointerdown", handlePointerDown, true);
      window.addEventListener("keydown", handleKeyDown, true);
      window.addEventListener("scroll", handleClose, true);
      window.addEventListener("resize", handleClose);
      window.addEventListener("blur", handleClose);

      return () => {
        window.removeEventListener("pointerdown", handlePointerDown, true);
        window.removeEventListener("keydown", handleKeyDown, true);
        window.removeEventListener("scroll", handleClose, true);
        window.removeEventListener("resize", handleClose);
        window.removeEventListener("blur", handleClose);
      };
    }, [closeComposerContextMenu, composerContextMenu]);

    const normalizedMentionQuery = mentionCtx ? normalizeMentionQuery(mentionCtx.query) : "";
    const suggestions = useMemo<MentionSuggestion[]>(() => {
      if (mentionCtx === null) {
        return [];
      }

      if (mentionCtx.trigger === "skill") {
        const next: MentionSuggestion[] = [];
        for (const skill of enabledSkills) {
          const haystack = `${skill.name}\n${skill.description}\n${skill.baseDir}`.toLowerCase();
          if (normalizedMentionQuery && !haystack.includes(normalizedMentionQuery)) {
            continue;
          }
          next.push({ type: "skill", skill });
          if (next.length >= MAX_SUGGESTIONS) {
            break;
          }
        }
        return next;
      }

      const next: MentionSuggestion[] = [];
      for (const item of mentionSessionSearchIndex) {
        if (normalizedMentionQuery && !item.searchPath.includes(normalizedMentionQuery)) {
          continue;
        }
        next.push({ type: "file", entry: item.entry });
        if (next.length >= MAX_SUGGESTIONS) {
          break;
        }
      }
      return next;
    }, [enabledSkills, mentionCtx, mentionSessionSearchIndex, normalizedMentionQuery]);

    useEffect(() => {
      setHighlightIdx((current) => {
        if (suggestions.length === 0) return 0;
        return Math.min(current, suggestions.length - 1);
      });
    }, [suggestions.length]);

    const popupLoading = mentionSessionLoading || mentionRefetchPending;
    const popupError = suggestions.length === 0 ? mentionSessionError : null;
    const popupEmptyLabel =
      mentionCtx?.trigger === "skill"
        ? t("chat.composer.noMatchingEnabledSkills")
        : t("chat.composer.noMatchingFiles");
    const showEmpty =
      mentionCtx !== null && !popupLoading && !popupError && suggestions.length === 0;
    const popupVisible =
      mentionCtx !== null &&
      (popupLoading || Boolean(popupError) || suggestions.length > 0 || showEmpty);

    const applyEmptyState = useCallback(
      (nextEmpty: boolean, nextDomEmpty: boolean) => {
        if (lastIsEmptyRef.current !== nextEmpty) {
          lastIsEmptyRef.current = nextEmpty;
          onEmptyChange?.(nextEmpty);
        }
        if (lastIsDomEmptyRef.current !== nextDomEmpty) {
          lastIsDomEmptyRef.current = nextDomEmpty;
          setIsDomEmpty(nextDomEmpty);
        }
      },
      [onEmptyChange],
    );

    const refreshEmptyState = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      applyEmptyState(editorTextIsEmpty(el), editorHasNoContent(el));
    }, [applyEmptyState]);

    // ---- Typewriter (typeText) ----
    // While a run is active the editor drops contentEditable so keyboard and
    // IME input cannot interleave user text with the scripted text.
    const typewriterRef = useRef<{
      timer: number;
      finish: () => void;
      settle: (restoreFocus: boolean) => void;
    } | null>(null);
    const [isTypewriting, setIsTypewriting] = useState(false);
    const typewriterFocusPendingRef = useRef(false);

    const placeCaretAtEditorEnd = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }, []);

    const cancelTypewriter = useCallback(() => {
      const active = typewriterRef.current;
      if (!active) return;
      typewriterRef.current = null;
      window.clearTimeout(active.timer);
      active.settle(false);
    }, []);

    // Programmatic draft reads and mention inserts complete the animation
    // instantly so they always observe the full suggestion text.
    const finishTypewriter = useCallback(() => {
      const active = typewriterRef.current;
      if (!active) return;
      typewriterRef.current = null;
      window.clearTimeout(active.timer);
      active.finish();
      active.settle(true);
    }, []);

    useEffect(() => cancelTypewriter, [cancelTypewriter]);

    // Restore focus only after React has re-enabled contentEditable; focusing
    // inside settle() would race the attribute flip and get dropped.
    useEffect(() => {
      if (isTypewriting || !typewriterFocusPendingRef.current) return;
      typewriterFocusPendingRef.current = false;
      const el = editorRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      placeCaretAtEditorEnd();
    }, [isTypewriting, placeCaretAtEditorEnd]);

    const buildDraft = useCallback((): MentionComposerDraft => {
      const el = editorRef.current;
      if (!el) {
        return {
          segments: [],
          text: "",
          textWithoutLargePastes: "",
          largePastes: [],
          skillMentions: [],
          commitMentions: [],
          gitFileMentions: [],
          codeMentions: [],
          isEmpty: true,
        };
      }

      const segments = serializeChildrenToSegments(el, largePastesRef.current);
      const largePastes: MentionComposerLargePaste[] = [];
      const skillMentions: MentionComposerSkillMention[] = [];
      const commitMentions: MentionComposerCommitMention[] = [];
      const gitFileMentions: MentionComposerGitFileMention[] = [];
      const codeMentions: CodeMentionReference[] = [];
      const textParts: string[] = [];
      const textWithoutLargePastesParts: string[] = [];
      for (const segment of segments) {
        if (segment.type === "text") {
          textParts.push(segment.text);
          textWithoutLargePastesParts.push(segment.text);
        } else if (segment.type === "fileMention") {
          const token = formatFileMentionToken(segment.reference);
          textParts.push(token);
          textWithoutLargePastesParts.push(token);
        } else if (segment.type === "largePaste") {
          largePastes.push(segment.paste);
          textParts.push(segment.paste.text);
        } else if (segment.type === "skillMention") {
          skillMentions.push(segment.skill);
          const token = formatSkillMentionToken(segment.skill);
          textParts.push(token);
          textWithoutLargePastesParts.push(token);
        } else if (segment.type === "commitMention") {
          commitMentions.push(segment.commit);
          const token = formatCommitMentionToken(segment.commit);
          textParts.push(token);
          textWithoutLargePastesParts.push(token);
        } else if (segment.type === "gitFileMention") {
          gitFileMentions.push(segment.file);
          const token = formatGitFileMentionToken(segment.file);
          textParts.push(token);
          textWithoutLargePastesParts.push(token);
        } else if (segment.type === "codeMention") {
          codeMentions.push(segment.reference);
          const token = formatCodeMentionToken(segment.reference);
          textParts.push(token);
          textWithoutLargePastesParts.push(token);
        }
      }

      const text = normalizeSerializedText(textParts.join(""));
      const textWithoutLargePastes = normalizeSerializedText(textWithoutLargePastesParts.join(""));
      return {
        segments,
        text,
        textWithoutLargePastes,
        largePastes,
        skillMentions,
        commitMentions,
        gitFileMentions,
        codeMentions,
        isEmpty: editorTextIsEmpty(el),
      };
    }, []);

    const createLargePaste = useCallback((text: string): MentionComposerLargePaste => {
      const normalizedText = normalizeLogicalLineEndings(text);
      const index = largePasteCounterRef.current + 1;
      largePasteCounterRef.current = index;
      return {
        id: `large-paste-${Date.now()}-${createUuid()}`,
        label: `Pasted text ${index}`,
        text: normalizedText,
        charCount: normalizedText.length,
        lineCount: countLargePasteLines(normalizedText),
        preview: normalizeLargePastePreview(normalizedText),
      };
    }, []);

    const insertLargePaste = useCallback(
      (text: string) => {
        const el = editorRef.current;
        if (!el) return;
        const paste = createLargePaste(text);
        largePastesRef.current.set(paste.id, paste);
        insertNodeAtCursor(el, createLargePasteChip(paste));
        closeMentionSession();
        refreshEmptyState();
      },
      [closeMentionSession, createLargePaste, refreshEmptyState],
    );

    // ---- Mention detection (called after DOM updates) ----
    const refreshMention = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      const applyContext = (ctx: MentionContext | null) => {
        if (!ctx) {
          if (mentionActiveRef.current) {
            closeMentionSession();
          }
          return;
        }
        setMentionCtx((prev) => (prev && mentionContextEquals(prev, ctx) ? prev : ctx));
        if (!mentionActiveRef.current) {
          mentionActiveRef.current = true;
          setHighlightIdx(0);
          startMentionSession(ctx);
          return;
        }
        if (ctx.query === mentionSessionQueryRef.current) return;
        mentionSessionQueryRef.current = ctx.query;
        setHighlightIdx(0);
        // The cached snapshot only answers the new query when it was complete
        // for the fetched one; anything else goes back to the backend. File
        // refetches are debounced so fast typing does not walk a large
        // workspace once per keystroke.
        const fetched = mentionFetchRef.current;
        if (mentionSnapshotCoversQuery(fetched, ctx.trigger, normalizeMentionQuery(ctx.query))) {
          cancelMentionRefetch();
        } else if (fetched?.trigger === "file" && ctx.trigger === "file") {
          scheduleMentionRefetch(ctx);
        } else {
          startMentionSession(ctx);
        }
      };

      applyContext(detectMention(el, enabledSkills.length > 0));
      window.requestAnimationFrame(() => {
        const nextEl = editorRef.current;
        if (!nextEl || document.activeElement !== nextEl) return;
        applyContext(detectMention(nextEl, enabledSkills.length > 0));
      });
    }, [
      cancelMentionRefetch,
      closeMentionSession,
      enabledSkills.length,
      scheduleMentionRefetch,
      startMentionSession,
    ]);

    useImperativeHandle(
      ref,
      () => ({
        getText: () => {
          const el = editorRef.current;
          if (!el) return "";
          finishTypewriter();
          return normalizeSerializedText(serializeChildren(el, largePastesRef.current));
        },
        getDraft: () => {
          finishTypewriter();
          return buildDraft();
        },
        hasContent: () => {
          const el = editorRef.current;
          return el != null && !editorTextIsEmpty(el);
        },
        setText: (text: string) => {
          const el = editorRef.current;
          if (!el) return;
          cancelTypewriter();
          resetPromptHistoryRecall();
          el.innerHTML = "";
          largePastesRef.current.clear();
          closeCommitTooltip();
          closeComposerContextMenu();
          const normalizedText = normalizeLogicalLineEndings(text);
          if (isLargePasteText(normalizedText)) {
            insertLargePaste(normalizedText);
          } else {
            el.textContent = normalizedText;
            closeMentionSession();
            refreshEmptyState();
          }
        },
        setDraft: (draft: MentionComposerDraft) => {
          const el = editorRef.current;
          if (!el) return;
          cancelTypewriter();
          resetPromptHistoryRecall();
          el.innerHTML = "";
          largePastesRef.current.clear();
          closeCommitTooltip();
          closeComposerContextMenu();

          for (const segment of draft.segments) {
            if (segment.type === "largePaste") {
              largePastesRef.current.set(segment.paste.id, segment.paste);
              el.appendChild(createLargePasteChip(segment.paste));
            } else if (segment.type === "fileMention") {
              const chip = createFileMentionChip(segment.reference.path, segment.reference.kind);
              if (chip) el.appendChild(chip);
            } else if (segment.type === "skillMention") {
              el.appendChild(createSkillMentionChip(segment.skill));
            } else if (segment.type === "commitMention") {
              el.appendChild(createCommitMentionChip(segment.commit));
            } else if (segment.type === "gitFileMention") {
              el.appendChild(createGitFileMentionChip(segment.file));
            } else if (segment.type === "codeMention") {
              const chip = createCodeMentionChip(segment.reference);
              if (chip) el.appendChild(chip);
            } else if (segment.text) {
              el.appendChild(document.createTextNode(normalizeLogicalLineEndings(segment.text)));
            }
          }
          largePasteCounterRef.current = Math.max(
            largePasteCounterRef.current,
            largePastesRef.current.size,
          );

          ensureTrailingCaretAnchor(el);
          closeMentionSession();
          refreshEmptyState();
          placeCaretAtEditorEnd();
          scheduleComposerSelectionScroll(el);
        },
        insertFileMention: (path: string, kind: "file" | "dir") => {
          const el = editorRef.current;
          if (!el) return;
          finishTypewriter();
          resetPromptHistoryRecall();
          focusEditorAtSavedSelection();
          const chip = createFileMentionChip(path, kind);
          if (!chip) return;
          insertNodeAtCursor(el, chip);
          closeMentionSession();
          refreshEmptyState();
        },
        insertSkillMention: (skill: MentionComposerSkillMention) => {
          const el = editorRef.current;
          if (!el) return;
          finishTypewriter();
          resetPromptHistoryRecall();
          focusEditorAtSavedSelection();
          insertNodeAtCursor(el, createSkillMentionChip(skill));
          closeMentionSession();
          refreshEmptyState();
        },
        insertCommitMention: (commit: MentionComposerCommitMention) => {
          const el = editorRef.current;
          if (!el) return;
          finishTypewriter();
          resetPromptHistoryRecall();
          focusEditorAtSavedSelection();
          insertNodeAtCursor(el, createCommitMentionChip(commit));
          closeMentionSession();
          refreshEmptyState();
        },
        insertGitFileMention: (file: MentionComposerGitFileMention) => {
          const el = editorRef.current;
          if (!el) return;
          finishTypewriter();
          resetPromptHistoryRecall();
          focusEditorAtSavedSelection();
          insertNodeAtCursor(el, createGitFileMentionChip(file));
          closeMentionSession();
          refreshEmptyState();
        },
        insertCodeMention: (reference: CodeMentionReference) => {
          const el = editorRef.current;
          if (!el) return;
          finishTypewriter();
          resetPromptHistoryRecall();
          focusEditorAtSavedSelection();
          const chip = createCodeMentionChip(reference);
          if (!chip) return;
          insertNodeAtCursor(el, chip);
          closeMentionSession();
          refreshEmptyState();
        },
        clear: () => {
          const el = editorRef.current;
          if (!el) return;
          cancelTypewriter();
          resetPromptHistoryRecall();
          el.innerHTML = "";
          largePastesRef.current.clear();
          closeCommitTooltip();
          closeComposerContextMenu();
          closeMentionSession();
          refreshEmptyState();
        },
        focus: () => editorRef.current?.focus(),
        typeText: (text: string) => {
          const el = editorRef.current;
          if (!el) return Promise.resolve();
          cancelTypewriter();
          resetPromptHistoryRecall();
          el.innerHTML = "";
          largePastesRef.current.clear();
          closeCommitTooltip();
          closeComposerContextMenu();
          closeMentionSession();
          el.focus({ preventScroll: true });

          const chars = Array.from(text);
          const textNode = document.createTextNode("");
          el.appendChild(textNode);
          if (chars.length === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            textNode.data = chars.join("");
            placeCaretAtEditorEnd();
            refreshEmptyState();
            return Promise.resolve();
          }

          return new Promise<void>((resolve) => {
            let settled = false;
            const settle = (restoreFocus: boolean) => {
              if (settled) return;
              settled = true;
              typewriterFocusPendingRef.current = restoreFocus;
              setIsTypewriting(false);
              resolve();
            };
            setIsTypewriting(true);

            // Freshly typed characters live in short-lived fade-in spans, then
            // fold into the committed text node once their fade completes, so
            // the editor always ends up holding one plain text node.
            const ghosts: HTMLSpanElement[] = [];
            const foldOldestGhost = () => {
              const ghost = ghosts.shift();
              if (!ghost) return;
              textNode.data += ghost.textContent ?? "";
              ghost.remove();
            };
            const finish = () => {
              for (const ghost of ghosts) ghost.remove();
              ghosts.length = 0;
              textNode.data = chars.join("");
              placeCaretAtEditorEnd();
              refreshEmptyState();
            };

            // Adaptive pace: long prompts speed up so the whole line lands in ~1s.
            const tickMs = Math.max(12, Math.min(28, Math.round(900 / chars.length)));
            const maxGhosts = Math.max(1, Math.ceil(TYPEWRITER_CHAR_FADE_MS / tickMs));
            let index = 0;
            const tick = () => {
              if (index < chars.length) {
                const ghost = document.createElement("span");
                ghost.className = "composer-typewriter-char";
                ghost.textContent = chars[index] ?? "";
                el.appendChild(ghost);
                ghosts.push(ghost);
                index += 1;
                while (ghosts.length > maxGhosts) foldOldestGhost();
                placeCaretAtEditorEnd();
                refreshEmptyState();
                typewriterRef.current = { timer: window.setTimeout(tick, tickMs), finish, settle };
                return;
              }
              if (ghosts.length > 0) {
                foldOldestGhost();
                placeCaretAtEditorEnd();
                typewriterRef.current = { timer: window.setTimeout(tick, tickMs), finish, settle };
                return;
              }
              typewriterRef.current = null;
              settle(true);
            };
            // Commit the first animated character in the same frame as the
            // replacement so the empty-state placeholder never flashes.
            tick();
          });
        },
      }),
      [
        buildDraft,
        cancelTypewriter,
        closeCommitTooltip,
        closeComposerContextMenu,
        closeMentionSession,
        finishTypewriter,
        focusEditorAtSavedSelection,
        insertLargePaste,
        placeCaretAtEditorEnd,
        refreshEmptyState,
        resetPromptHistoryRecall,
      ],
    );

    // ---- Select suggestion ----
    const selectSuggestion = useCallback(
      (suggestion: MentionSuggestion) => {
        if (!mentionCtx) return;
        if (!mentionCtx.textNode.isConnected) {
          closeMentionSession();
          return;
        }
        if (suggestion.type === "skill") {
          insertSkillMentionChip(mentionCtx, suggestion.skill);
        } else {
          insertMentionChip(mentionCtx, suggestion.entry.path, suggestion.entry.kind);
        }
        resetPromptHistoryRecall();
        closeMentionSession();
        refreshEmptyState();
        editorRef.current?.focus();
      },
      [closeMentionSession, mentionCtx, refreshEmptyState, resetPromptHistoryRecall],
    );

    const restoreComposerContextSelection = useCallback(() => {
      const el = editorRef.current;
      const range = composerContextMenuRangeRef.current;
      if (!el || !range || !editorRangeIsInsideRoot(el, range)) return false;

      const selection = window.getSelection();
      if (!selection) return false;

      try {
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      } catch {
        return false;
      }
    }, []);

    const contextMenuPosition = composerContextMenu
      ? clampComposerContextMenuPosition(composerContextMenu.x, composerContextMenu.y)
      : null;
    const contextMenuLabels =
      locale === "en-US"
        ? {
            cut: "Cut",
            copy: "Copy",
            paste: "Paste",
            selectAll: "Select all",
          }
        : {
            cut: "剪切",
            copy: "复制",
            paste: "粘贴",
            selectAll: "全选",
          };
    const contextMenuHasSelection = Boolean(composerContextMenu?.selectedText.length);
    const contextMenuCanMutate = !disabled;

    const handleComposerContextCopy = useCallback(() => {
      if (!composerContextMenu?.selectedText) return;
      restoreComposerContextSelection();
      writeTextToClipboard(composerContextMenu.selectedText);
      closeComposerContextMenu();
    }, [closeComposerContextMenu, composerContextMenu, restoreComposerContextSelection]);

    const handleComposerContextCut = useCallback(() => {
      const el = editorRef.current;
      const selectedText = composerContextMenu?.selectedText;
      if (!el || disabled || !selectedText) return;

      restoreComposerContextSelection();
      if (!deleteComposerSelection(el, largePastesRef.current)) return;

      resetPromptHistoryRecall();
      writeTextToClipboard(selectedText);
      closeMentionSession();
      refreshEmptyState();
      refreshMention();
      el.focus({ preventScroll: true });
      closeComposerContextMenu();
    }, [
      closeComposerContextMenu,
      closeMentionSession,
      composerContextMenu?.selectedText,
      disabled,
      refreshEmptyState,
      refreshMention,
      resetPromptHistoryRecall,
      restoreComposerContextSelection,
    ]);

    const handleComposerContextPaste = useCallback(async () => {
      const el = editorRef.current;
      if (!el || disabled) return;

      resetPromptHistoryRecall();
      el.focus({ preventScroll: true });

      // Native-first read: the webview clipboard API pops WebKit's paste
      // confirmation for externally-copied content (see readClipboardText).
      const text = await readComposerClipboardText();

      restoreComposerContextSelection();

      if (text === null) {
        document.execCommand("paste");
        closeMentionSession();
        refreshEmptyState();
        refreshMention();
        closeComposerContextMenu();
        return;
      }

      if (!text) {
        closeComposerContextMenu();
        return;
      }

      if (isLargePasteText(text)) {
        insertLargePaste(text);
        refreshMention();
        closeComposerContextMenu();
        return;
      }

      const serializedSegments = parseSerializedComposerText(text, enabledSkills);
      if (
        serializedSegments &&
        insertComposerSegmentsAtSelection(el, serializedSegments, largePastesRef.current)
      ) {
        closeMentionSession();
        refreshEmptyState();
        refreshMention();
        closeComposerContextMenu();
        return;
      }

      document.execCommand("insertText", false, text);
      closeMentionSession();
      refreshEmptyState();
      refreshMention();
      closeComposerContextMenu();
    }, [
      closeComposerContextMenu,
      closeMentionSession,
      disabled,
      enabledSkills,
      insertLargePaste,
      refreshEmptyState,
      refreshMention,
      resetPromptHistoryRecall,
      restoreComposerContextSelection,
    ]);

    const handleComposerContextSelectAll = useCallback(() => {
      const el = editorRef.current;
      if (!el || !composerContextMenu?.hasContent) return;

      el.focus({ preventScroll: true });
      selectComposerContents(el);
      closeMentionSession();
      closeComposerContextMenu();
    }, [closeComposerContextMenu, closeMentionSession, composerContextMenu?.hasContent]);

    // ---- Event handlers ----
    const handleContextMenu = useCallback(
      (event: MouseEvent<HTMLDivElement>) => {
        if (!usesCustomComposerContextMenu) return;
        event.preventDefault();

        const el = editorRef.current;
        if (!el) return;

        closeMentionSession();
        closeCommitTooltip();

        const selection = window.getSelection();
        let selectedText = "";
        let rangeForMenu: Range | null = null;

        if (selectionContainsPoint(el, selection, event.clientX, event.clientY)) {
          selectedText = resolveComposerSelectionText(el, largePastesRef.current);
          rangeForMenu = editorSelectionRange(el)?.cloneRange() ?? null;
        } else {
          el.focus({ preventScroll: true });
          if (placeComposerCaretFromPoint(el, event.clientX, event.clientY)) {
            rangeForMenu = editorSelectionRange(el)?.cloneRange() ?? null;
          } else {
            selection?.removeAllRanges();
          }
        }

        composerContextMenuRangeRef.current = rangeForMenu;
        setComposerContextMenu({
          x: event.clientX,
          y: event.clientY,
          selectedText,
          hasContent: !editorTextIsEmpty(el),
        });
      },
      [closeCommitTooltip, closeMentionSession],
    );

    // Large-paste chips can be removed by native editing paths (select +
    // delete, cut); drop their map entries so the pasted text is released.
    const pruneDetachedLargePastes = useCallback(() => {
      const el = editorRef.current;
      const pastes = largePastesRef.current;
      if (!el || pastes.size === 0) return;
      const attached = new Set<string>();
      el.querySelectorAll(`[${LARGE_PASTE_TAG_ATTR}]`).forEach((chip) => {
        const id = chip.getAttribute(LARGE_PASTE_TAG_ATTR);
        if (id) attached.add(id);
      });
      for (const id of pastes.keys()) {
        if (!attached.has(id)) pastes.delete(id);
      }
    }, []);

    const handleInput = useCallback(() => {
      // Any edit invalidates the ↑/↓ recall session: the stash no longer
      // reflects what should come back and the cursor must restart from the
      // newest entry.
      resetPromptHistoryRecall();
      closeComposerContextMenu();
      const el = editorRef.current;
      // Mutating the composing text node (or moving the selection) mid-IME
      // cancels the composition; compositionEnd re-runs the anchor cleanup.
      if (el && !isComposingRef.current) {
        removeStaleCaretAnchorsAroundSelection(el);
        normalizeCaretAfterChip(el);
      }
      pruneDetachedLargePastes();
      refreshEmptyState();
      if (!isComposingRef.current) {
        refreshMention();
      }
    }, [
      closeComposerContextMenu,
      pruneDetachedLargePastes,
      refreshEmptyState,
      refreshMention,
      resetPromptHistoryRecall,
    ]);

    const handleKeyUp = useCallback(
      (e: KeyboardEvent<HTMLDivElement>) => {
        if (disabled || isComposingRef.current || isImeKeyboardEvent(e)) return;
        const el = editorRef.current;
        // Arrow moves must never leave the caret inside a non-editable chip
        // (WebKit can drop it there); eject toward the travel direction.
        if (el && e.key.startsWith("Arrow")) {
          ejectCaretFromChip(el, e.key === "ArrowLeft" ? "before" : "after");
        }
        if (
          e.key === "ArrowDown" ||
          e.key === "ArrowUp" ||
          e.key === "Tab" ||
          e.key === "Enter" ||
          e.key === "Escape"
        ) {
          // ↑/↓ move the caret by x-position and can land on chip-boundary
          // dead zones just like clicks do; keep them anchor-normalised.
          if (el && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            removeStaleCaretAnchorsAroundSelection(el);
            normalizeCaretAfterChip(el);
          }
          return;
        }
        if (el) {
          removeStaleCaretAnchorsAroundSelection(el);
          normalizeCaretAfterChip(el);
        }
        refreshMention();
      },
      [disabled, refreshMention],
    );

    const handleMouseUp = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      // WebKit can drop a click's caret inside the non-editable chip itself.
      const ejected = ejectCaretFromChip(el, "after");
      if (normalizeCaretAfterChip(el) || ejected) {
        refreshMention();
      }
    }, [refreshMention]);

    const updateCommitTooltipFromTarget = useCallback(
      (target: EventTarget | null) => {
        const editor = editorRef.current;
        const chip =
          target instanceof Element && editor
            ? target.closest<HTMLElement>(`[${COMMIT_MENTION_SHA_ATTR}]`)
            : null;
        if (!chip || !editor?.contains(chip)) {
          closeCommitTooltip();
          return;
        }
        if (commitTooltipChipRef.current === chip) return;
        const commit = commitMentionFromElement(chip);
        if (!commit) {
          closeCommitTooltip();
          return;
        }
        commitTooltipChipRef.current = chip;
        setCommitTooltip({ commit, rect: chip.getBoundingClientRect() });
      },
      [closeCommitTooltip],
    );

    const cancelCommitTooltipClose = useCallback(() => {
      if (commitTooltipCloseTimerRef.current === null) return;
      window.clearTimeout(commitTooltipCloseTimerRef.current);
      commitTooltipCloseTimerRef.current = null;
    }, []);

    const scheduleCommitTooltipClose = useCallback(() => {
      cancelCommitTooltipClose();
      commitTooltipCloseTimerRef.current = window.setTimeout(() => {
        commitTooltipCloseTimerRef.current = null;
        closeCommitTooltip();
      }, 120);
    }, [cancelCommitTooltipClose, closeCommitTooltip]);

    useEffect(() => cancelCommitTooltipClose, [cancelCommitTooltipClose]);

    const handleMouseMove = useCallback(
      (event: MouseEvent<HTMLDivElement>) => {
        cancelCommitTooltipClose();
        updateCommitTooltipFromTarget(event.target);
      },
      [cancelCommitTooltipClose, updateCommitTooltipFromTarget],
    );

    const handleFocus = useCallback(
      (event: FocusEvent<HTMLDivElement>) => {
        updateCommitTooltipFromTarget(event.target);
      },
      [updateCommitTooltipFromTarget],
    );

    // ---- Prompt-history recall (↑/↓) ----
    const applyPromptHistoryText = useCallback(
      (text: string) => {
        const el = editorRef.current;
        if (!el) return;
        el.innerHTML = "";
        largePastesRef.current.clear();
        closeCommitTooltip();
        closeComposerContextMenu();
        if (isLargePasteText(text)) {
          insertLargePaste(text);
        } else {
          el.innerText = text;
          closeMentionSession();
          refreshEmptyState();
        }
        placeCaretAtEditorEnd();
        scheduleComposerSelectionScroll(el);
      },
      [
        closeCommitTooltip,
        closeComposerContextMenu,
        closeMentionSession,
        insertLargePaste,
        placeCaretAtEditorEnd,
        refreshEmptyState,
      ],
    );

    const restorePromptHistoryStash = useCallback(
      (stash: PromptHistoryStash<MentionComposerLargePaste>) => {
        const el = editorRef.current;
        if (!el) return;
        el.innerHTML = stash.html;
        largePastesRef.current.clear();
        for (const [id, paste] of stash.pastes) {
          largePastesRef.current.set(id, paste);
        }
        closeCommitTooltip();
        closeComposerContextMenu();
        closeMentionSession();
        refreshEmptyState();
        placeCaretAtEditorEnd();
        scheduleComposerSelectionScroll(el);
      },
      [
        closeCommitTooltip,
        closeComposerContextMenu,
        closeMentionSession,
        placeCaretAtEditorEnd,
        refreshEmptyState,
      ],
    );

    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLDivElement>) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        // The typewriter owns the editor while it runs; swallow keys so Enter
        // cannot send a half-typed suggestion.
        if (typewriterRef.current) {
          e.preventDefault();
          return;
        }
        const isEnter = isEnterKeyboardEvent(e);
        const isActiveCompositionKey = isComposingRef.current || isActiveImeKeyboardEvent(e);
        const hasLegacyImeSignal = hasLegacyImeKeyboardSignal(e);

        if (isActiveCompositionKey) {
          if (isEnter && !e.shiftKey) {
            compositionEnterKeyRef.current = true;
            refreshEmptyState();
            refreshMention();
          } else {
            compositionEnterKeyRef.current = false;
          }
          return;
        }

        if (isEnter && !e.shiftKey && imeEnterSuppressUntilRef.current >= performance.now()) {
          e.preventDefault();
          imeEnterSuppressUntilRef.current = 0;
          compositionEnterKeyRef.current = false;
          lastCompositionEndAtRef.current = 0;
          refreshEmptyState();
          refreshMention();
          return;
        }

        const compositionEndedAgoMs = performance.now() - lastCompositionEndAtRef.current;
        if (
          isEnter &&
          !e.shiftKey &&
          lastCompositionEndAtRef.current > 0 &&
          compositionEndedAgoMs >= 0 &&
          compositionEndedAgoMs <= IME_COMPOSITION_END_ENTER_TAIL_MS
        ) {
          e.preventDefault();
          imeEnterSuppressUntilRef.current = 0;
          compositionEnterKeyRef.current = false;
          lastCompositionEndAtRef.current = 0;
          refreshEmptyState();
          refreshMention();
          return;
        }

        // Legacy keyCode 229 is too broad in WebViews. It is still useful for
        // ignoring non-Enter IME key noise, but should not block normal sending.
        if (!isEnter && hasLegacyImeSignal) {
          return;
        }

        // Popup navigation
        if (popupVisible && suggestions.length > 0) {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlightIdx((p) => (p + 1) % suggestions.length);
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlightIdx((p) => (p - 1 + suggestions.length) % suggestions.length);
            return;
          }
          if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
            e.preventDefault();
            if (suggestions[highlightIdx]) {
              selectSuggestion(suggestions[highlightIdx]);
            }
            return;
          }
        }
        if (popupVisible && e.key === "Escape") {
          e.preventDefault();
          closeMentionSession();
          return;
        }

        // Shell-style ↑/↓ recall of previously sent prompts. Only fires with
        // the caret on the first/last logical line so plain caret movement
        // inside multi-line drafts stays untouched; any edit resets the
        // session (handleInput).
        if (
          loadHistoryPrompts &&
          !popupVisible &&
          (e.key === "ArrowUp" || e.key === "ArrowDown") &&
          !e.shiftKey &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey
        ) {
          const el = editorRef.current;
          const caretLine = el ? caretPromptHistoryLine(el) : null;
          if (el && caretLine) {
            const step = stepPromptHistory({
              direction: e.key === "ArrowUp" ? "prev" : "next",
              session: promptHistorySessionRef.current,
              caretOnFirstLine: caretLine.onFirstLine,
              caretOnLastLine: caretLine.onLastLine,
              loadEntries: loadHistoryPrompts,
              makeStash: () => ({
                html: el.innerHTML,
                pastes: [...largePastesRef.current],
              }),
            });
            if (step.type !== "pass") {
              e.preventDefault();
              if (step.type === "apply") {
                promptHistorySessionRef.current = step.session;
                applyPromptHistoryText(step.text);
              } else if (step.type === "restore") {
                promptHistorySessionRef.current = null;
                restorePromptHistoryStash(step.stash);
              }
              return;
            }
          }
        }

        // ←/→ next to a mention chip: step over the whole chip. The default
        // single-character move would land inside the caret-anchor dead zone
        // and get snapped right back — or, in WebKit, inside the chip itself.
        if (
          (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
          !e.shiftKey &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey
        ) {
          const el = editorRef.current;
          if (el && stepCaretOverChip(el, e.key === "ArrowLeft" ? "left" : "right")) {
            e.preventDefault();
            scheduleComposerSelectionScroll(el);
            return;
          }
        }

        // Backspace: delete mention chip if cursor is right after one
        if (e.key === "Backspace") {
          const el = editorRef.current;
          if (el && deleteChipBeforeCursor(el, largePastesRef.current)) {
            e.preventDefault();
            resetPromptHistoryRecall();
            refreshEmptyState();
            refreshMention();
            return;
          }
        }

        // Delete: forward-delete the chip right after the cursor as one unit
        if (e.key === "Delete") {
          const el = editorRef.current;
          if (el && deleteChipAfterCursor(el, largePastesRef.current)) {
            e.preventDefault();
            resetPromptHistoryRecall();
            refreshEmptyState();
            refreshMention();
            return;
          }
        }

        // Normal Enter → send
        if (isEnter && !e.shiftKey) {
          imeEnterSuppressUntilRef.current = 0;
          compositionEnterKeyRef.current = false;
          lastCompositionEndAtRef.current = 0;
          e.preventDefault();
          onSend();
          return;
        }

        // Shift+Enter → line break (normalise to <br>)
        if (isEnter && e.shiftKey) {
          imeEnterSuppressUntilRef.current = 0;
          compositionEnterKeyRef.current = false;
          lastCompositionEndAtRef.current = 0;
          e.preventDefault();
          document.execCommand("insertLineBreak");
          scheduleComposerSelectionScroll(editorRef.current);
          refreshEmptyState();
          refreshMention();
          return;
        }
      },
      [
        popupVisible,
        suggestions,
        highlightIdx,
        selectSuggestion,
        disabled,
        closeMentionSession,
        onSend,
        refreshEmptyState,
        refreshMention,
        loadHistoryPrompts,
        applyPromptHistoryText,
        restorePromptHistoryStash,
        resetPromptHistoryRecall,
      ],
    );

    const handleCopy = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
      const snapshot = resolveComposerSelection(editorRef.current, largePastesRef.current);
      if (!snapshot) return;
      event.preventDefault();
      writeComposerClipboardSnapshot(event.clipboardData, snapshot);
    }, []);

    const handleCut = useCallback(
      (event: ClipboardEvent<HTMLDivElement>) => {
        if (disabled || typewriterRef.current) {
          event.preventDefault();
          return;
        }
        const editor = editorRef.current;
        const snapshot = resolveComposerSelection(editor, largePastesRef.current);
        if (!editor || !snapshot) return;
        event.preventDefault();
        writeComposerClipboardSnapshot(event.clipboardData, snapshot);
        resetPromptHistoryRecall();
        // execCommand routes the removal through the browser editing pipeline
        // so Ctrl+Z still restores the cut content — native cut was undoable
        // before this interception. Its synchronous input event runs
        // handleInput, which prunes detached large-paste map entries.
        if (
          !document.execCommand("delete") &&
          !deleteComposerSelection(editor, largePastesRef.current)
        ) {
          return;
        }
        closeMentionSession();
        refreshEmptyState();
        refreshMention();
      },
      [closeMentionSession, disabled, refreshEmptyState, refreshMention, resetPromptHistoryRecall],
    );

    const handlePaste = useCallback(
      (e: ClipboardEvent<HTMLDivElement>) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        if (typewriterRef.current) {
          e.preventDefault();
          return;
        }
        // The large-paste chip path mutates the DOM without an input event,
        // so the recall session must reset here as well.
        resetPromptHistoryRecall();
        const clipboardSegments = readComposerClipboardSegments(e.clipboardData, enabledSkills);
        if (clipboardSegments) {
          e.preventDefault();
          const restoredSegments = rebuildClipboardSegmentsForPaste(
            clipboardSegments,
            createLargePaste,
          );
          const editor = editorRef.current;
          if (editor) {
            insertComposerSegmentsAtSelection(editor, restoredSegments, largePastesRef.current);
          }
          closeMentionSession();
          refreshEmptyState();
          refreshMention();
          return;
        }
        const clipboardFiles = extractClipboardFiles(e.clipboardData);
        if (clipboardFiles.length > 0) {
          e.preventDefault();
          onPasteFiles?.(clipboardFiles);
          return;
        }
        e.preventDefault();
        const text = normalizeLogicalLineEndings(e.clipboardData.getData("text/plain"));
        if (isLargePasteText(text)) {
          insertLargePaste(text);
          return;
        }
        const serializedSegments = parseSerializedComposerText(text, enabledSkills);
        const editor = editorRef.current;
        if (
          serializedSegments &&
          editor &&
          insertComposerSegmentsAtSelection(editor, serializedSegments, largePastesRef.current)
        ) {
          closeMentionSession();
          refreshEmptyState();
          refreshMention();
          return;
        }
        insertPlainTextWithUndo(text);
        refreshEmptyState();
        refreshMention();
      },
      [
        disabled,
        closeMentionSession,
        createLargePaste,
        enabledSkills,
        insertLargePaste,
        onPasteFiles,
        refreshEmptyState,
        refreshMention,
        resetPromptHistoryRecall,
      ],
    );

    const handleCompositionStart = useCallback(() => {
      isComposingRef.current = true;
      compositionEnterKeyRef.current = false;
      lastCompositionEndAtRef.current = 0;
      imeEnterSuppressUntilRef.current = 0;
      if (busyReleaseTimerRef.current !== null) {
        window.clearTimeout(busyReleaseTimerRef.current);
        busyReleaseTimerRef.current = null;
      }
      setBusy(true);
    }, [setBusy]);

    const handleCompositionEnd = useCallback(() => {
      isComposingRef.current = false;
      lastCompositionEndAtRef.current = performance.now();
      if (compositionEnterKeyRef.current) {
        imeEnterSuppressUntilRef.current = performance.now() + IME_ENTER_SUPPRESS_WINDOW_MS;
        compositionEnterKeyRef.current = false;
      }
      const el = editorRef.current;
      if (el) {
        removeStaleCaretAnchorsAroundSelection(el);
      }
      refreshEmptyState();
      refreshMention();
      scheduleBusyRelease();
    }, [refreshEmptyState, refreshMention, scheduleBusyRelease]);

    const handleBlur = useCallback(() => {
      rememberEditorSelection();
      isComposingRef.current = false;
      compositionEnterKeyRef.current = false;
      lastCompositionEndAtRef.current = 0;
      imeEnterSuppressUntilRef.current = 0;
      if (busyReleaseTimerRef.current !== null) {
        window.clearTimeout(busyReleaseTimerRef.current);
        busyReleaseTimerRef.current = null;
      }
      setBusy(false);
      closeComposerContextMenu();
      closeMentionSession();
      cancelCommitTooltipClose();
      closeCommitTooltip();
    }, [
      cancelCommitTooltipClose,
      closeCommitTooltip,
      closeComposerContextMenu,
      closeMentionSession,
      rememberEditorSelection,
      setBusy,
    ]);

    return (
      <div ref={wrapperRef} className="relative w-full min-w-0 max-w-full flex-1">
        {popupVisible && (
          <Popup
            anchorRef={wrapperRef}
            trigger={mentionCtx.trigger}
            suggestions={suggestions}
            highlightIndex={highlightIdx}
            isLoading={popupLoading}
            error={popupError}
            showEmpty={showEmpty}
            emptyLabel={popupEmptyLabel}
            onSelect={selectSuggestion}
          />
        )}
        {commitTooltip ? (
          <CommitMentionTooltip
            commit={commitTooltip.commit}
            rect={commitTooltip.rect}
            onMouseEnter={cancelCommitTooltipClose}
            onMouseLeave={scheduleCommitTooltipClose}
          />
        ) : null}
        {composerContextMenu && contextMenuPosition
          ? createPortal(
              <div
                ref={composerContextMenuRef}
                role="menu"
                className="fixed z-[120] w-max min-w-[9.5rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-border/70 bg-popover p-1.5 text-popover-foreground shadow-[0_20px_60px_-20px_rgba(15,23,42,0.35)]"
                style={{
                  left: contextMenuPosition.left,
                  top: contextMenuPosition.top,
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={!contextMenuCanMutate || !contextMenuHasSelection}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] text-foreground/90 transition-colors hover:bg-accent hover:text-accent-foreground",
                    "disabled:pointer-events-none disabled:opacity-45",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleComposerContextCut}
                >
                  <Scissors className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{contextMenuLabels.cut}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!contextMenuHasSelection}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] text-foreground/90 transition-colors hover:bg-accent hover:text-accent-foreground",
                    "disabled:pointer-events-none disabled:opacity-45",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleComposerContextCopy}
                >
                  <Copy className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{contextMenuLabels.copy}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!contextMenuCanMutate}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] text-foreground/90 transition-colors hover:bg-accent hover:text-accent-foreground",
                    "disabled:pointer-events-none disabled:opacity-45",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    void handleComposerContextPaste();
                  }}
                >
                  <ClipboardPaste className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{contextMenuLabels.paste}</span>
                </button>
                <div className="my-1 h-px bg-border/70" />
                <button
                  type="button"
                  role="menuitem"
                  disabled={!composerContextMenu.hasContent}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] text-foreground/90 transition-colors hover:bg-accent hover:text-accent-foreground",
                    "disabled:pointer-events-none disabled:opacity-45",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleComposerContextSelectAll}
                >
                  <ScanText className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{contextMenuLabels.selectAll}</span>
                </button>
              </div>,
              document.body,
            )
          : null}
        {/* biome-ignore lint/a11y/useSemanticElements: The composer is contenteditable so it can host inline mention chips. */}
        <div
          ref={editorRef}
          contentEditable={!disabled && !isTypewriting}
          suppressContentEditableWarning
          role="textbox"
          tabIndex={disabled ? undefined : 0}
          aria-multiline
          aria-placeholder={placeholder}
          aria-disabled={disabled}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onFocus={handleFocus}
          onMouseLeave={scheduleCommitTooltipClose}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onCopy={handleCopy}
          onCut={handleCut}
          onPaste={handlePaste}
          onContextMenu={handleContextMenu}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onBlur={handleBlur}
          className={cn(
            "mention-composer min-h-[70px] max-h-[160px] w-full min-w-0 max-w-full overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] outline-hidden",
            "text-sm",
            isDomEmpty && "is-empty",
            disabled && "cursor-not-allowed opacity-60",
            className,
          )}
          data-placeholder={placeholder}
        />
      </div>
    );
  }),
);

MentionComposer.displayName = "MentionComposer";
