import { invokeFs } from "../tools/fsBackend";
import { PROJECT_INSTRUCTION_FILE_NAMES, type ProjectInstructions } from "./config";

type EditableTextResponse = {
  content: string;
};

// Probes the workspace root for an instruction file (CLAUDE.md, then
// AGENTS.md) and returns the first one with non-empty content. Any read
// failure (missing file, oversized, non-UTF-8, backend offline) degrades to
// null so callers never block a turn on instruction pickup.
export async function readProjectInstructions(
  workdir: string,
): Promise<ProjectInstructions | null> {
  const dir = workdir.trim();
  if (!dir) return null;
  for (const fileName of PROJECT_INSTRUCTION_FILE_NAMES) {
    try {
      const response = await invokeFs<EditableTextResponse>("fs_read_editable_text", {
        workdir: dir,
        path: fileName,
      });
      const content = typeof response?.content === "string" ? response.content : "";
      if (content.trim()) {
        return { fileName, content };
      }
    } catch {
      // Fall through to the next candidate file.
    }
  }
  return null;
}
