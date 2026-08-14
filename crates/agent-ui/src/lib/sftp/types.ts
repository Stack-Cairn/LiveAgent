export type SftpSide = "local" | "remote";
export type SftpTransferDirection = "upload" | "download";

export type SftpEntry = {
  path: string;
  name: string;
  kind: "file" | "directory" | "symlink" | string;
  sizeBytes: number;
  mtime: number;
};

export type SftpListResponse = {
  path: string;
  entries: SftpEntry[];
};

export type SftpStatResponse = {
  exists: boolean;
  entry?: SftpEntry | null;
};

export type SftpTransfer = {
  id: string;
  sessionId: string;
  direction: SftpTransferDirection | string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | string;
  sourcePath: string;
  targetPath: string;
  currentPath: string;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  error?: string | null;
};

export type SftpTransferResponse = {
  transfer: SftpTransfer;
};

export type SftpTransferEvent = {
  kind: string;
  transfer: SftpTransfer;
};

export type SftpActionResponse = {
  action?: string;
  path?: string;
  entry?: SftpEntry | null;
  transfer?: SftpTransfer | null;
};

export type SftpReadTextResponse = {
  path: string;
  content: string;
  offset: number;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
  entry?: SftpEntry | null;
};

export type SftpClient = {
  list(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: SftpSide;
    path?: string;
  }): Promise<SftpListResponse>;
  stat(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: SftpSide;
    path?: string;
  }): Promise<SftpStatResponse>;
  mkdir(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: SftpSide;
    path: string;
  }): Promise<SftpActionResponse>;
  rename(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: SftpSide;
    fromPath: string;
    toPath: string;
  }): Promise<SftpActionResponse>;
  delete(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: SftpSide;
    path: string;
    recursive?: boolean;
  }): Promise<SftpActionResponse>;
  transfer(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    direction: SftpTransferDirection;
    sourcePath: string;
    targetPath: string;
    recursive?: boolean;
    overwrite?: boolean;
  }): Promise<SftpTransferResponse>;
  cancelTransfer(params: { sessionId: string; transferId: string }): Promise<void>;
  subscribeTransfers(listener: (event: SftpTransferEvent) => void): () => void;
  // Remote-side text IO for the code editor; no `side` because the local pane
  // opens files through the workspace fs backend instead.
  readText(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    path: string;
    maxBytes?: number;
    strictUtf8?: boolean;
  }): Promise<SftpReadTextResponse>;
  // Resolves with action "conflict" (entry = current remote state, null when
  // deleted) when expected mtime/size no longer match; conflicts are a
  // structured response rather than an error because the gateway websocket
  // path flattens errors to strings.
  writeText(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    path: string;
    content: string;
    expectedMtime?: number;
    expectedSizeBytes?: number;
  }): Promise<SftpActionResponse>;
};
