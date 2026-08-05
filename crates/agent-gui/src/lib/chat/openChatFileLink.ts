import { invoke } from "@tauri-apps/api/core";

import { hasSystemFileOpener } from "../shell/capabilities";
import type { ChatFileLink } from "./chatFileLinks";

export type OpenChatFileLinkParams = ChatFileLink & {
  conversationId: string;
  workdir: string;
  openInFileManager?: boolean;
};

export type OpenChatFileLinkResult = {
  action: "directory" | "editor" | "opened" | "preview" | "revealed";
  kind: "directory" | "file";
  workdir?: string;
  path?: string;
  line?: number;
  endLine?: number;
  column?: number;
  outsideWorkspace: boolean;
};

/**
 * 聊天消息里的文件链接。
 *
 * `open_chat_file_link` 是壳专属命令：它在**这台机器**上解析路径，必要时直接
 * 交给系统程序打开。浏览器里没有这个能力，调用方（ChatPage）catch 后把下面
 * 这句话直接弹给用户，而不是让通用的分流错误冒出来。
 */
export function openChatFileLink(params: OpenChatFileLinkParams) {
  if (!hasSystemFileOpener()) {
    return Promise.reject(new Error("浏览器里无法打开消息中的文件链接（需要桌面壳）"));
  }
  return invoke<OpenChatFileLinkResult>("open_chat_file_link", {
    conversation_id: params.conversationId,
    workdir: params.workdir,
    path: params.path,
    source: params.source,
    line: params.line,
    end_line: params.endLine,
    column: params.column,
    open_in_file_manager: params.openInFileManager,
  });
}
