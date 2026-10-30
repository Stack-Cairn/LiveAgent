import { DEFAULT_LOCALE, type Locale, t } from "../../i18n/config";

// K-brain's reviewer reports fixed English reasons when it cannot review an
// action (internal/approval/reviewer.go, run.go). Prefixes may stack in front
// of either a fixed reason or the reviewer model's own explanation, which is
// shown as written.
const PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["Earlier tool output requires human review.", "chat.aiReview.reason.earlierOutput"],
  ["Non-text attachments were not reviewed.", "chat.aiReview.reason.attachmentsNotReviewed"],
  [
    "Sensitive data was redacted; manual approval required.",
    "chat.aiReview.reason.sensitiveRedacted",
  ],
];

const FIXED_REASONS: Readonly<Record<string, string>> = {
  "Review cancelled; manual approval required": "chat.aiReview.reason.cancelled",
  "Reviewer unavailable; manual approval required": "chat.aiReview.reason.unavailable",
  "Evidence exceeds review budget; manual approval required":
    "chat.aiReview.reason.evidenceTooLarge",
  "Turn review budget exhausted; manual approval required":
    "chat.aiReview.reason.turnBudgetExhausted",
  "Reviewer busy; manual approval required": "chat.aiReview.reason.busy",
  "Reviewer failed or timed out; manual approval required": "chat.aiReview.reason.failed",
  "Reviewer timed out; manual approval required": "chat.aiReview.reason.timedOut",
  "Reviewer model could not be resolved; manual approval required":
    "chat.aiReview.reason.modelUnresolved",
  "Reviewer reply was truncated; manual approval required": "chat.aiReview.reason.truncated",
  "Invalid reviewer response; manual approval required": "chat.aiReview.reason.invalidResponse",
};

// The review provider's HTTP status is the one variable part K-brain reports.
const HTTP_FAILURE = /^Reviewer request failed \(HTTP (\d{3})\); manual approval required$/;

export function aiReviewTitle(tool: string, locale?: Locale): string {
  return t("chat.aiReview.title", locale).replace("{tool}", tool);
}

export function localizeAIReviewReason(reason: string, locale?: Locale): string {
  const parts: string[] = [];
  let rest = reason.trim();
  for (let matched = true; matched; ) {
    matched = false;
    for (const [prefix, key] of PREFIXES) {
      if (rest.startsWith(prefix)) {
        parts.push(t(key, locale));
        rest = rest.slice(prefix.length).trim();
        matched = true;
      }
    }
  }
  const bare = rest.replace(/\.$/, "");
  const fixed = FIXED_REASONS[bare];
  const httpStatus = HTTP_FAILURE.exec(bare)?.[1];
  if (fixed) parts.push(t(fixed, locale));
  else if (httpStatus) parts.push(t("chat.aiReview.reason.httpFailed", locale).replace("{status}", httpStatus));
  else if (rest) parts.push(rest);
  return parts.join((locale ?? DEFAULT_LOCALE).startsWith("zh") ? "" : " ");
}
