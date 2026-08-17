import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 不变量:「focusedPane → activeProject → dock 数据源」的解析
// (docs/design/session-workbench-multi-conversation-implementation-task.md §7.4,
//  session-workbench-remaining-work.md §四)。聚焦 Pane 携带的 projectPathKey
// 只在指向一个已知、非 archived、非 missing 的工作区项目时才切换 Right Dock;
// 陈旧/合成 key 绝不回退到别的项目。

const { loadModule } = createTsModuleLoader();
const { resolveWorkbenchPaneProject } = loadModule("src/pages/chat/workbench/paneProjectContext.ts");
const { workspaceProjectPathKey } = loadModule("src/lib/settings/index.ts");

function project(id, path) {
  return {
    id,
    name: id,
    path,
    kind: "folder",
    createdAt: 0,
    updatedAt: 0,
  };
}

const alpha = project("alpha", "/workspaces/alpha");
const beta = project("beta", "/workspaces/beta");

function context(overrides = {}) {
  return {
    workspaceProjects: [alpha, beta],
    archivedWorkspaceProjectPathKeys: new Set(),
    missingWorkspaceProjectPathKeys: new Set(),
    ...overrides,
  };
}

const alphaKey = workspaceProjectPathKey(alpha.path);

test("a live project's path key resolves to that project", () => {
  assert.equal(resolveWorkbenchPaneProject(alphaKey, context()), alpha);
});

test("an undefined or empty key resolves to nothing", () => {
  assert.equal(resolveWorkbenchPaneProject(undefined, context()), null);
  assert.equal(resolveWorkbenchPaneProject("", context()), null);
});

test("an archived project never activates", () => {
  const resolved = resolveWorkbenchPaneProject(
    alphaKey,
    context({ archivedWorkspaceProjectPathKeys: new Set([alphaKey]) }),
  );
  assert.equal(resolved, null);
});

test("a missing project never activates", () => {
  const resolved = resolveWorkbenchPaneProject(
    alphaKey,
    context({ missingWorkspaceProjectPathKeys: new Set([alphaKey]) }),
  );
  assert.equal(resolved, null);
});

test("a stale key never falls back to a different project", () => {
  // 合成 key(conversation:xxx)与已删除项目的 key 都必须落空,而不是
  // 挑一个"最接近"的项目顶上。
  assert.equal(resolveWorkbenchPaneProject("conversation:c1", context()), null);
  assert.equal(
    resolveWorkbenchPaneProject(workspaceProjectPathKey("/workspaces/deleted"), context()),
    null,
  );
});

test("matching runs on normalized path keys, same key space as blocked checks", () => {
  // 项目路径带尾斜杠时,存储的 path 与 pane 携带的 key 仍按同一规范化匹配。
  const trailing = project("gamma", "/workspaces/gamma/");
  const resolved = resolveWorkbenchPaneProject(
    workspaceProjectPathKey("/workspaces/gamma"),
    context({ workspaceProjects: [trailing] }),
  );
  assert.equal(resolved, trailing);
});

test("ChatPage routes pane project activation through the resolver", () => {
  const source = readFileSync(new URL("../../src/pages/ChatPage.tsx", import.meta.url), "utf8");
  assert.match(source, /resolveWorkbenchPaneProject\(projectPathKey, \{/);
  // 旧的内联 find + set 判定不应回潮:解析必须只有资源器这一处。
  assert.equal(
    source.includes("!archivedWorkspaceProjectPathKeys.has(projectPathKey)"),
    false,
    "inline archived/missing checks must stay inside resolveWorkbenchPaneProject",
  );
});
