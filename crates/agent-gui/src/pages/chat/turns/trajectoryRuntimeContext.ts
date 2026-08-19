import { appendSystemPrompt } from "../runtime/chatPageRuntime";

export type TrajectoryRuntimeContextPart = {
  source: string;
  text?: string;
};

export type BuiltTrajectoryRuntimeContext = {
  prompt?: string;
  entries: readonly { source: string; text: string }[];
};

/** Normalize dynamic prompt injections once so recording and the actual request share bytes/order. */
export function buildTrajectoryRuntimeContext(
  parts: readonly TrajectoryRuntimeContextPart[],
): BuiltTrajectoryRuntimeContext {
  let prompt: string | undefined;
  const entries: { source: string; text: string }[] = [];
  for (const part of parts) {
    const source = part.source.trim();
    const text = part.text?.trim() ?? "";
    if (source === "" || text === "") continue;
    entries.push({ source, text });
    prompt = appendSystemPrompt(prompt, text);
  }
  return { ...(prompt ? { prompt } : {}), entries };
}
