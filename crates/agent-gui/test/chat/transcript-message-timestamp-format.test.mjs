import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { formatTranscriptMessageTimestamp } = loader.loadModule(
  "../agent-ui/src/components/chat/TranscriptMessageActions.tsx",
);

const DAY_MS = 24 * 60 * 60 * 1000;

// Fixed local-time stamps so the clock part never depends on the machine timezone.
function localTimestamp(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

test("transcript timestamp shows only the clock for today", () => {
  const now = new Date();
  const label = formatTranscriptMessageTimestamp(
    localTimestamp(now.getFullYear(), now.getMonth() + 1, now.getDate(), 20, 34),
    "zh-CN",
  );
  assert.equal(label, "20:34");
});

test("transcript timestamp adds month and day for an earlier day this year", () => {
  const now = new Date();
  const earlier = new Date(now.getTime() - DAY_MS);
  const label = formatTranscriptMessageTimestamp(
    localTimestamp(earlier.getFullYear(), earlier.getMonth() + 1, earlier.getDate(), 9, 5),
    "zh-CN",
  );
  assert.equal(label, `${earlier.getMonth() + 1}月${earlier.getDate()}日 09:05`);
});

test("transcript timestamp adds the year for a previous year", () => {
  const now = new Date();
  assert.equal(
    formatTranscriptMessageTimestamp(localTimestamp(now.getFullYear() - 1, 12, 31, 20, 34), "zh-CN"),
    `${now.getFullYear() - 1}年12月31日 20:34`,
  );
});

test("transcript timestamp uses Intl for non-Chinese locales", () => {
  const now = new Date();
  const earlier = new Date(now.getTime() - DAY_MS);
  assert.match(
    formatTranscriptMessageTimestamp(
      localTimestamp(earlier.getFullYear(), earlier.getMonth() + 1, earlier.getDate(), 9, 5),
      "en-US",
    ),
    new RegExp(` ${String(earlier.getDate())} 09:05$`),
  );
  assert.match(
    formatTranscriptMessageTimestamp(localTimestamp(now.getFullYear() - 1, 12, 31, 20, 34), "en-US"),
    /Dec 31, \d{4} 20:34$/,
  );
});

test("transcript timestamp stays empty for missing or invalid stamps", () => {
  assert.equal(formatTranscriptMessageTimestamp(undefined, "zh-CN"), "");
  assert.equal(formatTranscriptMessageTimestamp(Number.NaN, "zh-CN"), "");
  assert.equal(formatTranscriptMessageTimestamp(0, "zh-CN"), "");
});
