import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const workbench = loader.loadModule("@liveagent/ui/lib/workbench/index.ts");
const { terminalSurfaceForSession } = loader.loadModule(
  "src/pages/chat/workbench/terminalDropCommit.ts",
);

const {
  applyWorkbenchCommand,
  createEmptyWorkbenchLayout,
  decodeWorkbenchLayout,
  encodeWorkbenchLayout,
  isWorkbenchLayoutValid,
  WORKBENCH_LAYOUT_SCHEMA_VERSION,
} = workbench;

/**
 * The persisted workbench layout is a privacy boundary: it lands in SQLite /
 * localStorage untouched by any redaction layer, so its shape is an explicit
 * allow-list rather than "whatever the pane record happened to carry".
 * Derived from codec.ts (encode payload + readSurface/readPaneRecord) and
 * types.ts (PaneRecord / WorkbenchSurfaceSpec / launch specs).
 */
const LAYOUT_KEY_ALLOWLIST = new Set([
  // Envelope (codec.ts encodeWorkbenchLayout)
  "schemaVersion",
  "revision",
  "root",
  "panes",
  "focusedPaneId",
  // Pane tree nodes (types.ts PaneNode)
  "type",
  "paneId",
  "splitId",
  "axis",
  "ratio",
  "first",
  "second",
  // Pane records (types.ts PaneRecord). `view` is PaneViewState =
  // Record<string, never>: a reserved empty slot, so it contributes no keys.
  "surface",
  "view",
  // Surfaces (types.ts WorkbenchSurfaceSpec)
  "kind",
  "conversationId",
  "surfaceId",
  "project",
  "launchSpec",
  "originalKind",
  "raw",
  // Project reference (types.ts ProjectRef)
  "projectId",
  "projectPathKey",
  // Launch specs (types.ts Local/SshTerminalLaunchSpec)
  "cwd",
  "shell",
  "title",
  "sshHostId",
  "sftpEnabled",
]);

/**
 * Secrets and per-run state that must never reach a persisted layout. Terminal
 * `sessionId` in particular lives only in sessionStorage (see
 * terminalPaneBindingStore) precisely so a layout file cannot resurrect a dead
 * PTY handle.
 */
const FORBIDDEN_KEYS = [
  "sessionId",
  "draft",
  "drafts",
  "messages",
  "transcript",
  "token",
  "apiKey",
  "accessToken",
  "prompt",
  "attachments",
  "uploads",
  "approvals",
  "env",
];

let splitCounter = 0;
const reducerOptions = { createSplitId: () => `privacy-split-${++splitCounter}` };

function apply(layout, command) {
  const result = applyWorkbenchCommand(
    layout,
    { expectedRevision: layout.revision, ...command },
    reducerOptions,
  );
  assert.equal(result.ok, true, `command ${command.type} failed: ${JSON.stringify(result)}`);
  return result.layout;
}

function conversationPane(paneId, conversationId) {
  return {
    paneId,
    surface: {
      kind: "conversation",
      conversationId,
      project: { projectId: "project-main", projectPathKey: "/workspace/main" },
    },
    view: {},
  };
}

function terminalSession(id, overrides = {}) {
  return {
    id,
    projectPathKey: "/workspace/main",
    cwd: "/workspace/main",
    shell: "zsh",
    title: "Build",
    kind: "local",
    cols: 80,
    rows: 24,
    createdAt: 1,
    updatedAt: 1,
    running: true,
    ...overrides,
  };
}

const KNOWN_SURFACE_KINDS = new Set(["conversation", "localTerminal", "sshTerminal"]);

/**
 * Every object key reachable in a persisted payload, minus the two places
 * where keys are data rather than schema: the `panes` map is keyed by pane id,
 * and an unsupported surface's body is an opaque newer-build payload that this
 * build re-serializes verbatim.
 */
function collectKeys(value, options = {}) {
  const found = new Set();
  const walk = (node, { keysAreData = false, isSurface = false } = {}) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    // An unsupported surface persists as its original payload, which by
    // definition carries keys this build's schema does not know.
    const opaque =
      options.skipUnsupportedSurfaces &&
      (isSurface || node.kind === "unsupported") &&
      !KNOWN_SURFACE_KINDS.has(node.kind);
    for (const [key, child] of Object.entries(node)) {
      if (!keysAreData && !opaque) found.add(key);
      if (opaque) continue;
      walk(child, { keysAreData: key === "panes", isSurface: key === "surface" });
    }
  };
  walk(value);
  return found;
}

function encodedKeys(layout) {
  return collectKeys(JSON.parse(encodeWorkbenchLayout(layout)));
}

function assertAllowlisted(keys) {
  const extra = [...keys].filter((key) => !LAYOUT_KEY_ALLOWLIST.has(key));
  assert.deepEqual(extra, [], `persisted layout leaked non-allow-listed keys: ${extra.join(", ")}`);
}

function pollutedPaneRecord(paneId, conversationId) {
  return {
    paneId,
    // Pane-record level pollution.
    draft: "unsent private draft",
    messages: [{ role: "user", content: "secret" }],
    surface: {
      kind: "conversation",
      conversationId,
      // Surface level pollution, including the terminal handle that must
      // never leave sessionStorage.
      sessionId: "session-must-not-persist",
      apiKey: "sk-live-must-not-persist",
      token: "bearer-must-not-persist",
      prompt: "system prompt",
      attachments: ["/private/secret.pdf"],
      project: {
        projectId: "project-main",
        projectPathKey: "/workspace/main",
        accessToken: "must-not-persist",
      },
    },
    view: { compactChrome: true, transcript: ["leaked round"] },
  };
}
function pollutedLayout() {
  return {
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    revision: 4,
    root: {
      type: "split",
      splitId: "split-root",
      axis: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "pane-a" },
      second: { type: "leaf", paneId: "pane-b" },
      env: { HOME: "/Users/secret" },
    },
    panes: {
      "pane-a": pollutedPaneRecord("pane-a", "conversation-a"),
      "pane-b": pollutedPaneRecord("pane-b", "conversation-b"),
    },
    focusedPaneId: "pane-a",
    uploads: [{ relativePath: "uploads/secret.pdf" }],
  };
}

function threePaneLayout() {
  let layout = apply(createEmptyWorkbenchLayout(), {
    type: "OPEN_PANE",
    pane: conversationPane("pane-a", "conversation-a"),
    target: { kind: "canvas-empty" },
  });
  layout = apply(layout, {
    type: "OPEN_PANE",
    pane: {
      paneId: "pane-local",
      surface: terminalSurfaceForSession(terminalSession("session-local-1"), "surface-local-1", {
        projectId: "project-main",
        projectPathKey: "/workspace/main",
      }),
      view: {},
    },
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  layout = apply(layout, {
    type: "OPEN_PANE",
    pane: {
      paneId: "pane-ssh",
      surface: terminalSurfaceForSession(
        terminalSession("session-ssh-1", {
          kind: "ssh",
          cwd: "/workspace/main/deploy",
          ssh: {
            hostId: "host-1",
            hostName: "prod",
            username: "ops",
            host: "prod.example.com",
            port: 22,
            authType: "key",
            status: "connected",
            reconnectAttempt: 0,
            reconnectMaxAttempts: 3,
            sftpEnabled: true,
          },
        }),
        "surface-ssh-1",
        { projectId: "project-main", projectPathKey: "/workspace/main" },
      ),
      view: {},
    },
    target: { kind: "pane-edge", paneId: "pane-local", edge: "bottom" },
  });
  return layout;
}

test("a persisted production layout carries only allow-listed schema keys", () => {
  const layout = threePaneLayout();
  const keys = encodedKeys(layout);

  assertAllowlisted(keys);
  // The allow-list is only meaningful if the payload actually exercises every
  // surface family it is supposed to cover.
  for (const expected of ["conversationId", "surfaceId", "launchSpec", "sshHostId", "cwd"]) {
    assert.equal(keys.has(expected), true, `expected the fixture to persist '${expected}'`);
  }
});

test("terminal panes persist launch specs, never the live session handle", () => {
  const payload = encodeWorkbenchLayout(threePaneLayout());
  const keys = collectKeys(JSON.parse(payload));

  assert.equal(keys.has("sessionId"), false, "terminal sessionId must stay in sessionStorage");
  assert.equal(
    payload.includes("session-local-1"),
    false,
    "a local PTY session id must never appear in a persisted layout",
  );
  assert.equal(
    payload.includes("session-ssh-1"),
    false,
    "an ssh PTY session id must never appear in a persisted layout",
  );
});

test("decode drops every injected field from an untrusted persisted payload", () => {
  const raw = JSON.stringify(pollutedLayout());
  const decoded = decodeWorkbenchLayout(raw);

  assert.equal(decoded.ok, true);
  const keys = encodedKeys(decoded.layout);
  assertAllowlisted(keys);
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.has(forbidden), false, `decode must strip '${forbidden}'`);
  }

  const rehydrated = encodeWorkbenchLayout(decoded.layout);
  for (const secret of [
    "session-must-not-persist",
    "sk-live-must-not-persist",
    "bearer-must-not-persist",
    "unsent private draft",
    "/private/secret.pdf",
    "/Users/secret",
  ]) {
    assert.equal(rehydrated.includes(secret), false, `re-encoded layout leaked '${secret}'`);
  }
});

test("decoding a polluted payload still yields the clean, valid layout", () => {
  const decoded = decodeWorkbenchLayout(JSON.stringify(pollutedLayout()));

  assert.equal(decoded.ok, true);
  // Injected fields are not structural damage: dropping them is not a repair.
  assert.equal(decoded.repaired, false);
  assert.equal(isWorkbenchLayoutValid(decoded.layout), true);
  assert.deepEqual(decoded.layout, {
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    revision: 4,
    root: {
      type: "split",
      splitId: "split-root",
      axis: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "pane-a" },
      second: { type: "leaf", paneId: "pane-b" },
    },
    panes: {
      "pane-a": conversationPane("pane-a", "conversation-a"),
      "pane-b": conversationPane("pane-b", "conversation-b"),
    },
    focusedPaneId: "pane-a",
  });
});

test("a polluted layout is idempotent after one decode round-trip", () => {
  const first = decodeWorkbenchLayout(JSON.stringify(pollutedLayout()));
  assert.equal(first.ok, true);
  const second = decodeWorkbenchLayout(encodeWorkbenchLayout(first.layout));

  assert.equal(second.ok, true);
  assert.equal(second.repaired, false);
  assert.deepEqual(second.layout, first.layout);
});

test("encode strips injected fields: sanitation is a save boundary too", () => {
  // encodeWorkbenchLayout projects onto the schema field by field rather than
  // serializing the in-memory layout verbatim, so a pane record that somehow
  // picked up extra fields cannot reach SQLite / localStorage and sit there
  // until the next decode. The allow-list is enforced on save and on load.
  const encoded = JSON.parse(encodeWorkbenchLayout(pollutedLayout()));

  assertAllowlisted(collectKeys(encoded));
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(
      collectKeys(encoded).has(forbidden),
      false,
      `encode must strip '${forbidden}' rather than persist it`,
    );
  }
  assert.equal(encoded.panes["pane-a"].surface.apiKey, undefined);
  assert.deepEqual(Object.keys(encoded.panes["pane-a"]).sort(), ["paneId", "surface", "view"]);
  // Pollution nested below the pane record is dropped at every depth.
  assert.equal(encoded.panes["pane-a"].surface.project.accessToken, undefined);
  assert.equal(encoded.root.env, undefined);
  assert.equal(encoded.uploads, undefined);

  const payload = encodeWorkbenchLayout(pollutedLayout());
  for (const secret of [
    "session-must-not-persist",
    "sk-live-must-not-persist",
    "bearer-must-not-persist",
    "unsent private draft",
    "/private/secret.pdf",
    "/Users/secret",
  ]) {
    assert.equal(payload.includes(secret), false, `encoded layout leaked '${secret}'`);
  }

  // The schema-owned content still survives the projection intact.
  const sanitized = decodeWorkbenchLayout(payload);
  assert.equal(sanitized.ok, true);
  assertAllowlisted(encodedKeys(sanitized.layout));
  assert.equal(sanitized.layout.panes["pane-a"].surface.conversationId, "conversation-a");
});

test("an unsupported surface's opaque payload survives without widening the schema", () => {
  const raw = JSON.stringify({
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    revision: 1,
    root: { type: "leaf", paneId: "pane-future" },
    panes: {
      "pane-future": {
        paneId: "pane-future",
        surface: { kind: "notebook", notebookId: "nb-1", sessionId: "session-future" },
        view: {},
        draft: "leaked",
      },
    },
    focusedPaneId: "pane-future",
  });
  const decoded = decodeWorkbenchLayout(raw);

  assert.equal(decoded.ok, true);
  assert.equal(decoded.layout.panes["pane-future"].surface.kind, "unsupported");
  // The opaque payload is re-serialized verbatim in place of the surface, so
  // its own keys are deliberately outside the allow-list. Everything the
  // schema does own around it must still be clean: the pane-record pollution
  // is dropped even though the surface body is preserved.
  const encoded = JSON.parse(encodeWorkbenchLayout(decoded.layout));
  assertAllowlisted(collectKeys(encoded, { skipUnsupportedSurfaces: true }));
  assert.deepEqual(Object.keys(encoded.panes["pane-future"]).sort(), [
    "paneId",
    "surface",
    "view",
  ]);
  assert.deepEqual(decoded.layout.panes["pane-future"].surface.raw, {
    kind: "notebook",
    notebookId: "nb-1",
    sessionId: "session-future",
  });
});
