import type {
  ReadImageResultDetails,
  ReadNotebookResultDetails,
  ReadPdfResultDetails,
  ReadTextResultDetails,
} from "./builtinTypes";

type SnapshotPathKey = {
  path: string;
  fileId?: string;
  absolutePath?: string;
};

type FileReadSnapshot =
  | (SnapshotPathKey & {
      kind: "text";
      mtimeMs: number;
      contentHash: string;
      startLine: number;
      numLines: number;
      totalLines: number;
      isPartialView: boolean;
    })
  | (SnapshotPathKey & {
      kind: "image";
      mtimeMs: number;
      contentHash: string;
    })
  | (SnapshotPathKey & {
      kind: "pdf";
      mtimeMs: number;
      contentHash: string;
      pageStart: number;
      numPages: number;
      totalPages: number;
    })
  | (SnapshotPathKey & {
      kind: "notebook";
      mtimeMs: number;
      contentHash: string;
      cellStart: number;
      numCells: number;
      totalCells: number;
    });

type FileSnapshotBucket = {
  latest?: FileReadSnapshot;
  latestFullText?: Extract<FileReadSnapshot, { kind: "text" }>;
  byRangeKey: Map<string, FileReadSnapshot>;
};

function buildBucketKey(path: SnapshotPathKey | string) {
  if (typeof path === "string") return path;
  return path.fileId || path.absolutePath || path.path;
}

function snapshotPathKey(details: SnapshotPathKey): SnapshotPathKey {
  return {
    path: details.path,
    fileId: details.fileId,
    absolutePath: details.absolutePath,
  };
}

function getBucket(
  buckets: Map<string, FileSnapshotBucket>,
  path: SnapshotPathKey | string,
): FileSnapshotBucket {
  const key = buildBucketKey(path);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      byRangeKey: new Map<string, FileReadSnapshot>(),
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

function buildTextRangeKey(snapshot: Extract<FileReadSnapshot, { kind: "text" }>) {
  return `text:${snapshot.startLine}:${snapshot.numLines}:${snapshot.totalLines}`;
}

function buildImageRangeKey() {
  return "image";
}

function buildPdfRangeKey(snapshot: Extract<FileReadSnapshot, { kind: "pdf" }>) {
  return `pdf:${snapshot.pageStart}:${snapshot.numPages}:${snapshot.totalPages}`;
}

function buildNotebookRangeKey(snapshot: Extract<FileReadSnapshot, { kind: "notebook" }>) {
  return `notebook:${snapshot.cellStart}:${snapshot.numCells}:${snapshot.totalCells}`;
}

export type FileToolState = ReturnType<typeof createFileToolState>;

export function createFileToolState() {
  const buckets = new Map<string, FileSnapshotBucket>();

  function recordTextRead(details: ReadTextResultDetails) {
    const snapshot: Extract<FileReadSnapshot, { kind: "text" }> = {
      ...snapshotPathKey(details),
      kind: "text",
      mtimeMs: details.mtimeMs,
      contentHash: details.contentHash,
      startLine: details.startLine,
      numLines: details.numLines,
      totalLines: details.totalLines,
      isPartialView: details.isPartialView,
    };
    const bucket = getBucket(buckets, details);
    bucket.latest = snapshot;
    bucket.byRangeKey.set(buildTextRangeKey(snapshot), snapshot);
    if (!snapshot.isPartialView) {
      bucket.latestFullText = snapshot;
    }
  }

  function recordImageRead(details: ReadImageResultDetails) {
    const snapshot: Extract<FileReadSnapshot, { kind: "image" }> = {
      ...snapshotPathKey(details),
      kind: "image",
      mtimeMs: details.mtimeMs,
      contentHash: details.contentHash,
    };
    const bucket = getBucket(buckets, details);
    bucket.latest = snapshot;
    bucket.byRangeKey.set(buildImageRangeKey(), snapshot);
  }

  function recordPdfRead(details: ReadPdfResultDetails) {
    const snapshot: Extract<FileReadSnapshot, { kind: "pdf" }> = {
      ...snapshotPathKey(details),
      kind: "pdf",
      mtimeMs: details.mtimeMs,
      contentHash: details.contentHash,
      pageStart: details.pageStart,
      numPages: details.numPages,
      totalPages: details.totalPages,
    };
    const bucket = getBucket(buckets, details);
    bucket.latest = snapshot;
    bucket.byRangeKey.set(buildPdfRangeKey(snapshot), snapshot);
  }

  function recordNotebookRead(details: ReadNotebookResultDetails) {
    const snapshot: Extract<FileReadSnapshot, { kind: "notebook" }> = {
      ...snapshotPathKey(details),
      kind: "notebook",
      mtimeMs: details.mtimeMs,
      contentHash: details.contentHash,
      cellStart: details.cellStart,
      numCells: details.numCells,
      totalCells: details.totalCells,
    };
    const bucket = getBucket(buckets, details);
    bucket.latest = snapshot;
    bucket.byRangeKey.set(buildNotebookRangeKey(snapshot), snapshot);
  }

  function recordTextMutation(
    params: SnapshotPathKey & {
      mtimeMs: number;
      contentHash: string;
      totalLines: number;
    },
  ) {
    const snapshot: Extract<FileReadSnapshot, { kind: "text" }> = {
      ...snapshotPathKey(params),
      kind: "text",
      mtimeMs: params.mtimeMs,
      contentHash: params.contentHash,
      startLine: 1,
      numLines: params.totalLines,
      totalLines: params.totalLines,
      isPartialView: false,
    };
    const bucket = getBucket(buckets, params);
    bucket.latest = snapshot;
    bucket.latestFullText = snapshot;
    bucket.byRangeKey.set(buildTextRangeKey(snapshot), snapshot);
  }

  function getLatest(path: SnapshotPathKey | string) {
    return buckets.get(buildBucketKey(path))?.latest;
  }

  function getLatestFullText(path: SnapshotPathKey | string) {
    return buckets.get(buildBucketKey(path))?.latestFullText;
  }

  function getExactTextRead(
    path: SnapshotPathKey | string,
    params: {
      startLine: number;
      numLines: number;
      totalLines: number;
    },
  ) {
    return buckets.get(buildBucketKey(path))?.byRangeKey.get(
      buildTextRangeKey({
        path: typeof path === "string" ? path : path.path,
        kind: "text",
        mtimeMs: 0,
        contentHash: "",
        startLine: params.startLine,
        numLines: params.numLines,
        totalLines: params.totalLines,
        isPartialView: params.startLine > 1 || params.numLines < params.totalLines,
      }),
    );
  }

  function getExactImageRead(path: SnapshotPathKey | string) {
    return buckets.get(buildBucketKey(path))?.byRangeKey.get(buildImageRangeKey());
  }

  function getExactPdfRead(
    path: SnapshotPathKey | string,
    params: {
      pageStart: number;
      numPages: number;
      totalPages: number;
    },
  ) {
    return buckets.get(buildBucketKey(path))?.byRangeKey.get(
      buildPdfRangeKey({
        path: typeof path === "string" ? path : path.path,
        kind: "pdf",
        mtimeMs: 0,
        contentHash: "",
        pageStart: params.pageStart,
        numPages: params.numPages,
        totalPages: params.totalPages,
      }),
    );
  }

  function getExactNotebookRead(
    path: SnapshotPathKey | string,
    params: {
      cellStart: number;
      numCells: number;
      totalCells: number;
    },
  ) {
    return buckets.get(buildBucketKey(path))?.byRangeKey.get(
      buildNotebookRangeKey({
        path: typeof path === "string" ? path : path.path,
        kind: "notebook",
        mtimeMs: 0,
        contentHash: "",
        cellStart: params.cellStart,
        numCells: params.numCells,
        totalCells: params.totalCells,
      }),
    );
  }

  function clear(path: SnapshotPathKey | string) {
    buckets.delete(buildBucketKey(path));
  }

  return {
    recordTextRead,
    recordImageRead,
    recordPdfRead,
    recordNotebookRead,
    recordTextMutation,
    getLatest,
    getLatestFullText,
    getExactTextRead,
    getExactImageRead,
    getExactPdfRead,
    getExactNotebookRead,
    clear,
  };
}
