import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const workspaceProjects = loader.loadModule("@liveagent/ui/lib/workspaceProjects.ts");
const workspaceProjectRemoval = loader.loadModule(
  "@liveagent/ui/lib/workspaceProjectRemoval.ts",
);
const workspaceProjectRemovalHooks = createTsModuleLoader({
  mocks: {
    react: {
      useCallback(callback) {
        return callback;
      },
    },
  },
}).loadModule("@liveagent/ui/lib/workspaceProjectRemoval.ts");

function project(id, path, index) {
  return {
    id,
    name: id,
    path,
    kind: id === settings.DEFAULT_WORKSPACE_PROJECT_ID ? "managed" : "manual",
    createdAt: index,
    updatedAt: index,
  };
}

function withLastConversationAt(item, lastConversationAt) {
  return {
    ...item,
    lastConversationAt,
  };
}

function createRemovalActions({ visibleProjects, persistedProjects, beforeRemove }) {
  let currentSettings = settings.normalizeSettings({
    ...settings.getDefaultSettings(),
    system: {
      ...settings.getDefaultSettings().system,
      workspaceProjects: persistedProjects,
      activeWorkspaceProjectId: visibleProjects.at(-1)?.id,
    },
  });
  let errorMessage = null;
  let activeProjectId = currentSettings.system.activeWorkspaceProjectId;
  const actions = workspaceProjectRemovalHooks.useWorkspaceProjectSettingsActions({
    setSettings(updater) {
      currentSettings = updater(currentSettings);
    },
    workspaceProjects: visibleProjects,
    archivedWorkspaceProjectPathKeys: new Set(),
    activeWorkspaceProject: visibleProjects.find((item) => item.id === activeProjectId),
    activateWorkspaceProject() {},
    setActiveWorkspaceProjectId(updater) {
      activeProjectId = updater(activeProjectId);
    },
    t: (key) => key,
    setErrorMessage(message) {
      errorMessage = message;
    },
    beforeRemoveWorkspaceProject: beforeRemove,
  });
  return {
    actions,
    getSettings: () => currentSettings,
    getErrorMessage: () => errorMessage,
  };
}

test("workspace project path key normalizes windows-shaped paths and preserves POSIX semantics", () => {
  assert.equal(
    settings.workspaceProjectPathKey(" C:\\Users\\Me\\Repo\\ "),
    "c:/users/me/repo",
  );
  assert.equal(settings.workspaceProjectPathKey("c:/USERS/me/REPO"), "c:/users/me/repo");
  assert.equal(
    settings.workspaceProjectPathKey("\\\\Server\\Share\\Repo\\"),
    "//server/share/repo",
  );
  assert.equal(
    settings.workspaceProjectPathKey("\\\\?\\C:\\Users\\Me\\Repo\\"),
    "c:/users/me/repo",
  );
  assert.equal(
    settings.workspaceProjectPathKey("\\\\?\\UNC\\Server\\Share\\Repo\\"),
    "//server/share/repo",
  );
  assert.equal(settings.workspaceProjectPathKey(" /Users/A/App/ "), "/Users/A/App");
  assert.equal(settings.workspaceProjectPathKey("/tmp/Foo"), "/tmp/Foo");
  assert.equal(settings.workspaceProjectPathKey("/tmp/Foo\\"), "/tmp/Foo\\");
  assert.notEqual(
    settings.workspaceProjectPathKey("/tmp/Foo"),
    settings.workspaceProjectPathKey("/tmp/foo"),
  );
});

test("workspace project ordering follows latest activity instead of pinning default first", () => {
  const projects = [
    project(settings.DEFAULT_WORKSPACE_PROJECT_ID, "/tmp/default-project", 1),
    project("project-a", "/tmp/project-a", 2),
    project("project-b", "/tmp/project-b", 3),
  ];
  const activity = workspaceProjects.buildWorkspaceProjectActivityUpdatedAts([
    { path: "/tmp/default-project", updatedAt: 1_700_000_000_100 },
    { path: "/tmp/project-a", updatedAt: 1_700_000_000_300 },
    { path: "/tmp/project-b", updatedAt: 1_700_000_000_200 },
  ]);

  const ordered = workspaceProjects.sortWorkspaceProjectsByActivity(projects, {
    projectActivityUpdatedAts: activity,
  });

  assert.deepEqual(
    ordered.map((item) => item.id),
    ["project-a", "project-b", settings.DEFAULT_WORKSPACE_PROJECT_ID],
  );
});

test("workspace project keeps its active position after the running marker is cleared", () => {
  const projects = [
    project(settings.DEFAULT_WORKSPACE_PROJECT_ID, "/tmp/default-project", 1),
    project("project-a", "/tmp/project-a", 2),
  ];
  const projectAKey = settings.workspaceProjectPathKey("/tmp/project-a");
  const activity = workspaceProjects.buildWorkspaceProjectActivityUpdatedAts([
    { path: "/tmp/default-project", updatedAt: 1_700_000_000_100 },
    { path: "/tmp/project-a", updatedAt: 1_700_000_000_300 },
  ]);

  const duringRun = workspaceProjects.sortWorkspaceProjectsByActivity(projects, {
    projectActivityUpdatedAts: activity,
    runningProjectPathKeys: new Set([projectAKey]),
  });
  const afterRun = workspaceProjects.sortWorkspaceProjectsByActivity(projects, {
    projectActivityUpdatedAts: activity,
    runningProjectPathKeys: new Set(),
  });

  assert.deepEqual(
    duringRun.map((item) => item.id),
    ["project-a", settings.DEFAULT_WORKSPACE_PROJECT_ID],
  );
  assert.deepEqual(
    afterRun.map((item) => item.id),
    ["project-a", settings.DEFAULT_WORKSPACE_PROJECT_ID],
  );
});

test("running workspace project outranks a newer idle project", () => {
  const projects = [
    project(settings.DEFAULT_WORKSPACE_PROJECT_ID, "/tmp/default-project", 1),
    project("project-running", "/tmp/project-running", 2),
  ];
  const activity = workspaceProjects.buildWorkspaceProjectActivityUpdatedAts([
    { path: "/tmp/default-project", updatedAt: 1_700_000_000_900 },
    { path: "/tmp/project-running", updatedAt: 1_700_000_000_100 },
  ]);

  const ordered = workspaceProjects.sortWorkspaceProjectsByActivity(projects, {
    projectActivityUpdatedAts: activity,
    runningProjectPathKeys: new Set([
      settings.workspaceProjectPathKey("/tmp/project-running"),
    ]),
  });

  assert.deepEqual(
    ordered.map((item) => item.id),
    ["project-running", settings.DEFAULT_WORKSPACE_PROJECT_ID],
  );
});

test("pinned workspace project outranks running and newer projects", () => {
  const projects = [
    {
      ...project("project-pinned", "/tmp/project-pinned", 1),
      isPinned: true,
      pinnedAt: 1_700_000_000_100,
    },
    project("project-running", "/tmp/project-running", 2),
    project("project-newer", "/tmp/project-newer", 3),
  ];
  const activity = workspaceProjects.buildWorkspaceProjectActivityUpdatedAts([
    { path: "/tmp/project-pinned", updatedAt: 1_700_000_000_100 },
    { path: "/tmp/project-running", updatedAt: 1_700_000_000_200 },
    { path: "/tmp/project-newer", updatedAt: 1_700_000_000_900 },
  ]);

  const ordered = workspaceProjects.sortWorkspaceProjectsByActivity(projects, {
    projectActivityUpdatedAts: activity,
    runningProjectPathKeys: new Set([
      settings.workspaceProjectPathKey("/tmp/project-running"),
    ]),
  });

  assert.deepEqual(
    ordered.map((item) => item.id),
    ["project-pinned", "project-running", "project-newer"],
  );
});

test("workspace project selection metadata does not change activity ordering", () => {
  const projects = [
    project(settings.DEFAULT_WORKSPACE_PROJECT_ID, "/tmp/default-project", 1),
    {
      ...project("project-a", "/tmp/project-a", Date.now()),
      kind: "history",
    },
  ];

  const ordered = workspaceProjects.sortWorkspaceProjectsByActivity(projects);

  assert.deepEqual(
    ordered.map((item) => item.id),
    [settings.DEFAULT_WORKSPACE_PROJECT_ID, "project-a"],
  );
});

test("history workdir activity restores ordering after page refresh", () => {
  const projects = [
    project(settings.DEFAULT_WORKSPACE_PROJECT_ID, "/tmp/default-project", 1),
    project("project-a", "/tmp/project-a", 2),
  ];
  const hydrated = workspaceProjects.buildWorkspaceProjectActivityUpdatedAts([
    { path: "/tmp/default-project", updatedAt: 1_700_000_000_100 },
    { path: "/tmp/project-a", updatedAt: 1_700_000_000_500 },
  ]);

  const ordered = workspaceProjects.sortWorkspaceProjectsByActivity(projects, {
    projectActivityUpdatedAts: hydrated,
  });

  assert.deepEqual(
    ordered.map((item) => item.id),
    ["project-a", settings.DEFAULT_WORKSPACE_PROJECT_ID],
  );
});

test("persisted last conversation activity restores ordering before history workdirs hydrate", () => {
  const projects = [
    withLastConversationAt(
      project(settings.DEFAULT_WORKSPACE_PROJECT_ID, "/tmp/default-project", 1),
      1_700_000_000_100,
    ),
    withLastConversationAt(project("project-a", "/tmp/project-a", 2), 1_700_000_000_500),
  ];

  const ordered = workspaceProjects.sortWorkspaceProjectsByActivity(projects);

  assert.deepEqual(
    ordered.map((item) => item.id),
    ["project-a", settings.DEFAULT_WORKSPACE_PROJECT_ID],
  );
});

test("history merge stores conversation activity on configured and discovered projects", () => {
  const system = {
    ...settings.getDefaultSettings().system,
    workspaceProjects: [
      project(settings.DEFAULT_WORKSPACE_PROJECT_ID, "/tmp/default-project", 1),
      project("project-a", "/tmp/project-a", 2),
    ],
  };

  const merged = workspaceProjects.mergeWorkspaceProjectsWithHistory(system, [
    { path: "/tmp/project-a", conversationCount: 2, updatedAt: 1_700_000_000_500 },
    { path: "/tmp/project-b", conversationCount: 1, updatedAt: 1_700_000_000_600 },
  ]);

  assert.equal(
    merged.find((item) => item.id === "project-a")?.lastConversationAt,
    1_700_000_000_500,
  );
  assert.equal(
    merged.find((item) => item.path === "/tmp/project-b")?.lastConversationAt,
    1_700_000_000_600,
  );
});

test("archived paths survive resolveWorkspaceProjects normalization", () => {
  const resolved = settings.resolveWorkspaceProjects(
    {
      ...settings.getDefaultSettings().system,
      workspaceProjects: [
        project(settings.DEFAULT_WORKSPACE_PROJECT_ID, "/tmp/default-project", 1),
        project("project-a", "/tmp/project-a", 2),
        project("project-b", "/tmp/project-b", 3),
      ],
      archivedWorkspaceProjectPaths: [
        "/tmp/project-a",
        "/tmp/project-a/",
        " /tmp/default-project ",
      ],
    },
    "/tmp/default-project",
  );

  assert.deepEqual(resolved.archivedWorkspaceProjectPaths, [
    "/tmp/project-a",
    "/tmp/default-project",
  ]);
  assert.equal(resolved.activeWorkspaceProjectId, "project-b");
});

test("resolveWorkspaceProjects keeps one workspace selectable when every path is archived", () => {
  const resolved = settings.resolveWorkspaceProjects(
    {
      ...settings.getDefaultSettings().system,
      workspaceProjects: [
        project(settings.DEFAULT_WORKSPACE_PROJECT_ID, "/tmp/default-project", 1),
        project("project-a", "/tmp/project-a", 2),
      ],
      activeWorkspaceProjectId: "project-a",
      archivedWorkspaceProjectPaths: ["/tmp/default-project", "/tmp/project-a"],
    },
    "/tmp/default-project",
  );

  assert.equal(resolved.activeWorkspaceProjectId, settings.DEFAULT_WORKSPACE_PROJECT_ID);
  assert.deepEqual(resolved.archivedWorkspaceProjectPaths, ["/tmp/project-a"]);
});

test("removed (hidden) paths are dropped from the archived list", () => {
  const resolved = settings.resolveWorkspaceProjects(
    {
      ...settings.getDefaultSettings().system,
      workspaceProjects: [
        project(settings.DEFAULT_WORKSPACE_PROJECT_ID, "/tmp/default-project", 1),
      ],
      hiddenWorkspaceProjectPaths: ["/tmp/project-a"],
      archivedWorkspaceProjectPaths: ["/tmp/project-a", "/tmp/project-b"],
    },
    "/tmp/default-project",
  );

  assert.deepEqual(resolved.archivedWorkspaceProjectPaths, ["/tmp/project-b"]);
});

test("workspace project removal clears every path-scoped setting", () => {
  const removedProject = project("project-a", "/tmp/project-a", 2);
  const defaultProject = project(
    settings.DEFAULT_WORKSPACE_PROJECT_ID,
    "/tmp/default-project",
    1,
  );
  const previousSettings = settings.normalizeSettings({
    ...settings.getDefaultSettings(),
    system: {
      ...settings.getDefaultSettings().system,
      workspaceProjects: [defaultProject, removedProject],
      workspaceProjectGroups: [
        {
          id: "group-a",
          name: "Group A",
          projectPaths: ["/tmp/project-a", "/tmp/default-project"],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      missingWorkspaceProjectPaths: ["/tmp/project-a"],
      archivedWorkspaceProjectPaths: ["/tmp/project-a"],
      workspaceResourceSettings: {
        "/tmp/project-a": {
          mode: "custom",
          skillNames: ["skill-a"],
          mcpServerIds: ["mcp-a"],
          stateVersion: 1,
          writerId: "test",
          updatedAt: 1,
        },
      },
    },
    customSettings: {
      ...settings.getDefaultSettings().customSettings,
      rightDock: {
        projects: {
          "/tmp/project-a": {
            tabOrder: ["fileTree"],
            tools: { fileTree: { openedAt: 1 } },
            openVersion: 1,
            stateVersion: 1,
            writerId: "test",
            lastUsedAt: 1,
          },
        },
      },
    },
  });

  const next = workspaceProjectRemoval.removeWorkspaceProjectFromSettings(
    previousSettings,
    removedProject,
    [defaultProject, removedProject],
    new Set([settings.workspaceProjectPathKey(removedProject.path)]),
  );

  assert.deepEqual(next.system.workspaceProjects.map((item) => item.id), [
    settings.DEFAULT_WORKSPACE_PROJECT_ID,
  ]);
  assert.deepEqual(next.system.workspaceProjectGroups[0].projectPaths, [
    "/tmp/default-project",
  ]);
  assert.deepEqual(next.system.hiddenWorkspaceProjectPaths, ["/tmp/project-a"]);
  assert.deepEqual(next.system.missingWorkspaceProjectPaths, []);
  assert.deepEqual(next.system.archivedWorkspaceProjectPaths, []);
  assert.equal(next.system.workspaceResourceSettings["/tmp/project-a"].mode, "inherit");
  assert.deepEqual(next.customSettings.rightDock.projects["/tmp/project-a"].tools, {});
});

test("worktree removal revokes root grants before removing project settings", async () => {
  const defaultProject = project(
    settings.DEFAULT_WORKSPACE_PROJECT_ID,
    "/tmp/default-project",
    1,
  );
  const worktreeProject = {
    ...project("project-worktree", "/tmp/project-worktree", 2),
    kind: "worktree",
  };
  const revokedProjectIds = [];
  const harness = createRemovalActions({
    visibleProjects: [defaultProject, worktreeProject],
    persistedProjects: [defaultProject, worktreeProject],
    beforeRemove: async (removedProject) => {
      revokedProjectIds.push(removedProject.id);
    },
  });

  await harness.actions.handleWorktreeRemoved({ path: worktreeProject.path });

  assert.deepEqual(revokedProjectIds, [worktreeProject.id]);
  assert.deepEqual(
    harness.getSettings().system.workspaceProjects.map((item) => item.id),
    [settings.DEFAULT_WORKSPACE_PROJECT_ID],
  );
});

test("history project removal revokes stable project id even when it is not persisted", async () => {
  const defaultProject = project(
    settings.DEFAULT_WORKSPACE_PROJECT_ID,
    "/tmp/default-project",
    1,
  );
  const historyProject = {
    ...project("history-a1b2c3", "/tmp/history-project", 2),
    kind: "history",
  };
  const revokedProjectIds = [];
  const harness = createRemovalActions({
    visibleProjects: [defaultProject, historyProject],
    persistedProjects: [defaultProject],
    beforeRemove: async (removedProject) => {
      revokedProjectIds.push(removedProject.id);
    },
  });

  const removed = await harness.actions.removeWorkspaceProject(historyProject);

  assert.equal(removed, true);
  assert.deepEqual(revokedProjectIds, [historyProject.id]);
  assert.deepEqual(
    harness.getSettings().system.workspaceProjects.map((item) => item.id),
    [settings.DEFAULT_WORKSPACE_PROJECT_ID],
  );
  assert.deepEqual(harness.getSettings().system.hiddenWorkspaceProjectPaths, [historyProject.path]);
});

test("workspace project settings stay intact when root grant revocation fails", async () => {
  const defaultProject = project(
    settings.DEFAULT_WORKSPACE_PROJECT_ID,
    "/tmp/default-project",
    1,
  );
  const removableProject = project("project-a", "/tmp/project-a", 2);
  const harness = createRemovalActions({
    visibleProjects: [defaultProject, removableProject],
    persistedProjects: [defaultProject, removableProject],
    beforeRemove: async () => {
      throw new Error("revoke failed");
    },
  });

  const removed = await harness.actions.removeWorkspaceProject(removableProject);

  assert.equal(removed, false);
  assert.equal(harness.getErrorMessage(), "revoke failed");
  assert.deepEqual(
    harness.getSettings().system.workspaceProjects.map((item) => item.id),
    [settings.DEFAULT_WORKSPACE_PROJECT_ID, removableProject.id],
  );
});

test("workspace project removal resets matching active project aliases", () => {
  const removedProject = project("project-a", "C:\\Repo", 2);
  const aliasProject = project("project-alias", "c:/repo/", 3);
  const projects = [removedProject, aliasProject];

  assert.equal(
    workspaceProjectRemoval.resolveActiveWorkspaceProjectIdAfterRemoval(
      aliasProject.id,
      removedProject,
      projects,
    ),
    settings.DEFAULT_WORKSPACE_PROJECT_ID,
  );
  assert.equal(
    workspaceProjectRemoval.resolveActiveWorkspaceProjectIdAfterRemoval(
      "unrelated",
      removedProject,
      projects,
    ),
    "unrelated",
  );
});

test("workspace project lookup matches normalized paths and rejects empty paths", () => {
  const windowsProject = project("project-a", "C:\\Repo", 2);
  const posixProject = project("project-b", "/tmp/project-b", 3);
  const projects = [windowsProject, posixProject];

  assert.equal(
    workspaceProjectRemoval.findWorkspaceProjectByPath(projects, " c:/repo/ "),
    windowsProject,
  );
  assert.equal(
    workspaceProjectRemoval.findWorkspaceProjectByPath(projects, "/tmp/project-b/"),
    posixProject,
  );
  assert.equal(workspaceProjectRemoval.findWorkspaceProjectByPath(projects, "  "), undefined);
  assert.equal(
    workspaceProjectRemoval.findWorkspaceProjectByPath(projects, "/tmp/missing"),
    undefined,
  );
});

test("workspace project archive resolves an active fallback and matches path aliases", () => {
  const archivedProject = project("project-a", "C:\\Repo", 2);
  const aliasProject = project("project-alias", "c:/repo/", 3);
  const fallbackProject = project("project-b", "C:\\Other", 4);

  assert.equal(
    workspaceProjectRemoval.workspaceProjectsMatch(aliasProject, archivedProject),
    true,
  );
  assert.equal(
    workspaceProjectRemoval.findWorkspaceProjectArchiveFallback(
      archivedProject,
      [archivedProject, aliasProject, fallbackProject],
      new Set(),
    ),
    fallbackProject,
  );
  assert.equal(
    workspaceProjectRemoval.findWorkspaceProjectArchiveFallback(
      archivedProject,
      [archivedProject, aliasProject],
      new Set(),
    ),
    undefined,
  );
});

test("workspace project archive and unarchive settings updates are idempotent", () => {
  const archivedProject = project("project-a", " C:\\Repo\\ ", 2);
  const previousSettings = settings.getDefaultSettings();
  const archived = workspaceProjectRemoval.archiveWorkspaceProjectInSettings(
    previousSettings,
    archivedProject,
  );

  assert.deepEqual(archived.system.archivedWorkspaceProjectPaths, ["C:\\Repo\\"]);
  assert.equal(
    workspaceProjectRemoval.archiveWorkspaceProjectInSettings(
      archived,
      project("project-alias", "c:/repo", 3),
    ),
    archived,
  );

  const unarchived = workspaceProjectRemoval.unarchiveWorkspaceProjectInSettings(
    archived,
    project("project-alias", "c:/repo", 3),
  );
  assert.deepEqual(unarchived.system.archivedWorkspaceProjectPaths, []);
  assert.equal(
    workspaceProjectRemoval.unarchiveWorkspaceProjectInSettings(unarchived, archivedProject),
    unarchived,
  );
});

test("conversation activity persistence does not rewrite project metadata ordering", () => {
  const projects = [
    project(settings.DEFAULT_WORKSPACE_PROJECT_ID, "/tmp/default-project", 1),
    project("project-a", "/tmp/project-a", 2),
  ];
  const activity = workspaceProjects.buildWorkspaceProjectActivityUpdatedAts([
    { path: "/tmp/project-a", updatedAt: 1_700_000_000_900 },
  ]);

  const next = workspaceProjects.applyWorkspaceProjectConversationActivityMap(
    projects,
    activity,
  );

  assert.deepEqual(
    next.map((item) => item.id),
    [settings.DEFAULT_WORKSPACE_PROJECT_ID, "project-a"],
  );
  assert.equal(next[1].updatedAt, 2);
  assert.equal(next[1].lastConversationAt, 1_700_000_000_900);
});

test("live activity overrides stale persisted last conversation activity", () => {
  const projects = [
    withLastConversationAt(
      project(settings.DEFAULT_WORKSPACE_PROJECT_ID, "/tmp/default-project", 1),
      1_700_000_000_500,
    ),
    withLastConversationAt(project("project-a", "/tmp/project-a", 2), 1_700_000_000_100),
  ];
  const activity = workspaceProjects.buildWorkspaceProjectActivityUpdatedAts([
    { path: "/tmp/project-a", updatedAt: 1_700_000_000_900 },
  ]);

  const ordered = workspaceProjects.sortWorkspaceProjectsByActivity(projects, {
    projectActivityUpdatedAts: activity,
  });

  assert.deepEqual(
    ordered.map((item) => item.id),
    ["project-a", settings.DEFAULT_WORKSPACE_PROJECT_ID],
  );
});

test("workspace project activity merge keeps newer timestamps", () => {
  const newerActivity = workspaceProjects.buildWorkspaceProjectActivityUpdatedAts([
    { path: "/tmp/project-a", updatedAt: 1_700_000_000_900 },
  ]);
  const olderActivity = workspaceProjects.buildWorkspaceProjectActivityUpdatedAts([
    { path: "/tmp/project-a", updatedAt: 1_700_000_000_100 },
    { path: "/tmp/project-b", updatedAt: 1_700_000_000_200 },
  ]);

  const merged = workspaceProjects.mergeWorkspaceProjectActivityUpdatedAts(
    newerActivity,
    olderActivity,
  );

  assert.equal(
    merged.get(settings.workspaceProjectPathKey("/tmp/project-a")),
    1_700_000_000_900,
  );
  assert.equal(
    merged.get(settings.workspaceProjectPathKey("/tmp/project-b")),
    1_700_000_000_200,
  );
});

test("workspace project ordering uses deterministic path tie breaker", () => {
  const projects = [
    project("project-b", "/tmp/project-b", 1),
    project(settings.DEFAULT_WORKSPACE_PROJECT_ID, "/tmp/default-project", 2),
    project("project-a", "/tmp/project-a", 3),
  ];

  const ordered = workspaceProjects.sortWorkspaceProjectsByActivity(projects);

  assert.deepEqual(
    ordered.map((item) => item.id),
    [settings.DEFAULT_WORKSPACE_PROJECT_ID, "project-a", "project-b"],
  );
});
