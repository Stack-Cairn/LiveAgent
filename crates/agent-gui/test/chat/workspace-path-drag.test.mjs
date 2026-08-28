import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const workspacePathDrag = loader.loadModule("@liveagent/ui/lib/chat/workspacePathDrag.ts");

class DataTransferStub {
  #values = new Map();
  effectAllowed = "none";
  dropEffect = "none";

  get types() {
    return [...this.#values.keys()];
  }

  getData(type) {
    return this.#values.get(type) ?? "";
  }

  setData(type, value) {
    this.#values.set(type, value);
  }
}

const payload = {
  kind: "workspacePath",
  projectPathKey: "/workspace/project",
  cwd: "/workspace/project",
  relativePath: "docs/方案's draft.md",
  entryKind: "file",
  label: "方案's draft.md",
};

test("workspace path drag payload round-trips without becoming an upload", () => {
  const transfer = new DataTransferStub();
  assert.equal(workspacePathDrag.writeWorkspacePathDragPayload(transfer, payload), true);
  assert.equal(transfer.effectAllowed, "copy");
  assert.equal(
    workspacePathDrag.hasWorkspacePathDragPayload(transfer),
    true,
  );
  assert.deepEqual(workspacePathDrag.readWorkspacePathDragPayload(transfer), payload);
  assert.equal(transfer.getData("text/plain"), payload.relativePath);
  workspacePathDrag.clearActiveWorkspacePathDrag();
});

test("workspace path payload rejects traversal, absolute paths, and controls", () => {
  for (const relativePath of ["../secret", "/tmp/file", "C:/file", "a//b", "a/\u0000b"]) {
    assert.equal(
      workspacePathDrag.createWorkspacePathDragPayload({ ...payload, relativePath }),
      null,
      relativePath,
    );
  }
  assert.equal(
    workspacePathDrag.createWorkspacePathDragPayload({
      ...payload,
      cwd: "/tmp/forged-root",
    }),
    null,
  );
});

test("workspace path drop remains scoped to the originating project", () => {
  assert.equal(
    workspacePathDrag.workspacePathDragMatchesProject(payload, "/workspace/project/"),
    true,
  );
  assert.equal(
    workspacePathDrag.workspacePathDragMatchesProject(payload, "/workspace/other"),
    false,
  );
});

test("terminal insertion uses absolute paths and shell-specific quoting", () => {
  const absolute = workspacePathDrag.absoluteWorkspacePath(payload);
  assert.equal(absolute, "/workspace/project/docs/方案's draft.md");
  assert.equal(
    workspacePathDrag.quoteWorkspacePathForShell(absolute, "/bin/zsh"),
    "'/workspace/project/docs/方案'\\''s draft.md'",
  );
  assert.equal(
    workspacePathDrag.quoteWorkspacePathForShell(absolute, "pwsh.exe"),
    "'/workspace/project/docs/方案''s draft.md'",
  );
  assert.equal(
    workspacePathDrag.absoluteWorkspacePath({
      ...payload,
      projectPathKey: "c:/work/project",
      cwd: "C:\\work\\project",
      relativePath: "docs/a b.txt",
    }),
    "C:\\work\\project\\docs\\a b.txt",
  );
  assert.equal(
    workspacePathDrag.quoteWorkspacePathForShell("C:\\work\\a b.txt", "cmd.exe"),
    '"C:\\work\\a b.txt"',
  );
  assert.equal(
    workspacePathDrag.quoteWorkspacePathForShell("C:\\work\\%USERPROFILE%.txt", "cmd.exe"),
    null,
  );
});
