import { invoke } from "@tauri-apps/api/core";

export type FsErrorCode =
  | "invalid_workdir"
  | "invalid_path"
  | "out_of_bounds"
  | "not_found"
  | "not_a_directory"
  | "not_a_file"
  | "unsupported_target"
  | "requires_full_read"
  | "stale_file"
  | "edit_no_match"
  | "edit_ambiguous"
  | "edit_count_mismatch"
  | "too_large"
  | "not_utf8"
  | "regex_invalid"
  | "glob_invalid"
  | "io"
  | "other";

export class FsBackendError extends Error {
  readonly code: FsErrorCode;
  readonly path?: string;
  readonly workdir?: string;
  readonly entryKind?: string;
  readonly didYouMean: string[];

  constructor(params: {
    code: FsErrorCode;
    message: string;
    path?: string;
    workdir?: string;
    entryKind?: string;
    didYouMean?: string[];
  }) {
    super(params.message);
    this.name = "FsBackendError";
    this.code = params.code;
    this.path = params.path;
    this.workdir = params.workdir;
    this.entryKind = params.entryKind;
    this.didYouMean = params.didYouMean ?? [];
  }
}

export function isFsBackendError(error: unknown): error is FsBackendError {
  return error instanceof FsBackendError;
}

function toFsBackendError(error: unknown): FsBackendError {
  if (error instanceof FsBackendError) return error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.message === "string") {
      return new FsBackendError({
        code: record.code as FsErrorCode,
        message: record.message,
        path: typeof record.path === "string" ? record.path : undefined,
        workdir: typeof record.workdir === "string" ? record.workdir : undefined,
        entryKind: typeof record.entryKind === "string" ? record.entryKind : undefined,
        didYouMean: Array.isArray(record.didYouMean)
          ? record.didYouMean.filter((value): value is string => typeof value === "string")
          : undefined,
      });
    }
  }
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error ?? "Unknown filesystem error");
  return new FsBackendError({ code: "other", message });
}

export async function invokeFs<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toFsBackendError(error);
  }
}
