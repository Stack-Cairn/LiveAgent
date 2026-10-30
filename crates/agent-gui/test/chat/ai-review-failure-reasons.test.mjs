// K-brain now names why a review failed (internal/approval/reviewer.go failureReason):
// timeout, an HTTP status from the review provider, an unresolvable review model, or a
// truncated reply. The Chinese UI must not show these in English, and the HTTP status
// stays visible so the user can tell a broken review model from a slow one.
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { localizeAIReviewReason } = loader.loadModule("src/lib/kbrain/reviewNotice.ts");

test("named reviewer failures are localized, keeping the HTTP status", () => {
  const cases = [
    ["Reviewer timed out; manual approval required", "审查超时", "Reviewer timed out"],
    ["Reviewer request failed (HTTP 400); manual approval required", "HTTP 400", "HTTP 400"],
    ["Reviewer model could not be resolved; manual approval required", "审查模型", "could not be resolved"],
    ["Reviewer reply was truncated; manual approval required", "截断", "truncated"],
    ["Reviewer failed or timed out; manual approval required", "审查失败或超时", "Reviewer failed"],
  ];
  for (const [reason, zh, en] of cases) {
    const chinese = localizeAIReviewReason(reason, "zh-CN");
    assert.match(chinese, new RegExp(zh.replace(/[()]/g, "\$&")), reason);
    assert.doesNotMatch(chinese, /manual approval required/, `${reason} stays English: ${chinese}`);
    assert.match(localizeAIReviewReason(reason, "en-US"), new RegExp(en.replace(/[()]/g, "\$&")));
  }
  assert.match(
    localizeAIReviewReason(
      "Earlier tool output requires human review. Reviewer request failed (HTTP 503); manual approval required",
      "zh-CN",
    ),
    /^之前的工具输出需要人工复核。.*HTTP 503/,
  );
});
