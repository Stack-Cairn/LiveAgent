import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateTextTokenUnits } from "@liveagent/ui/lib/chat/contextUsage";
import type {
  AppliedPluginPromptContext,
  AppliedPluginPromptSection,
} from "@liveagent/ui/lib/plugins/provenance";
import type {
  PluginHookEvent,
  PluginInvocationResult,
  PluginTurnSnapshot,
} from "@liveagent/ui/lib/plugins/types";
import { invoke } from "@tauri-apps/api/core";
import type { BuiltinToolBundle } from "./builtinTypes";
import { createBuiltinMetadataMap } from "./builtinTypes";
import { invokeWithAbort } from "./invokeWithAbort";
import { normalizeToolParametersSchema } from "./toolSchema";

const DEFAULT_PLUGIN_PROMPT_TOKEN_UNITS = 2_000;
const MAX_PLUGIN_PROMPT_TOKEN_UNITS = 16_000;

export async function preparePluginTurn(workspace: string): Promise<PluginTurnSnapshot> {
  return invoke<PluginTurnSnapshot>("plugin_prepare_turn", { workspace });
}

export function createPluginToolBundles(
  workspace: string,
  snapshot: PluginTurnSnapshot,
): BuiltinToolBundle[] {
  const byPlugin = new Map<string, PluginTurnSnapshot["tools"]>();
  for (const tool of snapshot.tools) {
    const current = byPlugin.get(tool.pluginId) ?? [];
    current.push(tool);
    byPlugin.set(tool.pluginId, current);
  }

  return [...byPlugin.entries()].map(([pluginId, contributions]) => {
    const tools = contributions.map((item) => ({
      name: item.contribution.modelName,
      description: `[Plugin:${pluginId}] ${item.contribution.description}`,
      parameters: normalizeToolParametersSchema(
        item.contribution.inputSchema,
        `Plugin ${pluginId}/${item.contribution.id}`,
      ),
    }));
    const byModelName = new Map(
      contributions.map((item) => [item.contribution.modelName, item] as const),
    );
    const metadataByName = createBuiltinMetadataMap(
      contributions.map((item) => [
        item.contribution.modelName,
        {
          groupId: `plugin:${pluginId}` as const,
          kind: "plugin",
          isReadOnly: item.contribution.readOnly,
          displayCategory: "other" as const,
          pluginId,
        },
      ]),
    );

    const executeToolCall = async (
      toolCall: ToolCall,
      signal?: AbortSignal,
    ): Promise<ToolResultMessage> => {
      const contribution = byModelName.get(toolCall.name);
      if (!contribution) {
        return pluginErrorResult(toolCall, `Unknown plugin tool: ${toolCall.name}`);
      }
      try {
        const result = await invokeWithAbort<PluginInvocationResult>(
          "plugin_invoke_tool",
          {
            workspace,
            pluginId,
            modelName: toolCall.name,
            generation: contribution.generation,
            arguments: toolCall.arguments ?? {},
          },
          signal,
        );
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: result.content,
          details: {
            pluginId,
            pluginVersion: contribution.pluginVersion,
            packageHash: contribution.packageHash,
            generation: contribution.generation,
            contributionId: contribution.contribution.id,
            plugin: result.details,
          },
          isError: result.isError,
          timestamp: Date.now(),
        };
      } catch (error) {
        return pluginErrorResult(
          toolCall,
          error instanceof Error ? error.message : String(error),
          pluginId,
        );
      }
    };

    return {
      groupId: `plugin:${pluginId}` as const,
      tools,
      executeToolCall,
      metadataByName,
    };
  });
}

export function buildPluginPromptWithProvenance(snapshot: PluginTurnSnapshot): {
  prompt: string;
  pluginContext?: AppliedPluginPromptContext;
} {
  if (snapshot.promptSections.length === 0) return { prompt: "" };
  const sections: string[] = [];
  const appliedSections: AppliedPluginPromptSection[] = [];
  let remaining = MAX_PLUGIN_PROMPT_TOKEN_UNITS;
  for (const section of snapshot.promptSections) {
    const opening = `<liveagent-plugin-context plugin="${escapeAttribute(section.pluginId)}" version="${escapeAttribute(section.pluginVersion)}" contribution="${escapeAttribute(section.id)}">\n`;
    const closing = "\n</liveagent-plugin-context>";
    const separator = sections.length === 0 ? "" : "\n\n";
    const overhead = Math.ceil(estimateTextTokenUnits(`${separator}${opening}${closing}`));
    const budget = Math.min(
      section.maxTokens ?? DEFAULT_PLUGIN_PROMPT_TOKEN_UNITS,
      remaining - overhead,
    );
    if (budget <= 0) break;
    const content = limitPromptContent(section.content, budget);
    if (!content) break;
    remaining -= overhead + Math.ceil(estimateTextTokenUnits(content));
    sections.push(`${opening}${content}${closing}`);
    appliedSections.push({
      pluginId: section.pluginId,
      pluginVersion: section.pluginVersion,
      packageHash: section.packageHash,
      generation: section.generation,
      contributionId: section.id,
      truncated: content !== section.content.trim(),
    });
  }
  const prompt = sections.join("\n\n");
  return appliedSections.length > 0
    ? {
        prompt,
        pluginContext: {
          snapshotRevision: snapshot.revision,
          promptSections: appliedSections,
        },
      }
    : { prompt };
}

export function buildPluginPrompt(snapshot: PluginTurnSnapshot): string {
  return buildPluginPromptWithProvenance(snapshot).prompt;
}

export function limitPromptContent(content: string, maxTokens?: number): string {
  const normalized = content.trim();
  if (!maxTokens || estimateTextTokenUnits(normalized) <= maxTokens) return normalized;
  const codePoints = Array.from(normalized);
  const marker = "…";
  if (estimateTextTokenUnits(marker) > maxTokens) return "";
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${codePoints.slice(0, middle).join("").trimEnd()}${marker}`;
    if (estimateTextTokenUnits(candidate) <= maxTokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${codePoints.slice(0, low).join("").trimEnd()}${marker}`;
}

export function dispatchPluginHook(
  snapshot: PluginTurnSnapshot,
  input: { event: PluginHookEvent; workspace: string; payload: unknown },
) {
  const hooks = snapshot.hooks.filter((hook) => hook.contribution.event === input.event);
  if (hooks.length === 0) return Promise.resolve();
  return invoke("plugin_dispatch_hook", {
    request: {
      ...input,
      snapshotRevision: snapshot.revision,
      hooks,
    },
  });
}

function pluginErrorResult(
  toolCall: ToolCall,
  message: string,
  pluginId?: string,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: message || "Plugin call failed" }],
    details: pluginId ? { pluginId } : {},
    isError: true,
    timestamp: Date.now(),
  };
}

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
