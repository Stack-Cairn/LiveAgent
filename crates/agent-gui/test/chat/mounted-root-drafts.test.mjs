import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { buildMountedRootDrafts } = loader.loadModule(
  "../agent-ui/src/lib/chat/mountedRootDrafts.ts",
);

const grant = (overrides = {}) => ({
  id: "grant-1",
  alias: "docs",
  displayPath: "/data/docs",
  access: "read",
  state: "active",
  ...overrides,
});

test("dropped folders append read-only drafts after the existing grants", () => {
  const result = buildMountedRootDrafts({
    projectPath: "/work/project",
    existingGrants: [grant()],
    folderPaths: ["/data/specs/"],
    now: 1000,
  });

  assert.deepEqual(result.addedPaths, ["/data/specs"]);
  assert.deepEqual(result.drafts, [
    { id: "grant-1", alias: "docs", displayPath: "/data/docs", access: "read" },
    { id: "draft-1000-1", alias: "specs", displayPath: "/data/specs", access: "read" },
  ]);
});

test("folders inside the active workspace are skipped instead of failing the batch", () => {
  const result = buildMountedRootDrafts({
    projectPath: "/work/project",
    existingGrants: [],
    folderPaths: ["/work/project/src", "/work/project", "/data/refs"],
    now: 1000,
  });

  assert.deepEqual(result.skippedInsideWorkspace, ["/work/project/src", "/work/project"]);
  assert.deepEqual(result.addedPaths, ["/data/refs"]);
});

test("folders overlapping existing or just-added grants are skipped", () => {
  const result = buildMountedRootDrafts({
    projectPath: "/work/project",
    existingGrants: [grant()],
    folderPaths: ["/data/docs/api", "/data", "/srv/shared", "/srv/shared/lib"],
    now: 1000,
  });

  assert.deepEqual(result.skippedOverlapping, ["/data/docs/api", "/data", "/srv/shared/lib"]);
  assert.deepEqual(result.addedPaths, ["/srv/shared"]);
});

test("aliases stay unique against existing grants", () => {
  const result = buildMountedRootDrafts({
    projectPath: "/work/project",
    existingGrants: [grant({ alias: "specs", displayPath: "/data/other-specs" })],
    folderPaths: ["/data/specs"],
    now: 1000,
  });

  assert.equal(result.drafts.at(-1)?.alias, "specs-2");
});

test("a sibling path sharing the workspace name prefix is not treated as inside it", () => {
  const result = buildMountedRootDrafts({
    projectPath: "/work/project",
    existingGrants: [],
    folderPaths: ["/work/project-docs"],
    now: 1000,
  });

  assert.deepEqual(result.addedPaths, ["/work/project-docs"]);
  assert.deepEqual(result.skippedInsideWorkspace, []);
});
