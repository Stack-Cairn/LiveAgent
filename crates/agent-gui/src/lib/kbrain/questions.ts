import type { AskUserQuestionResultDetails } from "@liveagent/ui/lib/chat/askUserQuestion";

export function questionResultDetails(
  name: string | undefined,
  output: string,
): AskUserQuestionResultDetails | undefined {
  if (name !== "AskUserQuestion") return undefined;
  try {
    const start = output.indexOf("{");
    const result = JSON.parse(output.slice(start));
    if (
      result.kind !== "ask_user_question" ||
      !Array.isArray(result.questions) ||
      !Array.isArray(result.answers)
    )
      return undefined;
    return {
      kind: "ask_user_question",
      questions: result.questions,
      answers: result.answers.map(
        (answer: {
          question_id: string;
          prompt: string;
          selected_label: string;
          custom?: boolean;
        }) => ({
          questionId: answer.question_id,
          prompt: answer.prompt,
          selectedLabel: answer.selected_label,
          ...(answer.custom ? { custom: true } : {}),
        }),
      ),
      timedOut: result.timed_out === true,
      cancelled: result.cancelled === true,
    };
  } catch {
    return undefined;
  }
}
