import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const workspaceProjects = loader.loadModule("src/lib/workspaceProjects.ts");

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
