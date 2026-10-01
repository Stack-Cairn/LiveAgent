import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { diffCheckTargets } from "./check-diff-hygiene.mjs";

const scriptPath = resolve(import.meta.dirname, "check-diff-hygiene.mjs");

function run(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
}

function initRepository() {
  const root = mkdtempSync(join(tmpdir(), "diff-hygiene-"));
  run(["init", "-q", "-b", "main"], root);
  run(["config", "user.email", "check@example.com"], root);
  run(["config", "user.name", "Check"], root);
  writeFileSync(join(root, "README.md"), "base\n");
  run(["add", "."], root);
  run(["commit", "-q", "-m", "base"], root);
  return root;
}

function runScript(cwd) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, LIVEAGENT_CHECK_BASE_REF: "main" },
  });
}

test("diffCheckTargets skips the committed range when no base is resolved", () => {
  assert.deepEqual(diffCheckTargets(undefined), [["diff", "--check", "HEAD"]]);
});

test("a committed trailing blank line is reported even with a clean worktree", () => {
  const root = initRepository();
  try {
    run(["checkout", "-q", "-b", "feature"], root);
    writeFileSync(join(root, "notes.md"), "content\n\n");
    run(["add", "."], root);
    run(["commit", "-q", "-m", "add notes"], root);

    const clean = run(["diff", "--check", "HEAD"], root);
    assert.equal(clean.stdout.trim(), "", "worktree 必须干净，才能证明命中的是提交区间");

    const result = runScript(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /notes\.md:2: new blank line at EOF\./);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a clean committed range passes", () => {
  const root = initRepository();
  try {
    run(["checkout", "-q", "-b", "feature"], root);
    writeFileSync(join(root, "notes.md"), "content\n");
    run(["add", "."], root);
    run(["commit", "-q", "-m", "add notes"], root);

    const result = runScript(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /diff hygiene: clean/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
