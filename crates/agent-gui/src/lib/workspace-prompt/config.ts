import { type WorkspaceProject, workspaceProjectPathKey } from "../settings";

// Instruction files probed at the workspace root, in priority order: the first
// existing file with non-empty content wins.
export const PROJECT_INSTRUCTION_FILE_NAMES = ["CLAUDE.md", "AGENTS.md"] as const;

export type ProjectInstructionFileName = (typeof PROJECT_INSTRUCTION_FILE_NAMES)[number];

// Injected instruction-file content beyond this many characters is truncated.
export const PROJECT_INSTRUCTIONS_MAX_CHARS = 32 * 1024;

// Files users may import into the workspace prompt textarea.
export const WORKSPACE_PROMPT_IMPORT_EXTENSIONS = [".md", ".txt", ".markdown", ".text"] as const;

// Imported file content is capped at the same size as project instruction pickup.
export const WORKSPACE_PROMPT_IMPORT_MAX_CHARS = PROJECT_INSTRUCTIONS_MAX_CHARS;

export type ProjectInstructions = {
  fileName: ProjectInstructionFileName;
  content: string;
};

export type WorkspacePromptConfig = {
  prompt: string;
  includeGlobalPrompt: boolean;
  includeProjectInstructions: boolean;
};

export const DEFAULT_WORKSPACE_PROMPT_CONFIG: WorkspacePromptConfig = {
  prompt: "",
  includeGlobalPrompt: true,
  includeProjectInstructions: false,
};

export function workspacePromptConfigFromProject(
  project:
    | Pick<WorkspaceProject, "prompt" | "includeGlobalPrompt" | "includeProjectInstructions">
    | undefined,
): WorkspacePromptConfig {
  if (!project) return DEFAULT_WORKSPACE_PROMPT_CONFIG;
  return {
    prompt: typeof project.prompt === "string" ? project.prompt.trim() : "",
    includeGlobalPrompt: project.includeGlobalPrompt !== false,
    includeProjectInstructions: project.includeProjectInstructions === true,
  };
}

export function resolveWorkspacePromptConfig(
  projects: readonly WorkspaceProject[],
  workdirOrPathKey: string,
): WorkspacePromptConfig {
  const pathKey = workspaceProjectPathKey(workdirOrPathKey);
  if (!pathKey) return DEFAULT_WORKSPACE_PROMPT_CONFIG;
  return workspacePromptConfigFromProject(
    projects.find((project) => workspaceProjectPathKey(project.path) === pathKey),
  );
}

export function truncateProjectInstructions(content: string) {
  const trimmed = content.trim();
  if (trimmed.length <= PROJECT_INSTRUCTIONS_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, PROJECT_INSTRUCTIONS_MAX_CHARS)}\n[content truncated]`;
}

export function isWorkspacePromptImportFileName(fileName: string) {
  const lower = fileName.trim().toLowerCase();
  return WORKSPACE_PROMPT_IMPORT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function workspacePromptImportAcceptAttribute() {
  return WORKSPACE_PROMPT_IMPORT_EXTENSIONS.join(",");
}

// Normalizes imported file text for the workspace prompt textarea. Empty
// content is rejected so the caller can surface a clear error.
export function normalizeImportedWorkspacePromptContent(content: string):
  | {
      ok: true;
      content: string;
      truncated: boolean;
    }
  | {
      ok: false;
      reason: "empty";
    } {
  const trimmed = content.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed.length <= WORKSPACE_PROMPT_IMPORT_MAX_CHARS) {
    return { ok: true, content: trimmed, truncated: false };
  }
  return {
    ok: true,
    content: `${trimmed.slice(0, WORKSPACE_PROMPT_IMPORT_MAX_CHARS)}\n[content truncated]`,
    truncated: true,
  };
}

// If the textarea already has text, append the import after a blank line;
// otherwise replace with the imported body.
export function mergeImportedWorkspacePrompt(existingPrompt: string, importedContent: string) {
  const head = existingPrompt.trim();
  const body = importedContent.trim();
  if (!body) return head;
  if (!head) return body;
  return `${head}\n\n${body}`;
}

export function buildProjectInstructionsPrompt(instructions: ProjectInstructions) {
  const content = truncateProjectInstructions(instructions.content);
  if (!content) return "";
  return [
    `The workspace root contains ${instructions.fileName} with project-specific instructions:`,
    "",
    content,
  ].join("\n");
}

// Combines the prompt layers appended after the base system prompt. Order is
// broad-to-specific: global template, then workspace prompt, then instruction
// file, so more specific guidance lands later in the final prompt.
export function composeAgentPrompt(params: {
  globalPrompt?: string;
  workspacePrompt?: string;
  projectInstructions?: ProjectInstructions | null;
}): string {
  const parts: string[] = [];
  const globalPrompt = (params.globalPrompt ?? "").trim();
  if (globalPrompt) parts.push(globalPrompt);
  const workspacePrompt = (params.workspacePrompt ?? "").trim();
  if (workspacePrompt) parts.push(workspacePrompt);
  if (params.projectInstructions) {
    const instructionsPrompt = buildProjectInstructionsPrompt(params.projectInstructions);
    if (instructionsPrompt) parts.push(instructionsPrompt);
  }
  return parts.join("\n\n");
}
