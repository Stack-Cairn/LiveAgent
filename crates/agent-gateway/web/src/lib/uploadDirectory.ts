import type { DroppedDirectoryFile } from "./directoryDrop";
import { readFetchError } from "./uploadReadableFiles";

export type ImportDirectoryTarget = "workspace" | "project-root";

export type ImportDirectoryResult = {
  /** Agent 宿主机上创建的目录绝对路径。 */
  rootPath: string;
  fileCount: number;
  skipped: string[];
};

/**
 * 把浏览器收集到的文件夹内容上传到 Agent 宿主机（经网关
 * /api/files/import-directory 转发落盘）。multipart 的 filename 会被服务端
 * 削成末段，相对路径经与 files 按序对齐的 paths 字段传递。
 */
export async function importDirectory(
  token: string,
  agentId: string,
  params: {
    name: string;
    target: ImportDirectoryTarget;
    files: readonly DroppedDirectoryFile[];
  },
): Promise<ImportDirectoryResult> {
  const normalizedToken = token.trim();
  const normalizedAgentId = agentId.trim();
  const normalizedName = params.name.trim();
  if (!normalizedToken) {
    throw new Error("Gateway token is required");
  }
  if (!normalizedAgentId) {
    throw new Error("agent_id is required");
  }
  if (!normalizedName) {
    throw new Error("文件夹名称不能为空。");
  }
  if (params.files.length === 0) {
    throw new Error("文件夹为空，无法导入。");
  }

  const formData = new FormData();
  formData.set("name", normalizedName);
  formData.set("target", params.target);
  for (const entry of params.files) {
    formData.append("files", entry.file, entry.file.name);
    formData.append("paths", entry.relativePath);
  }

  const url = new URL(`${window.location.origin}/api/files/import-directory`);
  url.searchParams.set("agent_id", normalizedAgentId);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await readFetchError(response, "导入文件夹失败"));
  }

  const payload = (await response.json()) as {
    rootPath?: unknown;
    fileCount?: unknown;
    skipped?: unknown[];
  };
  const rootPath = typeof payload.rootPath === "string" ? payload.rootPath.trim() : "";
  if (!rootPath) {
    throw new Error("导入文件夹失败：服务端未返回目录路径");
  }

  return {
    rootPath,
    fileCount: typeof payload.fileCount === "number" ? payload.fileCount : 0,
    skipped: Array.isArray(payload.skipped)
      ? payload.skipped.filter((item): item is string => typeof item === "string")
      : [],
  };
}
