import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { parseAppWindowLaunchContext } = loader.loadModule(
  "src/lib/windowLaunchContext.ts",
);

test("conversation window context decodes the requested conversation", () => {
  assert.deepEqual(
    parseAppWindowLaunchContext(
      "?appWindow=conversation&conversationId=conversation%2F123&conversationTitle=Hello%20world",
    ),
    {
      kind: "conversation",
      conversationId: "conversation/123",
      conversationTitle: "Hello world",
    },
  );
});

test("invalid or unrelated window routes stay in the main application", () => {
  assert.deepEqual(parseAppWindowLaunchContext(""), { kind: "main" });
  assert.deepEqual(parseAppWindowLaunchContext("?appWindow=conversation"), { kind: "main" });
  assert.deepEqual(parseAppWindowLaunchContext("?appWindow=settings&conversationId=abc"), {
    kind: "main",
  });
});
