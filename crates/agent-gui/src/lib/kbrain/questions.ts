import type { ToolCall } from "@liveagent/app/lib/agentTypes";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  type AskUserQuestionAnswer,
  type AskUserQuestionResultDetails,
  KBRAIN_QUESTION_ORIGINAL_ARGUMENTS_ARG,
  KBRAIN_QUESTION_TOOL_NAME,
  normalizeKBrainQuestionToolArguments,
  parseKBrainQuestionToolResult,
  readKBrainQuestionAnswer,
} from "@liveagent/ui/lib/chat/askUserQuestion";

/**
 * K-brain's own `question` tool (Stack-Cairn/K-brain#162) shows as the AskUserQuestion
 * card: live (where question.requested already names it so) and in restored history.
 */
export function normalizeKBrainQuestionToolCall(call: ToolCall): ToolCall {
  if (call.name !== KBRAIN_QUESTION_TOOL_NAME) return call;
  return {
    ...call,
    name: ASK_USER_QUESTION_TOOL_NAME,
    arguments: {
      ...normalizeKBrainQuestionToolArguments(call.arguments),
      [KBRAIN_QUESTION_ORIGINAL_ARGUMENTS_ARG]: call.arguments ?? {},
    },
  };
}

export { KBRAIN_QUESTION_ORIGINAL_ARGUMENTS_ARG };

/** The K-brain name and arguments of a call {@link normalizeKBrainQuestionToolCall} renamed. */
export function originalKBrainToolCall(call: Pick<ToolCall, "name" | "arguments">): {
  name: string;
  arguments: unknown;
} {
  const original = call.arguments?.[KBRAIN_QUESTION_ORIGINAL_ARGUMENTS_ARG];
  if (call.name !== ASK_USER_QUESTION_TOOL_NAME || original === undefined) {
    return { name: call.name, arguments: call.arguments };
  }
  return { name: KBRAIN_QUESTION_TOOL_NAME, arguments: original };
}

/** The tool result name the transcript shows for a K-brain tool result. */
export function kbrainToolResultName(name: string | undefined): string {
  return name === KBRAIN_QUESTION_TOOL_NAME ? ASK_USER_QUESTION_TOOL_NAME : name || "tool";
}

/**
 * Question card details from a K-brain tool result: AskUserQuestion returns the
 * resolution as JSON; the `question` tool returns plain text that is read against the
 * call's arguments. `questionAnswers` is the `question_answers` K-brain records on the
 * call (Stack-Cairn/K-brain#168); when present it is read instead of the result, so a
 * multi-select label containing ", " comes back exactly.
 */
export function questionResultDetails(
  name: string | undefined,
  output: string,
  args?: unknown,
  isError = false,
  questionAnswers?: unknown,
): AskUserQuestionResultDetails | undefined {
  if (name === KBRAIN_QUESTION_TOOL_NAME) {
    return parseKBrainQuestionToolResult(args, output, isError, questionAnswers) ?? undefined;
  }
  if (name !== ASK_USER_QUESTION_TOOL_NAME) return undefined;
  return questionResolutionDetails(output, questionAnswers);
}

/**
 * A question.resolved payload (or the AskUserQuestion result that carries it) as card
 * details. Structured answers (`selected_labels`) keep their labels; old-style answers
 * keep their text for the card to read against the questions.
 */
export function questionResolutionDetails(
  output: string,
  questionAnswers?: unknown,
): AskUserQuestionResultDetails | undefined {
  try {
    const start = output.indexOf("{");
    const result = JSON.parse(output.slice(start));
    if (
      result.kind !== "ask_user_question" ||
      !Array.isArray(result.questions) ||
      !Array.isArray(result.answers)
    )
      return undefined;
    const recorded =
      Array.isArray(questionAnswers) && questionAnswers.length > 0
        ? questionAnswers
        : result.answers;
    const answers: AskUserQuestionAnswer[] = [];
    for (const value of recorded) {
      const answer = readKBrainQuestionAnswer(value);
      if (answer) answers.push(answer);
    }
    return {
      kind: "ask_user_question",
      questions: result.questions,
      answers,
      timedOut: result.timed_out === true,
      cancelled: result.cancelled === true,
    };
  } catch {
    return undefined;
  }
}
