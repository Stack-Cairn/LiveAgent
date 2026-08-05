import { invoke } from "../../lib/tauriBridge";

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

export function openChatFileLink(params: OpenChatFileLinkParams) {
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
