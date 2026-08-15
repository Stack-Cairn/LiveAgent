import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { PluginInventoryItem } from "@liveagent/ui/lib/plugins/types";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";

const PLUGIN_CREATE_PARAMETERS = Type.Object({
  slug: Type.String({
    minLength: 1,
    maxLength: 48,
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    description:
      "Stable lowercase slug for com.liveagent.conversation.<slug>, using digits and single hyphens only.",
  }),
  name: Type.String({
    minLength: 1,
    maxLength: 80,
    description: "Human-readable plugin name shown in Plugin Hub.",
  }),
  description: Type.Optional(
    Type.String({
      maxLength: 500,
      description: "Short explanation of the reusable behavior this plugin adds.",
    }),
  ),
  instructions: Type.String({
    minLength: 1,
    maxLength: 12_000,
    description:
      "Durable model instructions injected in future turns for this workspace. Do not include secrets, executable code, XML wrapper tags, or claims of unavailable capabilities.",
  }),
  max_tokens: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 4_000,
      description: "Maximum prompt token units reserved for these instructions; defaults to 1200.",
    }),
  ),
  replace: Type.Optional(
    Type.Boolean({
      description:
        "Replace and patch-bump an existing conversation plugin with the same slug. Use only when the user explicitly asks to update or replace it.",
    }),
  ),
});

type PluginCreateArguments = {
  slug: string;
  name: string;
  description?: string;
  instructions: string;
  max_tokens?: number;
  replace?: boolean;
};

function formatResult(item: PluginInventoryItem) {
  return [
    `Conversation plugin ${item.id} ${item.version} is installed and enabled for this workspace.`,
    `Lifecycle phase: ${item.phase}.`,
    "The current Agent run uses an immutable plugin snapshot, so the new instructions start with the next user message.",
    "The plugin can be reviewed, disabled, or uninstalled in Plugin Hub.",
  ].join("\n");
}

export function createPluginManagerTools(params: { workdir: string }): BuiltinToolBundle {
  const tool: Tool = {
    name: "PluginCreate",
    description:
      "Create or update a safe workspace-scoped LiveAgent conversation plugin when the user explicitly asks to save reusable behavior as a plugin. The plugin is declarative and prompt-only: it cannot execute code, access files or networks, read secrets, register tools, or add hooks. The host generates an integrity-verified package, grants only prompt contribution permission, installs it, and enables it for the current workspace. This mutating tool requires user approval, and the plugin becomes visible to the Agent on the next user message because the current run snapshot is immutable. Do not use this for temporary one-off instructions, Skills, MCP servers, WASI plugins, or process plugins.",
    parameters: PLUGIN_CREATE_PARAMETERS,
  };

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const timestamp = Date.now();
    if (toolCall.name !== "PluginCreate") {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
        details: {},
        isError: true,
        timestamp,
      };
    }
    if (signal?.aborted) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "PluginCreate cancelled before creation." }],
        details: { kind: "manage_plugin", action: "create_prompt", changed: false },
        isError: true,
        timestamp,
      };
    }
    const args = (toolCall.arguments ?? {}) as PluginCreateArguments;
    try {
      const item = await invoke<PluginInventoryItem>("plugin_create_prompt", {
        request: {
          workspace: params.workdir,
          slug: args.slug,
          name: args.name,
          description: args.description ?? "",
          instructions: args.instructions,
          maxTokens: args.max_tokens,
          replace: args.replace === true,
        },
      });
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: formatResult(item) }],
        details: {
          kind: "manage_plugin",
          action: args.replace === true ? "replace_prompt" : "create_prompt",
          pluginId: item.id,
          version: item.version,
          phase: item.phase,
          enabled: item.enabled,
          changed: true,
          nextTurnRequired: true,
        },
        isError: false,
        timestamp,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `PluginCreate failed: ${message}` }],
        details: {
          kind: "manage_plugin",
          action: "create_prompt",
          changed: false,
          errors: [message],
        },
        isError: true,
        timestamp,
      };
    }
  }

  return {
    groupId: "plugin-manager",
    tools: [tool],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        "PluginCreate",
        {
          groupId: "plugin-manager",
          kind: "manage_plugin",
          isReadOnly: false,
          displayCategory: "other",
        },
      ],
    ]),
  };
}
