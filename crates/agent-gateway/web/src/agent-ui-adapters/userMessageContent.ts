import { tokenizeUserMessage as tokenizeHostUserMessage } from "../lib/chat/userMessageContent";

export {
  extractGitHubCommitSha,
  extractGitHubFileReference,
} from "../lib/chat/userMessageContent";

export function tokenizeUserMessage(...args: Parameters<typeof tokenizeHostUserMessage>) {
  return tokenizeHostUserMessage(...args).map((segment) => {
    if (segment.type !== "mention") return segment;
    return {
      type: "mention" as const,
      reference: {
        path: segment.path,
        kind: segment.isDir ? ("dir" as const) : ("file" as const),
      },
    };
  });
}
