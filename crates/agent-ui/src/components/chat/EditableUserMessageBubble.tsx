import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "../../i18n";
import {
  type PendingUploadedFile,
  splitUserAttachmentsForDisplay,
} from "../../lib/chat/uploadedFiles";
import type { UploadedImagePreviewLoader } from "../../lib/chat/uploadedImagePreview";
import { cn } from "../../lib/shared/utils";
import { UserAttachmentCards } from "./UserAttachmentCards";

const MIN_EDIT_BUBBLE_HEIGHT_PX = 72;

function resizeEditableTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) {
    return;
  }
  textarea.style.height = "0px";
  textarea.style.height = `${Math.max(textarea.scrollHeight, MIN_EDIT_BUBBLE_HEIGHT_PX)}px`;
}

export type EditableUserMessageBubbleProps = {
  initialText: string;
  attachments: PendingUploadedFile[];
  workspaceRoot?: string;
  className?: string;
  textareaClassName?: string;
  textareaSizing?: "lineCount" | "content";
  preserveViewportScrollOnFocus?: boolean;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  imagePreviewMode?: "absolutePath" | "imageKind";
  attachmentRemoveLabel?: string;
  onCancel: () => void;
  onSubmit: (text: string, attachments: PendingUploadedFile[]) => void;
};

export const EditableUserMessageBubble = memo(function EditableUserMessageBubble(
  props: EditableUserMessageBubbleProps,
) {
  const {
    initialText,
    attachments,
    workspaceRoot,
    className,
    textareaClassName,
    textareaSizing = "lineCount",
    preserveViewportScrollOnFocus = false,
    onLoadUploadedImagePreview,
    imagePreviewMode,
    attachmentRemoveLabel,
    onCancel,
    onSubmit,
  } = props;
  const { t } = useLocale();
  const [draftText, setDraftText] = useState(initialText);
  const [draftAttachments, setDraftAttachments] = useState(attachments);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    if (preserveViewportScrollOnFocus) {
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    if (textareaSizing === "content") {
      resizeEditableTextarea(textarea);
    }
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  }, [preserveViewportScrollOnFocus, textareaSizing]);

  useEffect(() => {
    if (!preserveViewportScrollOnFocus) {
      return;
    }
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

    const animationFrameId = requestAnimationFrame(restoreViewportScroll);
    return () => cancelAnimationFrame(animationFrameId);
  }, [preserveViewportScrollOnFocus]);

  useEffect(() => {
    setDraftAttachments(attachments);
  }, [attachments]);

  useLayoutEffect(() => {
    if (textareaSizing === "content") {
      resizeEditableTextarea(textareaRef.current);
    }
  }, [draftText, textareaSizing]);

  const visibleAttachments = useMemo(
    () => splitUserAttachmentsForDisplay(draftAttachments, draftText).visibleFiles,
    [draftAttachments, draftText],
  );
  const canSubmit = draftText.trim().length > 0 || draftAttachments.length > 0;

  return (
    <div
      className={cn(
        "w-full max-w-[min(85%,calc(50em+2.5rem))] rounded-2xl border border-border bg-[hsl(var(--chat-user-bg))] p-3",
        className,
      )}
    >
      <UserAttachmentCards
        files={visibleAttachments}
        workspaceRoot={workspaceRoot}
        onLoadUploadedImagePreview={onLoadUploadedImagePreview}
        imagePreviewMode={imagePreviewMode}
        onRemove={(relativePath) => {
          setDraftAttachments((current) =>
            current.filter((file) => file.relativePath !== relativePath),
          );
        }}
        removeLabel={attachmentRemoveLabel}
      />
      <textarea
        ref={textareaRef}
        className={cn(
          "w-full resize-none rounded-lg bg-transparent p-2 font-chat text-[calc(14.5px*var(--zone-font-scale,1))] leading-relaxed text-[hsl(var(--chat-user-fg))] outline-none",
          textareaClassName,
        )}
        value={draftText}
        onChange={(event) => setDraftText(event.target.value)}
        rows={textareaSizing === "content" ? 1 : Math.max(2, draftText.split("\n").length)}
        aria-label={t("chat.editMessage")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
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
          className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canSubmit}
          onClick={() => {
            if (!canSubmit) {
              return;
            }
            onSubmit(draftText.trim(), draftAttachments);
          }}
        >
          {t("chat.send")}
        </button>
      </div>
    </div>
  );
});
