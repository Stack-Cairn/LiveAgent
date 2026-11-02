import { invoke as tauriInvoke, isTauri as tauriIsTauri } from "@tauri-apps/api/core";
import {
  isKBrainBackendEnabled,
  isKBrainBrowserHost,
  isTauriHost,
  kBrainOwnedDesktopCommand,
} from "../lib/host";
import { createKBrainClient } from "../lib/kbrain/client";
import { ensureKBrainConversationId, setKBrainSessionId } from "../lib/kbrain/mapping";
import { isKBrainMemoryCommand } from "../lib/kbrain/memory";
import { getConfiguredKBrainConnection } from "../lib/kbrain/runtimeConnection";

type KBrainHistorySearchResponse = { matches?: Array<{ conversationId?: string }> };

// K-brain 搜索结果里的 conversationId 是后端 session id；会话列表和打开会话
// 都按本地 id 走映射表，这里换成本地 id 并补上映射，否则点击结果会报
// "K-brain session mapping not found"。
async function searchKBrainHistory(args: Record<string, unknown>) {
  const response = await createKBrainClient().searchHistory<KBrainHistorySearchResponse>(args);
  const baseUrl = getConfiguredKBrainConnection()?.baseUrl;
  for (const match of response.matches ?? []) {
    const backendId = match.conversationId?.trim();
    if (!backendId) continue;
    const localId = ensureKBrainConversationId(backendId, baseUrl);
    setKBrainSessionId(localId, backendId, baseUrl);
    match.conversationId = localId;
  }
  return response;
}

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isKBrainBackendEnabled() && isKBrainMemoryCommand(command)) {
    return createKBrainClient().requestMemory<T>(
      command,
      (args?.args as Record<string, unknown>) ?? args ?? {},
    );
  }
  if (isKBrainBackendEnabled() && command === "chat_history_search") {
    return searchKBrainHistory((args?.args as Record<string, unknown>) ?? args ?? {}) as Promise<T>;
  }
  const nativeGatewayCommand = !isKBrainBrowserHost() && command.startsWith("gateway_");
  if (isKBrainBackendEnabled() && !nativeGatewayCommand && kBrainOwnedDesktopCommand(command)) {
    return Promise.reject(
      new Error(
        `Desktop runtime command ${command} is unavailable in K-brain mode; use the K-brain backend capability.`,
      ),
    );
  }
  if (isKBrainBrowserHost()) {
    return Promise.reject(
      new Error(`Tauri command ${command} is unavailable in K-brain browser mode`),
    );
  }
  return tauriInvoke<T>(command, args);
}

export function isTauri(): boolean {
  if (isKBrainBrowserHost()) return false;
  return isTauriHost() || (typeof tauriIsTauri === "function" && tauriIsTauri());
}
