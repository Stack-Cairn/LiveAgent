import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { reorderSidebarProjects } = loader.loadModule("@liveagent/ui/lib/sidebar/preferences.ts");
const { sortWorkspaceProjectsByActivity } = loader.loadModule("@liveagent/ui/lib/workspaceProjects.ts");
const { getDefaultSettings, normalizeSettings } = loader.loadModule("@liveagent/ui/lib/settings/index.ts");
const { buildGatewaySettingsSyncPayload, applyGatewaySettingsSyncPayload } = loader.loadModule("@liveagent/ui/lib/settings/sync.ts");
const { listPinnedSidebarConversations } = loader.loadModule("@liveagent/ui/lib/sidebar/pinnedHistory.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const project = (id, overrides = {}) => ({ id, name: id, path: `/projects/${id}`, kind: "folder", createdAt: 1, updatedAt: 1, ...overrides });

test("dragging changes the persisted order and new activity does not override it", () => {
  const projects = [project("a"), project("b"), project("c")];
  const order = reorderSidebarProjects(projects, "c", "a", "before");
  const settings = normalizeSettings({ ...getDefaultSettings(), system: { ...getDefaultSettings().system, workspaceProjectOrder: order } });
  const sorted = sortWorkspaceProjectsByActivity(projects, { projectOrder: settings.system.workspaceProjectOrder, projectActivityUpdatedAts: new Map([["/projects/b", 999999]]), runningProjectPathKeys: new Set(["/projects/b"]) });
  assert.deepEqual(plain(sorted.map((item) => item.id)), ["c", "a", "b"]);
  assert.deepEqual(plain(reorderSidebarProjects(sorted, "c", "b", "after")), ["/projects/a", "/projects/b", "/projects/c"]);
});

test("dragging does not implicitly pin or unpin workspaces", () => {
  const projects = [project("p", { isPinned: true }), project("a")];
  assert.equal(reorderSidebarProjects(projects, "a", "p", "before"), null);
  assert.equal(reorderSidebarProjects(projects, "missing", "a", "after"), null);
  assert.equal(reorderSidebarProjects(projects, "a", "a", "after"), null);
});

test("normalization drops retired conversation archives and preserves workspace archives", () => {
  const settings = normalizeSettings({ system: {
    archivedConversations: [{ id: "old", title: "Previously archived", cwd: "/one" }],
    archivedWorkspaceProjectPaths: ["/workspace-archive"],
    workspaceProjectOrder: [" /one/ ", "/one", null],
  } });
  assert.equal(Object.hasOwn(settings.system, "archivedConversations"), false);
  assert.deepEqual(plain(settings.system.archivedWorkspaceProjectPaths), ["/workspace-archive"]);
  assert.deepEqual(plain(settings.system.workspaceProjectOrder), ["/one"]);
});

test("global pinned history reads subsequent pages and stops at the first ordinary row", async () => {
  const calls = [];
  const result = await listPinnedSidebarConversations(async (page, pageSize) => {
    calls.push([page, pageSize]);
    return { items: page === 1 ? Array.from({ length: 200 }, (_, i) => ({ id: String(i), isPinned: true })) : [{ id: "last", isPinned: true }, { id: "ordinary", isPinned: false }], totalCount: 10000 };
  });
  assert.equal(result.length, 201);
  assert.deepEqual(calls, [[1, 200], [2, 200]]);
});


test("manual ordering survives gateway settings synchronization", () => {
  const settings = getDefaultSettings();
  settings.system.workspaceProjectOrder = ["/b", "/a"];
  const payload = buildGatewaySettingsSyncPayload(settings);
  const received = applyGatewaySettingsSyncPayload(getDefaultSettings(), plain(payload));
  assert.deepEqual(plain(received.system.workspaceProjectOrder), ["/b", "/a"]);
});

test("pinned conversations and workspaces share one persistent ordering", () => {
  const { buildSidebarPinnedEntries, reorderSidebarPinnedEntries } = loader.loadModule("@liveagent/ui/lib/sidebar/preferences.ts");
  const conversations = [{ id: "one" }, { id: "two" }];
  const workspaces = [{ id: "a", path: "/a" }, { id: "b", path: "/b" }];
  const entries = buildSidebarPinnedEntries(conversations, workspaces);
  const order = reorderSidebarPinnedEntries(entries, "workspace:/b", "conversation:two", "before");
  assert.deepEqual(plain(order), ["conversation:one", "workspace:/b", "conversation:two", "workspace:/a"]);
  const settings = normalizeSettings({ ...getDefaultSettings(), system: { ...getDefaultSettings().system, sidebarPinnedOrder: order } });
  const restored = buildSidebarPinnedEntries(conversations, workspaces, settings.system.sidebarPinnedOrder);
  assert.deepEqual(plain(restored.map((entry) => entry.key)), plain(order));
  assert.deepEqual(plain(reorderSidebarPinnedEntries(restored, "conversation:one", "workspace:/a", "after")),
    ["workspace:/b", "conversation:two", "workspace:/a", "conversation:one"]);
  assert.equal(reorderSidebarPinnedEntries(restored, "missing", "workspace:/a", "after"), null);
  assert.equal(reorderSidebarPinnedEntries(restored, "workspace:/a", "workspace:/a", "after"), null);
});
