import {
  type ComponentProps,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useLocale } from "../../i18n";
import {
  type PendingUploadedFile,
  splitUserAttachmentsForDisplay,
} from "../../lib/chat/uploadedFiles";
import type { UploadedImagePreviewLoader } from "../../lib/chat/uploadedImagePreview";
import { type CommitDetailsLoader, UserMessageContent } from "../../lib/chat/userMessageContent";
import { cn } from "../../lib/shared/utils";
import { TRANSCRIPT_REVEAL_EVENT } from "../../lib/transcript-find/transcriptFindDom";
import { ChevronDown, ChevronUp } from "../IconSet";
import { UserAttachmentCards } from "./UserAttachmentCards";

/** Lines a collapsed user message keeps visible. */
export const USER_MESSAGE_CLAMP_LINES = 10;
/** Collapse only when it hides at least this many lines; hiding one or two is noise. */
const USER_MESSAGE_MIN_HIDDEN_LINES = 3;
/** text-sm (14px) × leading-relaxed (1.625), used when the computed line height is "normal". */
const FALLBACK_LINE_HEIGHT_PX = 22.75;

// Expansion survives the virtual list unmounting a row: scrolling away and
// back must not re-collapse (and resize) a message the user opened.
const MAX_REMEMBERED_EXPANSIONS = 500;
const expandedUserMessages = new Set<string>();
function rememberExpansion(key: string, expanded: boolean) {
  expandedUserMessages.delete(key);
  if (!expanded) return;
  expandedUserMessages.add(key);
  if (expandedUserMessages.size > MAX_REMEMBERED_EXPANSIONS) {
    const oldest = expandedUserMessages.values().next().value;
    if (oldest !== undefined) expandedUserMessages.delete(oldest);
  }
}

export function userMessageClampHeight(lineHeightPx: number) {
  return Math.round(lineHeightPx * USER_MESSAGE_CLAMP_LINES);
}

export function shouldClampUserMessage(contentHeightPx: number, lineHeightPx: number) {
  return (
    contentHeightPx > lineHeightPx * (USER_MESSAGE_CLAMP_LINES + USER_MESSAGE_MIN_HIDDEN_LINES)
  );
}

function readLineHeight(element: Element) {
  const view = element.ownerDocument.defaultView;
  const value = view ? Number.parseFloat(view.getComputedStyle(element).lineHeight) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : FALLBACK_LINE_HEIGHT_PX;
}

/** Pointer clicks on a chip keep the bubble as it is; only keyboard focus expands. */
function isKeyboardFocus(target: Element | null) {
  if (!target || typeof target.matches !== "function") return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    return true;
  }
}

type UserMessageBubbleBodyProps = {
  /** Stable message key; remembers expansion across virtual-row remounts. */
  messageKey?: string;
  text: string;
  attachments: PendingUploadedFile[];
  workspaceRoot?: string;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  imagePreviewMode?: ComponentProps<typeof UserAttachmentCards>["imagePreviewMode"];
  loadCommitDetails?: CommitDetailsLoader;
  legacyInlineFileMentions?: boolean;
};

/**
 * The user message bubble shared by the desktop and WebUI transcripts.
 * Tall text is clamped to USER_MESSAGE_CLAMP_LINES with a fade and a
 * Show more / Show less toggle. The clamp only hides overflow: the full text
 * stays in the DOM, so selection, quoting and find keep working (find expands
 * the bubble through TRANSCRIPT_REVEAL_EVENT, focus moving inside expands it
 * too).
 */
export function UserMessageBubbleBody(props: UserMessageBubbleBodyProps) {
  const {
    messageKey,
    text,
    attachments,
    workspaceRoot,
    onLoadUploadedImagePreview,
    imagePreviewMode,
    loadCommitDetails,
    legacyInlineFileMentions,
  } = props;
  const { t } = useLocale();
  const { visibleFiles, pastedTextFiles } = splitUserAttachmentsForDisplay(attachments, text);
  const contentId = useId();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // null: fits (or not measured yet); otherwise the collapsed height in px.
  const [clampHeight, setClampHeight] = useState<number | null>(null);
  const [expanded, setExpandedState] = useState(() =>
    messageKey ? expandedUserMessages.has(messageKey) : false,
  );
  const setExpanded = useCallback(
    (next: boolean) => {
      if (messageKey) rememberExpansion(messageKey, next);
      setExpandedState(next);
    },
    [messageKey],
  );

  // Layout effect: the first measurement lands before paint, so a long
  // message never flashes at full height and the virtual row is measured once
  // at its collapsed size.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => {
      const lineHeight = readLineHeight(content);
      const next = shouldClampUserMessage(content.offsetHeight, lineHeight)
        ? userMessageClampHeight(lineHeight)
        : null;
      setClampHeight((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const clamped = clampHeight !== null && !expanded;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !clamped) return;
    // Find asks for a reveal; keyboard focus landing on a chip or link in the
    // hidden part expands too, so focus never sits in clipped content.
    const reveal = () => setExpanded(true);
    const revealOnKeyboardFocus = (event: FocusEvent) => {
      const target = event.target as Element | null;
      if (isKeyboardFocus(target)) setExpanded(true);
    };
    viewport.addEventListener(TRANSCRIPT_REVEAL_EVENT, reveal);
    viewport.addEventListener("focusin", revealOnKeyboardFocus);
    return () => {
      viewport.removeEventListener(TRANSCRIPT_REVEAL_EVENT, reveal);
      viewport.removeEventListener("focusin", revealOnKeyboardFocus);
    };
  }, [clamped, setExpanded]);

  return (
    <div
      className={cn(
        "ml-auto w-fit max-w-full",
        "whitespace-pre-wrap rounded-2xl rounded-br-md bg-[hsl(var(--chat-user-bg))] px-4 py-2.5",
        "font-chat text-sm leading-relaxed break-words text-[hsl(var(--chat-user-fg))] [overflow-wrap:anywhere]",
      )}
    >
      <UserAttachmentCards
        files={visibleFiles}
        workspaceRoot={workspaceRoot}
        onLoadUploadedImagePreview={onLoadUploadedImagePreview}
        imagePreviewMode={imagePreviewMode}
      />
      {text ? (
        <>
          <div
            ref={viewportRef}
            id={contentId}
            className="relative"
            style={clamped ? { maxHeight: clampHeight, overflow: "hidden" } : undefined}
            // TRANSCRIPT_COLLAPSED_ATTR: find expands the bubble to reveal a match.
            data-transcript-collapsed={clamped ? "" : undefined}
          >
            <div ref={contentRef}>
              <UserMessageContent
                text={text}
                pastedTextFiles={pastedTextFiles}
                loadCommitDetails={loadCommitDetails}
                legacyInlineFileMentions={legacyInlineFileMentions}
              />
            </div>
            {clamped ? (
              <div
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b",
                  "from-transparent to-[hsl(var(--chat-user-bg))]",
                )}
              />
            ) : null}
          </div>
          {clampHeight !== null ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={contentId}
              onClick={() => setExpanded(!expanded)}
              className={cn(
                "-ml-1.5 mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 outline-hidden",
                "text-xs font-medium text-[hsl(var(--chat-user-fg)/0.65)] transition-colors",
                "hover:bg-foreground/[0.06] hover:text-[hsl(var(--chat-user-fg))]",
                "focus-visible:ring-2 focus-visible:ring-ring/50",
              )}
            >
              {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              <span>
                {expanded ? t("chat.userMessage.collapse") : t("chat.userMessage.expand")}
              </span>
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
