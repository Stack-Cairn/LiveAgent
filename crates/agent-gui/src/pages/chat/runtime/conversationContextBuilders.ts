import type { Context, UserMessage } from "@earendil-works/pi-ai";

import {
  buildRequestContext,
  type ConversationViewState,
} from "../../../lib/chat/conversation/conversationState";
import type { SkillMentionUpdateMap } from "../../../lib/chat/skills/mentionInjection";
import {
  attachMemoryTurnUpdates,
  type MemoryTurnUpdateMap,
} from "../../../lib/memory/prompts/turnInjection";
import { appendSystemPrompt } from "./chatPageRuntime";

export type ConversationContextBuildOptions = {
  includeAbortedMessages?: boolean;
  includeUploadedFilesMetadata?: boolean;
};

/**
 * 组成 system prompt 的各段原文。
 *
 * 轨迹按这些边界分段哈希去重：整文哈希在这里必然失效，因为 memory 段每轮重渲染，
 * 会让每一轮都产生一份新的全文快照。
 */
export type PreparedSystemPromptSlots = {
  base?: string;
  agent?: string;
  skills?: string;
  memory?: string;
  /** Dynamic run-only additions: roster, message bus, and authoritative task state. */
  runtime?: string;
};

/**
 * 收集最近一次上下文构建的分段原文。
 *
 * 用 holder 而不是返回值，是为了不改动 `buildPreparedContext` 的返回类型——它被
 * 多处以 `Context` 直接消费。
 *
 * @returns capture 供构建器回调，read 供埋点读取最近一次结果。
 */
export function createPreparedSystemPromptSlotHolder(): {
  capture: (slots: PreparedSystemPromptSlots) => void;
  read: () => PreparedSystemPromptSlots;
} {
  let latest: PreparedSystemPromptSlots = {};
  return {
    capture: (slots) => {
      latest = slots;
    },
    read: () => latest,
  };
}

export function buildCompactionContext(
  state: ConversationViewState,
  tools?: Context["tools"],
  options?: ConversationContextBuildOptions,
): Context {
  const baseContext = buildRequestContext(state, options);
  return Array.isArray(tools) && tools.length > 0
    ? {
        ...baseContext,
        tools,
      }
    : baseContext;
}

export function buildPreparedContext(params: {
  state: ConversationViewState;
  tools?: Context["tools"];
  activeAgentPrompt: string;
  skillsPrompt: string;
  memoryPrompt?: string;
  memoryTurnUpdates?: MemoryTurnUpdateMap | null;
  skillMentionUpdates?: SkillMentionUpdateMap | null;
  includeAbortedMessages?: boolean;
  includeUploadedFilesMetadata?: boolean;
  /** 轨迹埋点用的分段回调；不传时零开销。 */
  captureSlots?: (slots: PreparedSystemPromptSlots) => void;
}): Context {
  // AGENTS / Skills prompts are fixed runtime instructions and should not be
  // folded into compaction input or token accounting.
  const withTools = buildCompactionContext(params.state, params.tools, {
    includeAbortedMessages: params.includeAbortedMessages,
    includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
  });

  params.captureSlots?.({
    ...(typeof withTools.systemPrompt === "string" ? { base: withTools.systemPrompt } : {}),
    ...(params.activeAgentPrompt ? { agent: params.activeAgentPrompt } : {}),
    ...(params.skillsPrompt ? { skills: params.skillsPrompt } : {}),
    ...(params.memoryPrompt ? { memory: params.memoryPrompt } : {}),
  });

  let systemPrompt = withTools.systemPrompt;
  if (params.activeAgentPrompt) {
    systemPrompt = appendSystemPrompt(systemPrompt, params.activeAgentPrompt);
  }
  if (params.skillsPrompt) {
    systemPrompt = appendSystemPrompt(systemPrompt, params.skillsPrompt);
  }
  if (params.memoryPrompt) {
    systemPrompt = appendSystemPrompt(systemPrompt, params.memoryPrompt);
  }

  // memory 的动态部分挂在对应 user 消息尾部,而不是继续往 system 段里塞:
  // system 段一变,整条缓存前缀连同全部历史一起作废。
  // skills 的「显式提及」同理:它只对当轮有效,留在 system 段等于一次输入连废
  // 两次前缀。两者都走同一个挂载口径,顺序固定(memory 在前、skills 在后),
  // 已挂上的块在后续轮次原样重放,历史区间的字节才保持稳定。
  const withMemory = attachMemoryTurnUpdates(withTools.messages, params.memoryTurnUpdates);
  const messages = attachMemoryTurnUpdates(withMemory, params.skillMentionUpdates);
  const withMessages = messages === withTools.messages ? withTools : { ...withTools, messages };

  return typeof systemPrompt === "string"
    ? {
        ...withMessages,
        systemPrompt,
      }
    : withMessages;
}

export function buildResumeContext(params: {
  state: ConversationViewState;
  resumeMessage?: UserMessage;
  tools?: Context["tools"];
  activeAgentPrompt: string;
  skillsPrompt: string;
  memoryPrompt?: string;
  memoryTurnUpdates?: MemoryTurnUpdateMap | null;
  skillMentionUpdates?: SkillMentionUpdateMap | null;
  includeAbortedMessages?: boolean;
  includeUploadedFilesMetadata?: boolean;
  captureSlots?: (slots: PreparedSystemPromptSlots) => void;
}): Context {
  const baseContext = buildPreparedContext({
    ...params,
    includeAbortedMessages: params.includeAbortedMessages,
  });
  if (!params.resumeMessage) {
    return baseContext;
  }
  return {
    ...baseContext,
    messages: [...baseContext.messages, params.resumeMessage],
  };
}
