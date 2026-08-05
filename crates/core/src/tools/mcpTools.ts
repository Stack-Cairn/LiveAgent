import type {
  ImageContent,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { callBackend } from "../backendClient";

import type { McpServerConfig } from "../settings";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";
import {
  createToolRunId,
  invokeWithAbort,
  requestRuntimeCancel,
  waitForAbortablePromise,
} from "./invokeWithAbort";
import { normalizeToolParametersSchema } from "./toolSchema";

type McpToolInfo = {
  serverId: string;
  serverLabel: string;
  name: string;
  description: string;
  inputSchema: unknown;
};

type McpCallToolResponse = {
  content: (TextContent | ImageContent)[];
  isError: boolean;
  details: unknown;
};

const mcpServerCallLocks = new Map<string, Promise<void>>();

async function withMcpServerCallLock<T>(
  serverId: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const previous = mcpServerCallLocks.get(serverId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  mcpServerCallLocks.set(serverId, tail);

  // The abortable wait can throw, so it must live inside the same
  // release/cleanup scope as run(): a waiter aborted while queued would
  // otherwise leave `current` unresolved and deadlock every later call to
  // this server. Releasing early is safe — `tail` still chains behind
  // `previous`, so serialization is preserved for the next caller.
  try {
    await waitForAbortablePromise(
      previous.catch(() => undefined),
      signal,
    );
    return await run();
  } finally {
    release();
    if (mcpServerCallLocks.get(serverId) === tail) {
      mcpServerCallLocks.delete(serverId);
    }
  }
}

function sanitizeToolPart(input: string) {
  return input
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function hash8(input: string) {
  // Small, stable, non-crypto hash (FNV-1a 32-bit).
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // unsigned -> 8 hex chars
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

function buildSafeToolName(serverId: string, toolName: string) {
  const sid = sanitizeToolPart(serverId) || "server";
  const tn = sanitizeToolPart(toolName) || "tool";
  const base = `mcp_${sid}_${tn}`;
  if (base.length <= 64) return base;
  const suffix = hash8(`${serverId}::${toolName}`);
  return `mcp_${sid.slice(0, 16)}_${tn.slice(0, 24)}_${suffix}`.slice(0, 64);
}

export async function createMcpTools(params: {
  servers: McpServerConfig[];
  onLoadError?: (message: string) => void;
  loadFailureMode?: "continue" | "throw";
}): Promise<
  BuiltinToolBundle<{
    /** Maps the safe tool name (used by LLM) to the underlying MCP server/tool. */
    toolNameMap: Map<string, { serverId: string; toolName: string; serverLabel: string }>;
  }>
> {
  const servers = params.servers ?? [];
  const enabledServers = servers.filter((s) => s.enabled);

  const invalid: Array<{ label: string; reason: string }> = [];
  for (const s of enabledServers) {
    const label = s.id?.trim() || "(Unnamed Server)";
    const id = s.id?.trim() || "";
    const transport = s.transport || "stdio";

    if (!id) {
      invalid.push({ label, reason: "Missing server name" });
      continue;
    }

    if (transport === "stdio") {
      if (!s.command?.trim()) {
        invalid.push({ label, reason: "transport=stdio requires command" });
      }
      continue;
    }

    if (transport === "http") {
      if (!s.url?.trim()) {
        invalid.push({ label, reason: "transport=http requires url" });
      }
      continue;
    }

    if (transport === "sse") {
      if (!s.url?.trim()) {
        invalid.push({ label, reason: "transport=sse requires url (SSE endpoint)" });
      }
      continue;
    }

    invalid.push({ label, reason: `Unknown transport: ${String(transport)}` });
  }

  if (invalid.length > 0) {
    const lines = invalid.map((it) => `- ${it.label}: ${it.reason}`).join("\n");
    throw new Error(
      `The following MCP server configurations are incomplete:\n${lines}\n\nPlease complete them in Settings -> MCP.`,
    );
  }

  if (enabledServers.length === 0) {
    return {
      groupId: "mcp",
      tools: [],
      metadataByName: new Map(),
      toolNameMap: new Map(),
      executeToolCall: async (toolCall) => ({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "No MCP servers are configured or enabled." }],
        details: {},
        isError: true,
        timestamp: Date.now(),
      }),
    };
  }

  // Ask Rust side to (re)sync servers and list tools.
  let toolInfos: McpToolInfo[] = [];
  try {
    toolInfos = await callBackend<McpToolInfo[]>("mcp_list_tools", {
      servers: enabledServers,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (params.loadFailureMode === "throw") {
      throw new Error(message || "MCP tools 加载失败");
    }
    params.onLoadError?.(message || "MCP tools 加载失败");
    console.warn("[MCP] tools list failed, continuing without MCP tools", err);
  }

  const toolNameMap = new Map<
    string,
    { serverId: string; toolName: string; serverLabel: string }
  >();
  const tools: Tool[] = [];
  const metadataEntries: Array<
    [
      string,
      {
        groupId: "mcp";
        kind: string;
        isReadOnly: boolean;
        displayCategory: "mcp";
        serverId: string;
      },
    ]
  > = [];

  for (const info of toolInfos ?? []) {
    const safeName = buildSafeToolName(info.serverId, info.name);
    const descriptionPrefix = info.serverLabel ? `[MCP:${info.serverLabel}] ` : "[MCP] ";
    tools.push({
      name: safeName,
      description: `${descriptionPrefix}${info.description || info.name}`,
      // MCP 的 inputSchema 是运行时由 server 提供、未经校验的 JSON Schema;过界前
      // 做结构守卫,畸形值回退为 {type:"object"},避免直接送 provider 引发报错。
      parameters: normalizeToolParametersSchema(info.inputSchema, `MCP ${safeName}`),
    });
    toolNameMap.set(safeName, {
      serverId: info.serverId,
      toolName: info.name,
      serverLabel: info.serverLabel,
    });
    metadataEntries.push([
      safeName,
      {
        groupId: "mcp",
        kind: "mcp",
        isReadOnly: false,
        displayCategory: "mcp",
        serverId: info.serverId,
      },
    ]);
  }

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const now = Date.now();
    if (signal?.aborted) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "Cancelled" }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    const mapped = toolNameMap.get(toolCall.name);
    if (!mapped) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Unknown MCP tool: ${toolCall.name}` }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    try {
      return await withMcpServerCallLock(
        mapped.serverId,
        async () => {
          if (signal?.aborted) {
            return {
              role: "toolResult",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              content: [{ type: "text", text: "Cancelled" }],
              details: {},
              isError: true,
              timestamp: Date.now(),
            };
          }

          const runId = createToolRunId("mcp", toolCall.id);
          const res = await invokeWithAbort<McpCallToolResponse>(
            "mcp_call_tool",
            {
              server_id: mapped.serverId,
              tool_name: mapped.toolName,
              arguments: toolCall.arguments ?? {},
              run_id: runId,
            },
            signal,
            { onAbort: () => requestRuntimeCancel(runId) },
          );

          return {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: (res?.content ?? [{ type: "text", text: "" }]) as any,
            details: {
              serverId: mapped.serverId,
              serverLabel: mapped.serverLabel,
              tool: mapped.toolName,
              mcp: res?.details,
            },
            isError: Boolean(res?.isError),
            timestamp: Date.now(),
          };
        },
        signal,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: msg || "MCP call failed" }],
        details: { serverId: mapped.serverId, tool: mapped.toolName },
        isError: true,
        timestamp: now,
      };
    }
  }

  return {
    groupId: "mcp",
    tools,
    executeToolCall,
    toolNameMap,
    metadataByName: createBuiltinMetadataMap(metadataEntries),
  };
}
