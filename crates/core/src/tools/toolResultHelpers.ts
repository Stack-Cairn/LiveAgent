import type { ImageContent, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { callBackend } from "../backendClient";
import { ToolPathResolver } from "./pathUtils";
import type { SkillAccessPolicy } from "./skillAccessPolicy";

export type ToolResultContent = (TextContent | ImageContent)[];

/**
 * 唯一的 ToolResultMessage 信封构造点。字段顺序与取值必须保持不变:前端渲染与
 * Rust 侧历史落盘都按这个形状读,任何字段增删都会波及两端。
 */
export function buildToolResultMessage(params: {
  toolCall: ToolCall;
  content: ToolResultContent;
  details?: unknown;
  isError: boolean;
  timestamp: number;
}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: params.toolCall.id,
    toolName: params.toolCall.name,
    content: params.content,
    details: params.details ?? {},
    isError: params.isError,
    timestamp: params.timestamp,
  };
}

export function buildToolTextResult(params: {
  toolCall: ToolCall;
  text: string;
  details?: unknown;
  isError: boolean;
  timestamp: number;
}): ToolResultMessage {
  return buildToolResultMessage({
    toolCall: params.toolCall,
    content: [{ type: "text", text: params.text }],
    details: params.details,
    isError: params.isError,
    timestamp: params.timestamp,
  });
}

/** 错误信封:文案由调用方给出,details 默认空对象。 */
export function buildToolErrorResult(
  toolCall: ToolCall,
  text: string,
  timestamp: number,
  details?: unknown,
): ToolResultMessage {
  return buildToolTextResult({ toolCall, text, details, isError: true, timestamp });
}

/** 取消守卫的统一返回值——文案 "Cancelled" 被前端按原样展示。 */
export function buildCancelledToolResult(
  toolCall: ToolCall,
  timestamp: number,
): ToolResultMessage {
  return buildToolErrorResult(toolCall, "Cancelled", timestamp);
}

/** 未知工具守卫。label 用于区分 "Unknown tool" 与 "Unknown MCP tool"。 */
export function buildUnknownToolResult(
  toolCall: ToolCall,
  timestamp: number,
  label = "Unknown tool",
): ToolResultMessage {
  return buildToolErrorResult(toolCall, `${label}: ${toolCall.name}`, timestamp);
}

export function asErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export function strictToolParameters(properties: Record<string, unknown>) {
  return Type.Object(properties as any, { additionalProperties: false });
}

/**
 * 未知参数名守卫。schema 的 additionalProperties:false 与 pi-agent-core 循环里的
 * validateToolArguments 已覆盖同一约束,但二者抛出的文案不同,且 memory 抽取等
 * 路径直接调用 bundle.executeToolCall 而不经过 agent 循环——故这一层保留。
 */
export function assertKnownArguments(toolName: string, args: unknown, allowed: readonly string[]) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${toolName} received unsupported argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
}

type SystemListSkillFilesResponse = {
  rootDir?: string | null;
};

/**
 * Skills 根目录解析 + ToolPathResolver 构造。fsTools/shellTools 各自持有一份
 * cachedSkillsRootDir 闭包,行为逐字相同,这里合并为一处。
 */
export function createSkillsAwarePathResolver(params: {
  workdir: string;
  resolveHomeDir?: () => Promise<string>;
  skillsRootEnabled: boolean;
  skillsRootDir?: string;
  skillAccessPolicy?: SkillAccessPolicy;
}) {
  const allowSkillsRoot = params.skillsRootEnabled;
  let cachedSkillsRootDir =
    typeof params.skillsRootDir === "string" ? params.skillsRootDir.trim() : "";

  async function resolveSkillsRootDir() {
    if (!allowSkillsRoot) {
      throw new Error("Skill paths are only available when Skills are enabled");
    }
    if (cachedSkillsRootDir) return cachedSkillsRootDir;
    const response = await callBackend<SystemListSkillFilesResponse>("system_list_skill_files", {});
    const rootDir = typeof response.rootDir === "string" ? response.rootDir.trim() : "";
    if (!rootDir) {
      throw new Error("Skills root is unavailable; refresh Skills discovery and retry.");
    }
    cachedSkillsRootDir = rootDir;
    return cachedSkillsRootDir;
  }

  const pathResolver = new ToolPathResolver({
    workdir: params.workdir,
    resolveHomeDir: params.resolveHomeDir,
    skillsRootEnabled: allowSkillsRoot,
    skillsRootDir: cachedSkillsRootDir,
    skillAccessPolicy: params.skillAccessPolicy,
    resolveSkillsRootDir,
  });

  return {
    pathResolver,
    resolveSkillsRootDir,
    /** 已解析到的 Skills 根;未解析时为空串(调用方按需触发 resolveSkillsRootDir)。 */
    getCachedSkillsRootDir: () => cachedSkillsRootDir,
  };
}
