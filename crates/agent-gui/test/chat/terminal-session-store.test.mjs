import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// applyTerminalEventToSessions 的合并语义。核心不变量:除 created 外,任何
// 事件都不得把未知 sessionId 追加进列表——close() 与 PTY reader 线程存在
// 竞态,迟到的 exit 可能在 closed 之后送达,照单追加会把刚关闭的会话复活
// 成幽灵(dock 冒出 attach 必败的 tab,即"创建→关闭→terminal session
// not found"的现场)。

const loader = createTsModuleLoader();
const { applyTerminalEventToSessions } = loader.loadModule(
  "../agent-ui/src/lib/terminal/sessionStore.ts",
);

function session(id, overrides = {}) {
  return {
    id,
    projectPathKey: "/repo",
    cwd: "/repo",
    shell: "zsh",
    title: id,
    kind: "local",
    cols: 80,
    rows: 24,
    createdAt: 1,
    updatedAt: 1,
    running: true,
    ...overrides,
  };
}

test("closed removes the session; a late exit for the same id does not resurrect it", () => {
  const initial = [session("s-1"), session("s-2")];
  const afterClosed = applyTerminalEventToSessions(initial, {
    kind: "closed",
    sessionId: "s-1",
    projectPathKey: "/repo",
  });
  assert.deepEqual(
    afterClosed.map((entry) => entry.id),
    ["s-2"],
  );
  // reader 线程输掉竞态后补发的 exit:带完整 session 记录、id 已不在列表。
  const afterLateExit = applyTerminalEventToSessions(afterClosed, {
    kind: "exit",
    sessionId: "s-1",
    projectPathKey: "/repo",
    session: session("s-1", { running: false, exitCode: 0 }),
  });
  assert.deepEqual(
    afterLateExit.map((entry) => entry.id),
    ["s-2"],
    "late exit resurrected the closed session",
  );
});

test("only created appends an unknown session", () => {
  const initial = [session("s-1")];
  for (const kind of ["exit", "resized", "renamed", "reconnecting", "reconnected"]) {
    const next = applyTerminalEventToSessions(initial, {
      kind,
      sessionId: "s-9",
      projectPathKey: "/repo",
      session: session("s-9"),
    });
    assert.deepEqual(
      next.map((entry) => entry.id),
      ["s-1"],
      `${kind} appended an unknown session`,
    );
  }
  const created = applyTerminalEventToSessions(initial, {
    kind: "created",
    sessionId: "s-2",
    projectPathKey: "/repo",
    session: session("s-2"),
  });
  assert.deepEqual(
    created.map((entry) => entry.id).sort(),
    ["s-1", "s-2"],
  );
});

test("known sessions still merge updates from any event kind", () => {
  const initial = [session("s-1")];
  const next = applyTerminalEventToSessions(initial, {
    kind: "exit",
    sessionId: "s-1",
    projectPathKey: "/repo",
    session: session("s-1", { running: false, exitCode: 1 }),
  });
  assert.equal(next.length, 1);
  assert.equal(next[0].running, false);
  assert.equal(next[0].exitCode, 1);
});

test("output events never mutate membership", () => {
  const initial = [session("s-1")];
  const next = applyTerminalEventToSessions(initial, {
    kind: "output",
    sessionId: "s-9",
    projectPathKey: "/repo",
    session: session("s-9"),
  });
  assert.deepEqual(
    next.map((entry) => entry.id),
    ["s-1"],
  );
});
