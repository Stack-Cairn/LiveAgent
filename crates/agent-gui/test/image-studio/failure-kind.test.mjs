import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// A failed job must say what kind of failure it was: "unknown" may already be billed,
// so it is told apart from a rejection or an empty result. The reason is optional so a
// backend without it keeps the old wording.

const loader = createTsModuleLoader();
const { failureKind, errorActionMessage, jobErrorLines } = loader.loadModule(
  "@liveagent/ui/features/image-studio/studioModel",
);
const { parseImageError, ImageClientError } = loader.loadModule("@liveagent/ui/lib/imaging/errors");
const { t } = loader.loadModule("@liveagent/app/i18n/config");
const zh = (key, params) => t(key, "zh-CN", params);

const wire = (code, extra = {}) => ({
  code,
  message: "x",
  retryable: false,
  requestId: "req-1",
  ...extra,
});

test("failure kinds separate unknown, rejected, empty and auth failures", () => {
  const kinds = {
    IMAGE_RESULT_UNKNOWN: "unknown",
    IMAGE_INVALID_INPUT: "rejected",
    IMAGE_UNSUPPORTED_OPERATION: "rejected",
    IMAGE_NO_IMAGE_OUTPUT: "noOutput",
    IMAGE_EMPTY_RESULT: "noOutput",
    IMAGE_AUTH_REQUIRED: "auth",
    IMAGE_FORBIDDEN: "auth",
    IMAGE_RATE_LIMITED: "rateLimit",
    IMAGE_EVENT_GAP: "eventGap",
    IMAGE_UNAVAILABLE: "other",
    IMAGE_OUTPUT_SAVE_FAILED: "saveFailed",
  };
  for (const [code, kind] of Object.entries(kinds)) assert.equal(failureKind({ code }), kind, code);
  assert.equal(failureKind(undefined), "other");
});

test("an empty provider result no longer falls back to the generic refresh hint", () => {
  assert.equal(errorActionMessage({ code: "IMAGE_NO_IMAGE_OUTPUT" }).key, "imageStudio.errorAction.noOutput");
  assert.equal(errorActionMessage({ code: "IMAGE_UNAVAILABLE" }).key, "imageStudio.errorAction.default");
  assert.equal(errorActionMessage({ code: "IMAGE_RESULT_UNKNOWN" }).key, "imageStudio.errorAction.unknown");
});

test("the wire reason is kept, trimmed and bounded; absence stays absent", () => {
  const withReason = parseImageError(wire("IMAGE_RESULT_UNKNOWN", { reason: "  no response\nfrom the provider  " }));
  assert.equal(withReason.reason, "no response from the provider");
  assert.equal("reason" in parseImageError(wire("IMAGE_UNAVAILABLE")), false);
  assert.equal("reason" in parseImageError(wire("IMAGE_UNAVAILABLE", { reason: "   " })), false);
  assert.equal("reason" in parseImageError(wire("IMAGE_UNAVAILABLE", { reason: 42 })), false);
  const long = parseImageError(wire("IMAGE_UNAVAILABLE", { reason: "x".repeat(900) }));
  assert.ok(long.reason.length <= 200);
  assert.equal(new ImageClientError("IMAGE_UNAVAILABLE", 503, true, "r", undefined, "why").reason, "why");
});

test("job error lines show the reason when the backend sent one", () => {
  const job = (error) => ({ error, items: [] });
  const withReason = jobErrorLines(
    job(wire("IMAGE_RESULT_UNKNOWN", { reason: "request timed out" })),
    zh,
  );
  assert.equal(withReason.length, 1);
  assert.match(withReason[0], /request timed out/);
  const without = jobErrorLines(job(wire("IMAGE_UNAVAILABLE")), zh);
  assert.doesNotMatch(without[0], /（/);
});
