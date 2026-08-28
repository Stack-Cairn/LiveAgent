import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const workbench = loader.loadModule("@liveagent/ui/lib/workbench/index.ts");

const {
  applyWorkbenchCommand,
  collectWorkbenchLayoutIssues,
  createEmptyWorkbenchLayout,
  findPaneIdByConversationId,
  findPaneIdBySurfaceKey,
  surfaceIdentityKey,
  surfaceProjectRef,
} = workbench;

let splitCounter = 0;
const reducerOptions = { createSplitId: () => `terminal-split-${++splitCounter}` };

const project = (projectId = "project-main") => ({
  projectId,
  projectPathKey: `/workspace/${projectId}`,
});

function conversationPane(paneId, conversationId, projectId = "project-main") {
  return {
    paneId,
    surface: { kind: "conversation", conversationId, project: project(projectId) },
    view: {},
  };
}

function localTerminalPane(paneId, surfaceId, overrides = {}) {
  return {
    paneId,
    surface: {
      kind: "localTerminal",
      surfaceId,
      project: project(),
      launchSpec: { cwd: "/workspace/project-main", ...overrides },
    },
    view: {},
  };
}

function sshTerminalPane(paneId, surfaceId, overrides = {}) {
  return {
    paneId,
    surface: {
      kind: "sshTerminal",
      surfaceId,
      project: project(),
      launchSpec: { cwd: "/workspace/project-main", sshHostId: "host-1", ...overrides },
    },
    view: {},
  };
}

function apply(layout, command) {
  return applyWorkbenchCommand(
    layout,
    { expectedRevision: layout.revision, ...command },
    reducerOptions,
  );
}

function mustApply(layout, command) {
  const result = apply(layout, command);
  assert.equal(result.ok, true, `command ${command.type} failed: ${JSON.stringify(result)}`);
  return result.layout;
}

function conversationRoot() {
  return mustApply(createEmptyWorkbenchLayout(), {
    type: "OPEN_PANE",
    pane: conversationPane("pane-conversation", "conversation-a"),
    target: { kind: "canvas-empty" },
  });
}

test("identity helpers distinguish surface kinds", () => {
  assert.equal(
    surfaceIdentityKey({ kind: "conversation", conversationId: " c1 ", project: project() }),
    "conversation:c1",
  );
  assert.equal(surfaceIdentityKey(localTerminalPane("p", " t1 ").surface), "terminal:t1");
  assert.equal(surfaceIdentityKey(sshTerminalPane("p", "t2").surface), "terminal:t2");
  assert.equal(
    surfaceIdentityKey({ kind: "fileTree", project: project() }),
    "fileTree:/workspace/project-main",
  );
  assert.deepEqual(surfaceProjectRef(localTerminalPane("p", "t1").surface), project());
  assert.equal(
    surfaceProjectRef({ kind: "unsupported", originalKind: "editor", raw: {} }),
    null,
  );
});

test("file tree is a project-scoped singleton surface", () => {
  let layout = conversationRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: {
      paneId: "pane-file-tree",
      surface: { kind: "fileTree", project: project() },
      view: {},
    },
    target: { kind: "pane-edge", paneId: "pane-conversation", edge: "left" },
  });
  assert.equal(
    findPaneIdBySurfaceKey(layout, "fileTree:/workspace/project-main"),
    "pane-file-tree",
  );
  const duplicate = apply(layout, {
    type: "OPEN_PANE",
    pane: {
      paneId: "pane-file-tree-2",
      surface: { kind: "fileTree", project: project() },
      view: {},
    },
    target: { kind: "pane-edge", paneId: "pane-conversation", edge: "bottom" },
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, "duplicate-surface");
});

test("opens a local terminal pane beside a conversation pane", () => {
  let layout = conversationRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: localTerminalPane("pane-terminal", "terminal-1"),
    target: { kind: "pane-edge", paneId: "pane-conversation", edge: "right" },
  });
  assert.equal(layout.focusedPaneId, "pane-terminal");
  assert.equal(Object.keys(layout.panes).length, 2);
  assert.equal(findPaneIdBySurfaceKey(layout, "terminal:terminal-1"), "pane-terminal");
  assert.equal(findPaneIdByConversationId(layout, "conversation-a"), "pane-conversation");
  assert.deepEqual(collectWorkbenchLayoutIssues(layout), []);
});

test("rejects a second pane for the same terminal surface id", () => {
  let layout = conversationRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: localTerminalPane("pane-terminal", "terminal-1"),
    target: { kind: "pane-edge", paneId: "pane-conversation", edge: "right" },
  });
  const result = apply(layout, {
    type: "OPEN_PANE",
    pane: localTerminalPane("pane-terminal-2", "terminal-1"),
    target: { kind: "pane-edge", paneId: "pane-conversation", edge: "bottom" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "duplicate-surface");
});

test("distinct surface ids with identical launch specs may coexist", () => {
  let layout = conversationRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: localTerminalPane("pane-terminal-1", "terminal-1"),
    target: { kind: "pane-edge", paneId: "pane-conversation", edge: "right" },
  });
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: localTerminalPane("pane-terminal-2", "terminal-2"),
    target: { kind: "pane-edge", paneId: "pane-terminal-1", edge: "bottom" },
  });
  assert.equal(Object.keys(layout.panes).length, 3);
  assert.deepEqual(collectWorkbenchLayoutIssues(layout), []);
});

test("rejects invalid terminal records and unsupported surfaces on open", () => {
  const layout = conversationRoot();
  const missingCwd = apply(layout, {
    type: "OPEN_PANE",
    pane: localTerminalPane("pane-terminal", "terminal-1", { cwd: "  " }),
    target: { kind: "pane-edge", paneId: "pane-conversation", edge: "right" },
  });
  assert.equal(missingCwd.ok, false);
  assert.equal(missingCwd.error.code, "invalid-layout");

  const missingSurfaceId = apply(layout, {
    type: "OPEN_PANE",
    pane: localTerminalPane("pane-terminal", "  "),
    target: { kind: "pane-edge", paneId: "pane-conversation", edge: "right" },
  });
  assert.equal(missingSurfaceId.ok, false);
  assert.equal(missingSurfaceId.error.code, "invalid-layout");

  const unsupported = apply(layout, {
    type: "OPEN_PANE",
    pane: {
      paneId: "pane-unknown",
      surface: { kind: "unsupported", originalKind: "editor", raw: { kind: "editor" } },
      view: {},
    },
    target: { kind: "pane-edge", paneId: "pane-conversation", edge: "right" },
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, "unsupported-surface");
});

test("terminal panes move, swap focus, and close like conversations", () => {
  let layout = conversationRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: sshTerminalPane("pane-ssh", "terminal-ssh"),
    target: { kind: "pane-edge", paneId: "pane-conversation", edge: "right" },
  });
  layout = mustApply(layout, {
    type: "MOVE_PANE",
    paneId: "pane-ssh",
    target: { kind: "pane-edge", paneId: "pane-conversation", edge: "top" },
  });
  assert.equal(layout.focusedPaneId, "pane-ssh");
  layout = mustApply(layout, { type: "FOCUS_PANE", paneId: "pane-conversation" });
  layout = mustApply(layout, { type: "CLOSE_PANE", paneId: "pane-ssh" });
  assert.equal(layout.panes["pane-ssh"], undefined);
  assert.equal(layout.focusedPaneId, "pane-conversation");
  assert.deepEqual(collectWorkbenchLayoutIssues(layout), []);
});

test("invariants flag duplicate terminal surfaces and invalid launch specs", () => {
  let layout = conversationRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: localTerminalPane("pane-terminal-1", "terminal-1"),
    target: { kind: "pane-edge", paneId: "pane-conversation", edge: "right" },
  });
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: localTerminalPane("pane-terminal-2", "terminal-2"),
    target: { kind: "pane-edge", paneId: "pane-terminal-1", edge: "bottom" },
  });

  const duplicated = {
    ...layout,
    panes: {
      ...layout.panes,
      "pane-terminal-2": {
        ...layout.panes["pane-terminal-2"],
        surface: {
          ...layout.panes["pane-terminal-2"].surface,
          surfaceId: "terminal-1",
        },
      },
    },
  };
  assert.deepEqual(
    collectWorkbenchLayoutIssues(duplicated).map((issue) => issue.code),
    ["duplicate-surface"],
  );

  const badCwd = {
    ...layout,
    panes: {
      ...layout.panes,
      "pane-terminal-2": {
        ...layout.panes["pane-terminal-2"],
        surface: {
          ...layout.panes["pane-terminal-2"].surface,
          launchSpec: { cwd: " " },
        },
      },
    },
  };
  assert.deepEqual(
    collectWorkbenchLayoutIssues(badCwd).map((issue) => issue.code),
    ["invalid-pane-record"],
  );
});
