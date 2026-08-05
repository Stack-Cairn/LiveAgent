import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";

type TerminalReadTailResponse = {
  sessions: Array<{
    id: string;
    title: string;
    cwd: string;
    shell: string;
    running: boolean;
  }>;
  selectedSession?: {
    id: string;
    title: string;
    cwd: string;
    shell: string;
    running: boolean;
  } | null;
  output: string;
  truncated: boolean;
};

function asToolArgs(toolCall: ToolCall): Record<string, unknown> {
  const args = toolCall.arguments;
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function normalizeMaxBytes(input: unknown) {
  const value = typeof input === "number" ? Math.floor(input) : Number(input);
  if (!Number.isFinite(value) || value <= 0) return 32 * 1024;
  return Math.min(128 * 1024, Math.max(4 * 1024, value));
}

function formatTerminalReadResult(result: TerminalReadTailResponse) {
  if (!result.sessions.length) {
    return "No terminal sessions are open for the current project.";
  }
  const selected = result.selectedSession;
  const header = selected
    ? [
        `terminal_id: ${selected.id}`,
        `title: ${selected.title}`,
        `cwd: ${selected.cwd}`,
        `shell: ${selected.shell}`,
        `running: ${selected.running ? "true" : "false"}`,
        `truncated: ${result.truncated ? "true" : "false"}`,
      ].join("\n")
    : [
        "Multiple terminal sessions are available:",
        ...result.sessions.map(
          (session) =>
            `- ${session.id} · ${session.title} · ${session.running ? "running" : "exited"}`,
        ),
      ].join("\n");
  return `${header}\n\n${result.output || "(empty output)"}`;
}

export function createTerminalTools(params: { workdir: string }): BuiltinToolBundle {
  const projectPathKey = params.workdir.trim();
  const tools = [
    {
      name: "ReadTerminal",
      description:
        "Read recent output from a terminal session that belongs to the current project. This tool is read-only and cannot send input or control terminals.",
      parameters: Type.Object({
        terminal_id: Type.Optional(Type.String()),
        max_bytes: Type.Optional(Type.Number()),
      }),
    },
  ];

  async function executeToolCall(toolCall: ToolCall): Promise<ToolResultMessage> {
    const now = Date.now();
    if (!projectPathKey) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "No current project is selected." }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }
    const args = asToolArgs(toolCall);
    const terminalId =
      typeof args.terminal_id === "string" && args.terminal_id.trim()
        ? args.terminal_id.trim()
        : undefined;
    try {
      const result = await invoke<TerminalReadTailResponse>("terminal_read_tail", {
        project_path_key: projectPathKey,
        session_id: terminalId,
        max_bytes: normalizeMaxBytes(args.max_bytes),
      });
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: formatTerminalReadResult(result) }],
        details: result,
        isError: false,
        timestamp: now,
      };
    } catch (error) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }
  }

  return {
    groupId: "system",
    tools,
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        "ReadTerminal",
        {
          groupId: "system",
          kind: "system",
          isReadOnly: true,
          displayCategory: "system",
        },
      ],
    ]),
  };
}
