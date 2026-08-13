import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { buildGitCommitMessagePrompt, parseGeneratedCommitMessage } =
  createTsModuleLoader().loadModule(
    "@liveagent/ui/components/project-tools/git-review/generateCommitMessage.ts",
  );

function entry(path, indexStatus, overrides = {}) {
  return {
    path,
    oldPath: null,
    indexStatus,
    worktreeStatus: ".",
    kind: "modified",
    staged: true,
    conflicted: false,
    untracked: false,
    ...overrides,
  };
}

test("parses fenced model JSON and preserves staged file order", () => {
  const files = [entry("src/a.ts", "M"), entry("README.md", "M")];
  const response = `\`\`\`json
  {"title":"feat: improve review generation","bullets":[
    {"path":"README.md","summary":"document the generated commit body"},
    {"path":"src/a.ts","summary":"derive the title from the staged patch"}
  ]}
  \`\`\``;
  assert.equal(
    parseGeneratedCommitMessage(response, files),
    [
      "feat: improve review generation",
      "",
      "- src/a.ts: derive the title from the staged patch",
      "- README.md: document the generated commit body",
    ].join("\n"),
  );
});

test("rejects titles that are not conventional commits", () => {
  const files = [entry("src/a.ts", "M")];
  assert.throws(
    () =>
      parseGeneratedCommitMessage(
        '{"title":"updated some stuff","bullets":[{"path":"src/a.ts","summary":"update logic"}]}',
        files,
      ),
    /invalid commit title/,
  );
  assert.throws(
    () =>
      parseGeneratedCommitMessage(
        `{"title":"feat: ${"x".repeat(80)}","bullets":[{"path":"src/a.ts","summary":"update logic"}]}`,
        files,
      ),
    /invalid commit title/,
  );
});

test("rejects bullets with unknown, duplicate or empty entries", () => {
  const files = [entry("src/a.ts", "M")];
  assert.throws(
    () =>
      parseGeneratedCommitMessage(
        '{"title":"feat: update files","bullets":[{"path":"src/other.ts","summary":"update logic"}]}',
        files,
      ),
    /invalid file-level commit details/,
  );
  assert.throws(
    () =>
      parseGeneratedCommitMessage(
        '{"title":"feat: update files","bullets":[{"path":"src/a.ts","summary":"one"},{"path":"src/a.ts","summary":"two"}]}',
        files,
      ),
    /invalid file-level commit details/,
  );
  assert.throws(
    () =>
      parseGeneratedCommitMessage(
        '{"title":"feat: update files","bullets":[{"path":"src/a.ts","summary":"  "}]}',
        files,
      ),
    /invalid file-level commit details/,
  );
});

test("rejects incomplete model output and sends only staged metadata", () => {
  const files = [entry("src/a.ts", "M"), entry("src/b.ts", "A")];
  assert.throws(
    () =>
      parseGeneratedCommitMessage(
        '{"title":"feat: update files","bullets":[{"path":"src/a.ts","summary":"update logic"}]}',
        files,
      ),
    /omitted staged files/,
  );

  const prompt = JSON.parse(
    buildGitCommitMessagePrompt({ patch: "diff --git a/src/a.ts b/src/a.ts", files, truncated: true }),
  );
  assert.equal(prompt.patch, "diff --git a/src/a.ts b/src/a.ts");
  assert.equal(prompt.truncated, true);
  assert.deepEqual(prompt.files[0], {
    path: "src/a.ts",
    oldPath: null,
    indexStatus: "M",
    kind: "modified",
  });
  assert.equal("worktreeStatus" in prompt.files[0], false);
});
