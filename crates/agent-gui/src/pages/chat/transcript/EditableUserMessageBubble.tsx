import { useLocale } from "@liveagent/ui/i18n/index";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import { splitUserAttachmentsForDisplay } from "./transcriptUtils";
import { UserAttachmentCards } from "./UserAttachmentCards";

export const EditableUserMessageBubble = memo(function EditableUserMessageBubble(props: {
  initialText: string;
  attachments: PendingUploadedFile[];
  workspaceRoot?: string;
  compactedClass: string;
  onCancel: () => void;
  onSubmit: (text: string, attachments: PendingUploadedFile[]) => void;
}) {
  const { initialText, attachments, workspaceRoot, compactedClass, onCancel, onSubmit } = props;
  const { t } = useLocale();
  const [draftText, setDraftText] = useState(initialText);
  const [draftAttachments, setDraftAttachments] = useState(attachments);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const viewport = textarea.closest<HTMLDivElement>("[data-scroll-viewport]");
    const scrollTopBeforeFocus = viewport?.scrollTop ?? null;
    const restoreViewportScroll = () => {
      if (viewport && scrollTopBeforeFocus !== null) {
        viewport.scrollTop = scrollTopBeforeFocus;
      }
    };

    textarea.focus({ preventScroll: true });
    const cursorPosition = textarea.value.length;
    textarea.setSelectionRange(cursorPosition, cursorPosition);
    restoreViewportScroll();

    const rafId = requestAnimationFrame(restoreViewportScroll);
    return () => cancelAnimationFrame(rafId);
  }, []);

  useEffect(() => {
    setDraftAttachments(attachments);
  }, [attachments]);

  // A large paste is stored as an uploaded text file *plus* a
  // "[Pasted text N: path]" marker inlined into the message text (rendered
  // as a chip once sent, see UserMessageRow). Editing must hide that same
  // file's attachment card while its marker is still present in the text,
  // otherwise the paste shows up twice: once as a card, once as raw marker
  // text in the textarea below. The full (unfiltered) list — including
  // pasted-text files — is still what gets submitted, so nothing is lost on
  // resend; only the card list is narrowed for display.
  const visibleAttachments = useMemo(
    () => splitUserAttachmentsForDisplay(draftAttachments, draftText).visibleFiles,
    [draftAttachments, draftText],
  );

  const canSubmit = draftText.trim().length > 0 || draftAttachments.length > 0;

  return (
    <div
      className={`w-full max-w-[min(85%,calc(50em+2.5rem))] rounded-2xl border border-border bg-[hsl(var(--chat-user-bg))] p-3 ${compactedClass}`}
    >
      <UserAttachmentCards
        files={visibleAttachments}
        workspaceRoot={workspaceRoot}
        onRemove={(relativePath) => {
          setDraftAttachments((prev) => prev.filter((file) => file.relativePath !== relativePath));
        }}
      />
      <textarea
        ref={textareaRef}
        className="w-full resize-none rounded-lg bg-transparent p-2 font-chat text-[calc(14.5px*var(--zone-font-scale,1))] leading-relaxed text-[hsl(var(--chat-user-fg))] outline-none"
        value={draftText}
        onChange={(e) => setDraftText(e.target.value)}
        rows={Math.max(2, draftText.split("\n").length)}
        aria-label={t("chat.editMessage")}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onCancel();
          }
        }}
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
          onClick={onCancel}
        >
          {t("chat.cancel")}
        </button>
        <button
          type="button"
          className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90"
          disabled={!canSubmit}
          onClick={() => {
            const newText = draftText.trim();
            if (!canSubmit) return;
            onSubmit(newText, draftAttachments);
          }}
        >
          {t("chat.send")}
        </button>
      </div>
    </div>
  );
});
