import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("desktop native drop bridges the active payload to the element at the release point", () => {
  const transfer = new DataTransferStub();
  workspacePathDrag.writeWorkspacePathDragPayload(transfer, payload);
  let received = null;
  let hitPoint = null;
  const target = {
    dispatchEvent(event) {
      received = workspacePathDrag.readNativeWorkspacePathDrop(event);
      event.preventDefault();
      return false;
    },
  };

  assert.equal(
    workspacePathDrag.dispatchActiveWorkspacePathDrop(
      { x: 320, y: 240 },
      {
        document: {
          elementFromPoint(x, y) {
            hitPoint = { x, y };
            return target;
          },
        },
        createEvent(type, detail) {
          const event = new Event(type, { cancelable: true });
          Object.defineProperty(event, "detail", { value: detail });
          return event;
        },
      },
    ),
    true,
  );
  assert.deepEqual(hitPoint, { x: 320, y: 240 });
  assert.deepEqual(received, payload);
  assert.equal(workspacePathDrag.getActiveWorkspacePathDrag(), null);
});

test("dragend keeps the payload alive for Tauri's following native drop callback", () => {
  const transfer = new DataTransferStub();
  workspacePathDrag.writeWorkspacePathDragPayload(transfer, payload);
  workspacePathDrag.finishWorkspacePathDrag();
  assert.deepEqual(workspacePathDrag.getActiveWorkspacePathDrag(), payload);
  workspacePathDrag.clearActiveWorkspacePathDrag();
});

test("desktop native drop never forwards an in-app drag to the OS upload path", () => {
  const source = readFileSync(
    new URL("../../src/pages/chat/hooks/useTauriFileDrop.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(getActiveWorkspacePathDrag\(\)\)[\s\S]*dispatchActiveWorkspacePathDrop/);
  assert.match(source, /if \(event\.payload\.paths\.length === 0\) return;/);
});

test("composer and terminal consume the bridged native workspace drop", () => {
  const composer = readFileSync(
    new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url),
    "utf8",
  );
  const terminal = readFileSync(
    new URL(
      "../../../agent-ui/src/components/project-tools/XTermViewport.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(composer, /readNativeWorkspacePathDrop\(event\)/);
  assert.match(composer, /insertWorkspacePathMention\(payload\)/);
  assert.match(terminal, /readNativeWorkspacePathDrop\(event\)/);
  assert.match(terminal, /insertWorkspacePathInTerminal\(payload\)/);
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
