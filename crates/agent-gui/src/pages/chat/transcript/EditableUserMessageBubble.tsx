import { memo, useEffect, useRef, useState } from "react";

import { useLocale } from "../../../i18n";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
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

  const canSubmit = draftText.trim().length > 0 || draftAttachments.length > 0;

  return (
    <div
      className={`w-full max-w-[min(85%,calc(50em+2.5rem))] rounded-2xl border border-border bg-[hsl(var(--chat-user-bg))] p-3 ${compactedClass}`}
    >
      <UserAttachmentCards
        files={draftAttachments}
        workspaceRoot={workspaceRoot}
        onRemove={(relativePath) => {
          setDraftAttachments((prev) => prev.filter((file) => file.relativePath !== relativePath));
        }}
      />
      <textarea
        ref={textareaRef}
        className="w-full resize-none rounded-lg bg-transparent p-2 font-openai-chat text-[calc(14.5px*var(--zone-font-scale,1))] leading-relaxed text-[hsl(var(--chat-user-fg))] outline-none"
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
