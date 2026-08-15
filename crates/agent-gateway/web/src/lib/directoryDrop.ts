export type DroppedDirectoryFile = {
  /** 目录内相对路径（不含顶层文件夹名），正斜杠分隔。 */
  relativePath: string;
  file: File;
};

export type DroppedDirectory = {
  name: string;
  files: DroppedDirectoryFile[];
};

export type CollectedDropPayload = {
  files: File[];
  directories: DroppedDirectory[];
};

/** 与桌面端网关侧的 2000 上限对齐；超限直接失败而非静默截断。 */
export const MAX_DIRECTORY_UPLOAD_FILES = 2000;
export const MAX_DIRECTORY_UPLOAD_BYTES = 200 * 1024 * 1024;

/** 拖入整个项目时这些目录既大又无导入价值，收集阶段直接剪枝。 */
const EXCLUDED_DIRECTORY_NAMES = new Set([".git", "node_modules", "__pycache__"]);

const EXCLUDED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);

export function isExcludedDirectoryName(name: string) {
  return EXCLUDED_DIRECTORY_NAMES.has(name);
}

export function isExcludedFileName(name: string) {
  return EXCLUDED_FILE_NAMES.has(name);
}

/**
 * DataTransferItem 只在 drop 事件的同步阶段有效，必须先同步取出全部
 * entry 再做异步遍历。
 */
export function snapshotDroppedEntries(dataTransfer: DataTransfer): FileSystemEntry[] {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  return entries;
}

export function hasDirectoryEntry(entries: readonly FileSystemEntry[]) {
  return entries.some((entry) => entry.isDirectory);
}

function readAllDirectoryEntries(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  return new Promise((resolve, reject) => {
    const collected: FileSystemEntry[] = [];
    const readBatch = () => {
      // readEntries 每次最多返回 100 条，必须循环读到空批为止。
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(collected);
          return;
        }
        collected.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

async function collectDirectoryFiles(
  directory: FileSystemDirectoryEntry,
  prefix: string,
  sink: DroppedDirectoryFile[],
  totalBytes: { value: number },
) {
  const children = await readAllDirectoryEntries(directory);
  for (const child of children) {
    if (child.isDirectory) {
      if (isExcludedDirectoryName(child.name)) continue;
      await collectDirectoryFiles(
        child as FileSystemDirectoryEntry,
        `${prefix}${child.name}/`,
        sink,
        totalBytes,
      );
      continue;
    }
    if (!child.isFile || isExcludedFileName(child.name)) continue;
    if (sink.length >= MAX_DIRECTORY_UPLOAD_FILES) {
      throw new Error(`TOO_MANY_FILES:${MAX_DIRECTORY_UPLOAD_FILES}`);
    }
    const file = await entryFile(child as FileSystemFileEntry);
    totalBytes.value += file.size;
    if (totalBytes.value > MAX_DIRECTORY_UPLOAD_BYTES) {
      throw new Error(`TOO_LARGE:${MAX_DIRECTORY_UPLOAD_BYTES}`);
    }
    sink.push({
      relativePath: `${prefix}${child.name}`,
      file,
    });
  }
}

/**
 * 把 drop 快照展开成顶层文件与文件夹树。文件夹内文件数超过
 * MAX_DIRECTORY_UPLOAD_FILES 时抛出 `TOO_MANY_FILES:<max>` 错误。
 */
export async function collectDroppedPayload(
  entries: readonly FileSystemEntry[],
): Promise<CollectedDropPayload> {
  const files: File[] = [];
  const directories: DroppedDirectory[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      const collected: DroppedDirectoryFile[] = [];
      await collectDirectoryFiles(entry as FileSystemDirectoryEntry, "", collected, { value: 0 });
      directories.push({ name: entry.name, files: collected });
      continue;
    }
    if (entry.isFile && !isExcludedFileName(entry.name)) {
      files.push(await entryFile(entry as FileSystemFileEntry));
    }
  }
  return { files, directories };
}
