import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const {
  applyTerminalEventToSessions,
  replaceTerminalSessionsForProject,
  terminalSessionBelongsToProject,
} = loader.loadModule("@liveagent/ui/lib/terminal/sessionStore.ts");

function terminal(id, projectPathKey, createdAt, title = id) {
  return {
    id,
    projectPathKey,
    cwd: projectPathKey,
    shell: "zsh",
    title,
    cols: 80,
    rows: 24,
    createdAt,
    updatedAt: createdAt,
    running: true,
  };
}

test("terminal project replacement only touches the requested project", () => {
  const current = [
    terminal("terminal-a-1", "/workspace/a", 1),
    terminal("terminal-b-1", "/workspace/b", 2),
  ];

  const next = replaceTerminalSessionsForProject(current, " /workspace/a ", [
    terminal("terminal-a-2", "/workspace/a", 3),
    terminal("terminal-b-2", "/workspace/b", 4),
  ]);

  assert.deepEqual(
    next.map((session) => session.id),
    ["terminal-a-2", "terminal-b-1"],
  );
});

test("terminal event merge preserves refreshed sessions and adds created terminals", () => {
  const bootstrapped = replaceTerminalSessionsForProject([], "/workspace/project", [
    terminal("terminal-1", "/workspace/project", 1, "Terminal 1"),
    terminal("terminal-2", "/workspace/project", 2, "Terminal 2"),
    terminal("terminal-3", "/workspace/project", 3, "Terminal 3"),
  ]);

  const withCreated = applyTerminalEventToSessions(bootstrapped, {
    kind: "created",
    sessionId: "terminal-4",
    projectPathKey: "/workspace/project",
    session: terminal("terminal-4", "/workspace/project", 4, "Terminal 4"),
  });

  assert.deepEqual(
    withCreated.map((session) => session.title),
    ["Terminal 1", "Terminal 2", "Terminal 3", "Terminal 4"],
  );
});

test("terminal project matching falls back to cwd when project key is missing", () => {
  assert.equal(
    terminalSessionBelongsToProject(
      {
        ...terminal("terminal-1", "", 1),
        cwd: "/workspace/project",
      },
      "/workspace/project",
    ),
    true,
  );
});

test("terminal project matching normalizes Windows-shaped project keys", () => {
  assert.equal(
    terminalSessionBelongsToProject(terminal("terminal-1", "C:\\Repo", 1), "c:/repo/"),
    true,
  );
  assert.deepEqual(
    replaceTerminalSessionsForProject(
      [terminal("old", "C:\\Repo", 1), terminal("other", "/tmp/Foo", 2)],
      "c:/repo",
      [terminal("new", "c:/repo", 3)],
    ).map((session) => session.id),
    ["other", "new"],
  );
  assert.equal(
    terminalSessionBelongsToProject(terminal("terminal-2", "/tmp/Foo", 1), "/tmp/foo"),
    false,
  );
});

// --- XTermViewport chunk bookkeeping (gap / reset handling) ---
// These cases exercise the viewport's writeTerminalChunk rather than the
// session store above: the reconnect-gap "reset & replay" contract lives in
// the viewport, and this is the terminal-focused suite that loads web modules.

const viewportLoader = createWebModuleLoader({
  mocks: {
    "@xterm/xterm/css/xterm.css": {},
    "@xterm/xterm": { Terminal: class Terminal {} },
    "@xterm/addon-fit": { FitAddon: class FitAddon {} },
  },
});
const { writeTerminalChunk } = viewportLoader.loadModule(
  "@liveagent/ui/components/project-tools/XTermViewport.tsx",
);

function fakeTerm() {
  const calls = [];
  return {
    calls,
    write(data) {
      calls.push(["write", Uint8Array.from(data)]);
    },
    reset() {
      calls.push(["reset"]);
    },
  };
}

function chunk(bytes, startOffset, endOffset) {
  return {
    sessionId: "terminal-1",
    projectPathKey: "/workspace/project",
    bytes: Uint8Array.from(bytes),
    startOffset,
    endOffset,
  };
}

test("terminal chunk overlapping the rendered offset is trimmed before writing", () => {
  const term = fakeTerm();
  let offset = 10;
  const result = writeTerminalChunk(
    term,
    chunk([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5, 15),
    (next) => {
      offset = next;
    },
    offset,
  );
  assert.equal(result, "written");
  assert.equal(offset, 15);
  assert.deepEqual(term.calls, [["write", Uint8Array.from([6, 7, 8, 9, 10])]]);
});

test("terminal chunk entirely behind the rendered offset is skipped", () => {
  const term = fakeTerm();
  let offset = 20;
  const result = writeTerminalChunk(
    term,
    chunk([1, 2, 3], 10, 13),
    (next) => {
      offset = next;
    },
    offset,
  );
  assert.equal(result, "skipped");
  assert.equal(offset, 20);
  assert.deepEqual(term.calls, []);
});

test("terminal chunk after a gap resets the terminal and replays the chunk", () => {
  const term = fakeTerm();
  let offset = 10;
  const result = writeTerminalChunk(
    term,
    chunk([7, 8, 9], 20, 23),
    (next) => {
      offset = next;
    },
    offset,
  );
  assert.equal(result, "reset");
  assert.equal(offset, 23);
  assert.deepEqual(term.calls, [["reset"], ["write", Uint8Array.from([7, 8, 9])]]);
});

test("terminal chunk without offsets appends and advances by byte length", () => {
  const term = fakeTerm();
  let offset = 4;
  const result = writeTerminalChunk(
    term,
    {
      sessionId: "terminal-1",
      projectPathKey: "/workspace/project",
      bytes: Uint8Array.from([1, 2]),
      startOffset: undefined,
      endOffset: undefined,
    },
    (next) => {
      offset = next;
    },
    offset,
  );
  assert.equal(result, "written");
  assert.equal(offset, 6);
  assert.deepEqual(term.calls, [["write", Uint8Array.from([1, 2])]]);
});
