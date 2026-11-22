import {
  type ChatRuntimeControls,
  DEFAULT_CHAT_RUNTIME_CONTROLS,
  type ReasoningLevel,
} from "../settings/types";

export type ThinkingLevelInput = {
  /** Levels the current model accepts (may include "off"). */
  reasoningOptions: readonly ReasoningLevel[];
  /** Models that always think cannot be switched off. */
  thinkingAlwaysOn: boolean;
  controls: Pick<ChatRuntimeControls, "reasoning" | "thinkingEnabled">;
};

/**
 * What the composer shows for thinking: whether the model supports it, whether
 * it is on, the effort choices (empty when the model only has an on/off
 * switch) and the choice currently in effect.
 */
export function resolveThinkingLevels({
  reasoningOptions,
  thinkingAlwaysOn,
  controls,
}: ThinkingLevelInput) {
  const supported = reasoningOptions.length > 0 || thinkingAlwaysOn;
  const selectedReasoning: ReasoningLevel = reasoningOptions.includes(controls.reasoning)
    ? controls.reasoning
    : reasoningOptions.includes(DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning)
      ? DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning
      : (reasoningOptions[reasoningOptions.length - 1] ?? DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning);
  const thinkingOn = supported && (thinkingAlwaysOn || controls.thinkingEnabled);
  const choices: ReasoningLevel[] =
    supported && reasoningOptions.length > 1
      ? thinkingAlwaysOn
        ? reasoningOptions.filter((level) => level !== "off")
        : ["off", ...reasoningOptions.filter((level) => level !== "off")]
      : [];
  const selected: ReasoningLevel = thinkingOn ? selectedReasoning : "off";
  return { supported, thinkingOn, selectedReasoning, choices, selected };
}

/** The runtime-controls patch that picks one effort choice. */
export function thinkingLevelPatch(level: ReasoningLevel): Partial<ChatRuntimeControls> {
  return level === "off" ? { thinkingEnabled: false } : { thinkingEnabled: true, reasoning: level };
}

/**
 * The next thinking setting: the following effort choice (wrapping around),
 * or on/off for models with a plain switch. Null when there is nothing to
 * change (no thinking support, or an always-on model without levels).
 */
export function nextThinkingLevel(
  input: ThinkingLevelInput,
): { patch: Partial<ChatRuntimeControls>; level: ReasoningLevel; thinkingOn: boolean } | null {
  const state = resolveThinkingLevels(input);
  if (!state.supported) return null;
  if (state.choices.length > 1) {
    const index = state.choices.indexOf(state.selected);
    const level = state.choices[(index + 1) % state.choices.length];
    return { patch: thinkingLevelPatch(level), level, thinkingOn: level !== "off" };
  }
  if (input.thinkingAlwaysOn) return null;
  const thinkingOn = !input.controls.thinkingEnabled;
  return {
    patch: { thinkingEnabled: thinkingOn },
    level: thinkingOn ? state.selectedReasoning : "off",
    thinkingOn,
  };
}
