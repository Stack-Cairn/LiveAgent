import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMarkdown, responseText } from "./create-ai-release-notes.mjs";

test("responseText drops reasoning output items", () => {
  // Regression: DeepSeek returned only a reasoning item, and its chain of thought was published
  // as the release notes.
  const reasoningOnly = {
    output: [
      {
        type: "reasoning",
        content: [{ type: "reasoning_text", text: "We need write release notes Markdown only." }],
      },
    ],
  };
  assert.equal(responseText(reasoningOnly), "");

  const withMessage = {
    output: [
      {
        type: "reasoning",
        content: [{ type: "reasoning_text", text: "Let's parse evidence." }],
      },
      {
        type: "message",
        content: [{ type: "output_text", text: "# LiveAgent v1.3.6-beta.1\n\n> Summary." }],
      },
    ],
  };
  assert.equal(responseText(withMessage), "# LiveAgent v1.3.6-beta.1\n\n> Summary.");
});

test("responseText drops reasoning parts inside an output item", () => {
  const payload = {
    output: [
      {
        type: "message",
        content: [
          { type: "reasoning_text", text: "internal thinking" },
          { type: "output_text", text: "# LiveAgent v1.3.6-beta.1" },
        ],
      },
    ],
  };
  assert.equal(responseText(payload), "# LiveAgent v1.3.6-beta.1");
});

test("responseText prefers aggregated output_text", () => {
  const payload = {
    output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "thinking" }] }],
    output_text: "# LiveAgent v1.3.6-beta.1",
  };
  assert.equal(responseText(payload), "# LiveAgent v1.3.6-beta.1");
});

test("responseText reads chat completion content and ignores reasoning_content", () => {
  assert.equal(
    responseText({ choices: [{ message: { content: "# LiveAgent v1.3.6-beta.1" } }] }),
    "# LiveAgent v1.3.6-beta.1",
  );
  assert.equal(
    responseText({
      choices: [{ message: { content: "", reasoning_content: "We need write release notes." } }],
    }),
    "",
  );
});

test("normalizeMarkdown keeps only the block starting at the required heading", () => {
  const markdown = [
    "We need write release notes Markdown only, starting H1 exactly.",
    "",
    "Overview: broad UI refactor.",
    "",
    "# LiveAgent v1.3.6-beta.1",
    "",
    "> One-sentence summary.",
    "",
    "## Overview",
    "",
    "Real body.",
  ].join("\n");

  assert.equal(
    normalizeMarkdown(markdown, "v1.3.6-beta.1"),
    "# LiveAgent v1.3.6-beta.1\n\n> One-sentence summary.\n\n## Overview\n\nReal body.\n",
  );
});

test("normalizeMarkdown rejects output without the required heading", () => {
  const markdown = [
    "We need write release notes Markdown only, starting H1 exactly.",
    "",
    "Let's parse evidence.",
  ].join("\n");

  assert.equal(normalizeMarkdown(markdown, "v1.3.6-beta.1"), "");
  assert.equal(normalizeMarkdown("", "v1.3.6-beta.1"), "");
});

test("normalizeMarkdown unwraps a fenced code block", () => {
  assert.equal(
    normalizeMarkdown("```markdown\n# LiveAgent v1.3.6-beta.1\n\n> Summary.\n```", "v1.3.6-beta.1"),
    "# LiveAgent v1.3.6-beta.1\n\n> Summary.\n",
  );
});
