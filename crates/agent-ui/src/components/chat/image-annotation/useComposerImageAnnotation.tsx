import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";
import type { AnnotationDocument } from "@liveagent/ui/lib/chat/imageAnnotation/model";
import type {
  PendingUploadedFile,
  ReplacePendingUpload,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import {
  loadUploadedImagePreview,
  registerLocalUploadedImagePreviews,
  type UploadedImagePreviewLoader,
} from "@liveagent/ui/lib/chat/uploadedImagePreview";
import { type MutableRefObject, type ReactNode, useCallback, useRef, useState } from "react";
import { ImageAnnotationDialog, type ImageAnnotationResult } from "./ImageAnnotationDialog";

/** What the composer remembers about an attachment it replaced with an annotated copy. */
export type ComposerImageAnnotationEntry = {
  /** The staged original, swapped back in on revert and re-annotated on edit. */
  original: PendingUploadedFile;
  document: AnnotationDocument;
  includeNote: boolean;
};

type Session = {
  file: PendingUploadedFile;
  imageSrc: string;
  document: AnnotationDocument | null;
  includeNote: boolean;
};

/** Stable composer comment id for an image's marker notes (keyed by the original). */
export function annotationNoteCommentId(original: Pick<PendingUploadedFile, "relativePath">) {
  return `annotation:${original.relativePath}`;
}

export function annotatedUploadFileName(originalName: string, mimeType: string) {
  const base = originalName.replace(/\.[^./\\]+$/u, "") || "image";
  return `${base}-annotated.${mimeType === "image/jpeg" ? "jpg" : "png"}`;
}

/**
 * Image annotation for pending composer attachments. Saving stages the
 * flattened image as a new upload and swaps it in place of the attachment;
 * the original stays staged so the chip can revert or re-open the editor
 * with the same shapes. Marker labels travel as a composer comment.
 */
export function useComposerImageAnnotation(params: {
  workdir: string;
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  imagePreviewLoader?: UploadedImagePreviewLoader;
  onReplacePendingUpload?: ReplacePendingUpload;
}) {
  const { workdir, composerRef, imagePreviewLoader, onReplacePendingUpload } = params;
  const [entries, setEntries] = useState<Record<string, ComposerImageAnnotationEntry>>({});
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const [session, setSession] = useState<Session | null>(null);
  const enabled = Boolean(onReplacePendingUpload);

  const getEntry = useCallback(
    (relativePath: string): ComposerImageAnnotationEntry | undefined =>
      entriesRef.current[relativePath],
    [],
  );

  const startAnnotation = useCallback(
    async (file: PendingUploadedFile, currentImageSrc: string) => {
      const entry = entriesRef.current[file.relativePath];
      if (entry && imagePreviewLoader && workdir) {
        // Re-edit: reopen the original with the saved shapes.
        const originalSrc = await loadUploadedImagePreview({
          workspaceRoot: workdir,
          file: entry.original,
          loader: imagePreviewLoader,
        });
        if (originalSrc) {
          setSession({
            file,
            imageSrc: originalSrc,
            document: entry.document,
            includeNote: entry.includeNote,
          });
          return;
        }
      }
      setSession({ file, imageSrc: currentImageSrc, document: null, includeNote: true });
    },
    [imagePreviewLoader, workdir],
  );

  const syncNoteComment = useCallback(
    (original: PendingUploadedFile, fileName: string, note: string, include: boolean) => {
      const composer = composerRef.current;
      if (!composer) return;
      const id = annotationNoteCommentId(original);
      if (include && note.trim()) {
        composer.upsertComment({
          id,
          quote: "",
          comment: note,
          source: { kind: "image", path: fileName },
        });
      } else {
        composer.removeComment(id);
      }
    },
    [composerRef],
  );

  const saveAnnotation = useCallback(
    async (result: ImageAnnotationResult) => {
      const current = session;
      if (!current || !onReplacePendingUpload) throw new Error("annotation unavailable");
      const previous = entriesRef.current[current.file.relativePath];
      const original = previous?.original ?? current.file;
      const upload = new File(
        [result.blob],
        annotatedUploadFileName(original.fileName, result.mimeType),
        { type: result.mimeType },
      );
      const staged = await onReplacePendingUpload(current.file.relativePath, upload);
      if (!staged) throw new Error("annotated image was not staged");
      registerLocalUploadedImagePreviews({
        workspaceRoot: workdir,
        uploadedFiles: [staged],
        sourceFiles: [upload],
      });
      setEntries((currentEntries) => {
        const next = { ...currentEntries };
        delete next[current.file.relativePath];
        next[staged.relativePath] = {
          original,
          document: result.document,
          includeNote: result.includeNote,
        };
        return next;
      });
      syncNoteComment(original, staged.fileName, result.note, result.includeNote);
    },
    [onReplacePendingUpload, session, syncNoteComment, workdir],
  );

  const revertAnnotation = useCallback(
    async (file: PendingUploadedFile) => {
      const entry = entriesRef.current[file.relativePath];
      if (!entry || !onReplacePendingUpload) return;
      const restored = await onReplacePendingUpload(file.relativePath, entry.original);
      if (!restored) return;
      setEntries((currentEntries) => {
        const next = { ...currentEntries };
        delete next[file.relativePath];
        return next;
      });
      composerRef.current?.removeComment(annotationNoteCommentId(entry.original));
    },
    [composerRef, onReplacePendingUpload],
  );

  /** Call when an attachment is removed so its marker-note comment goes too. */
  const forgetAnnotation = useCallback(
    (relativePath: string) => {
      const entry = entriesRef.current[relativePath];
      if (!entry) return;
      composerRef.current?.removeComment(annotationNoteCommentId(entry.original));
      setEntries((currentEntries) => {
        const next = { ...currentEntries };
        delete next[relativePath];
        return next;
      });
    },
    [composerRef],
  );

  const dialog: ReactNode = session ? (
    <ImageAnnotationDialog
      open
      imageSrc={session.imageSrc}
      fileName={(getEntry(session.file.relativePath)?.original ?? session.file).fileName}
      initialDocument={session.document}
      initialIncludeNote={session.includeNote}
      onOpenChange={(open) => {
        if (!open) {
          setSession(null);
          composerRef.current?.focus();
        }
      }}
      onSave={saveAnnotation}
    />
  ) : null;

  return {
    enabled,
    isAnnotated: (relativePath: string) => Boolean(entries[relativePath]),
    startAnnotation,
    revertAnnotation,
    forgetAnnotation,
    dialog,
  };
}
