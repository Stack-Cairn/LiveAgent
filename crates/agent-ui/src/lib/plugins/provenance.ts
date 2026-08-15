export const LIVEAGENT_PLUGIN_CONTEXT_FIELD = "liveAgentPluginContext";

export type AppliedPluginPromptSection = {
  pluginId: string;
  pluginVersion: string;
  packageHash: string;
  generation: number;
  contributionId: string;
  truncated: boolean;
};

export type AppliedPluginPromptContext = {
  snapshotRevision: string;
  promptSections: AppliedPluginPromptSection[];
};

export type AppliedPluginSummary = {
  pluginId: string;
  pluginVersion: string;
  packageHash: string;
  generation: number;
  contributionIds: string[];
  truncated: boolean;
};

function readString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : "";
}

function normalizePromptSection(value: unknown): AppliedPluginPromptSection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const pluginId = readString(record.pluginId, 256);
  const pluginVersion = readString(record.pluginVersion, 128);
  const packageHash = readString(record.packageHash, 128);
  const contributionId = readString(record.contributionId, 256);
  const generation = record.generation;
  if (
    !pluginId ||
    !pluginVersion ||
    !packageHash ||
    !contributionId ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation <= 0
  ) {
    return undefined;
  }
  return {
    pluginId,
    pluginVersion,
    packageHash,
    generation,
    contributionId,
    truncated: record.truncated === true,
  };
}

export function normalizeAppliedPluginPromptContext(
  value: unknown,
): AppliedPluginPromptContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const snapshotRevision = readString(record.snapshotRevision, 512);
  if (!snapshotRevision || !Array.isArray(record.promptSections)) return undefined;
  const promptSections = record.promptSections
    .slice(0, 64)
    .map(normalizePromptSection)
    .filter((section): section is AppliedPluginPromptSection => Boolean(section));
  return promptSections.length > 0 ? { snapshotRevision, promptSections } : undefined;
}

export function readAppliedPluginPromptContext(
  message: unknown,
): AppliedPluginPromptContext | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  return normalizeAppliedPluginPromptContext(
    (message as Record<string, unknown>)[LIVEAGENT_PLUGIN_CONTEXT_FIELD],
  );
}

export function writeAppliedPluginPromptContext(
  message: object,
  context: AppliedPluginPromptContext,
): void {
  const normalized = normalizeAppliedPluginPromptContext(context);
  if (!normalized) return;
  (message as Record<string, unknown>)[LIVEAGENT_PLUGIN_CONTEXT_FIELD] = normalized;
}

export function summarizeAppliedPromptPlugins(
  context: AppliedPluginPromptContext,
): AppliedPluginSummary[] {
  const summaries = new Map<string, AppliedPluginSummary>();
  for (const section of context.promptSections) {
    const key = [
      section.pluginId,
      section.pluginVersion,
      section.packageHash,
      section.generation,
    ].join("\u0000");
    const current = summaries.get(key);
    if (current) {
      if (!current.contributionIds.includes(section.contributionId)) {
        current.contributionIds.push(section.contributionId);
      }
      current.truncated ||= section.truncated;
      continue;
    }
    summaries.set(key, {
      pluginId: section.pluginId,
      pluginVersion: section.pluginVersion,
      packageHash: section.packageHash,
      generation: section.generation,
      contributionIds: [section.contributionId],
      truncated: section.truncated,
    });
  }
  return [...summaries.values()];
}

export function pluginPromptDisplayId(pluginId: string) {
  const conversationPrefix = "com.liveagent.conversation.";
  return pluginId.startsWith(conversationPrefix)
    ? pluginId.slice(conversationPrefix.length)
    : pluginId;
}
