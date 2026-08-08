export type UploadedReadableFileKind =
  | "text"
  | "image"
  | "pdf"
  | "notebook"
  | "word"
  | "spreadsheet"
  | "archive";

export type PendingUploadedFile = {
  relativePath: string;
  absolutePath?: string;
  fileName: string;
  kind: UploadedReadableFileKind;
  sizeBytes: number;
  displayMode?: "largePaste";
  displayLabel?: string;
  displayCharCount?: number;
  displayLineCount?: number;
};
