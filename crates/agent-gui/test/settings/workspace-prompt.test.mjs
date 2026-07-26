import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const workspacePrompt = loader.loadModule("src/lib/workspace-prompt/config.ts");

function baseProject(overrides = {}) {
  return {
    id: "project-1",
    name: "Project One",
    path: "C:\\work\\repo",
    kind: "folder",
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function resolveSystem(rawProjects) {
  return settings.resolveWorkspaceProjects(
    {
      workdir: "C:\\work\\default",
      workspaceProjects: rawProjects,
      hiddenWorkspaceProjectPaths: [],
      missingWorkspaceProjectPaths: [],
      archivedWorkspaceProjectPaths: [],
    },
    "C:\\work\\default",
  );
}

function findByPathKey(resolved, path) {
  const key = settings.workspaceProjectPathKey(path);
  return resolved.workspaceProjects.find(
    (project) => settings.workspaceProjectPathKey(project.path) === key,
  );
}

test("normalize keeps workspace prompt fields and trims the prompt", () => {
  const resolved = resolveSystem([
    baseProject({
      prompt: "  Focus on Rust code.  ",
      includeGlobalPrompt: false,
      includeProjectInstructions: true,
    }),
  ]);
  const project = findByPathKey(resolved, "C:\\work\\repo");
  assert.equal(project.prompt, "Focus on Rust code.");
  assert.equal(project.includeGlobalPrompt, false);
  assert.equal(project.includeProjectInstructions, true);
});

test("normalize drops default-valued and malformed workspace prompt fields", () => {
  const resolved = resolveSystem([
    baseProject({
      prompt: "   ",
      includeGlobalPrompt: true,
      includeProjectInstructions: false,
    }),
    baseProject({
      id: "project-2",
      path: "C:\\work\\other",
      prompt: 42,
      includeGlobalPrompt: "no",
      includeProjectInstructions: "yes",
    }),
  ]);
  for (const path of ["C:\\work\\repo", "C:\\work\\other"]) {
    const project = findByPathKey(resolved, path);
    assert.equal("prompt" in project, false);
    assert.equal("includeGlobalPrompt" in project, false);
    assert.equal("includeProjectInstructions" in project, false);
  }
});

test("workspace prompt fields survive a settings round-trip", () => {
  const first = resolveSystem([
    baseProject({ prompt: "Prompt A", includeGlobalPrompt: false }),
  ]);
  const second = resolveSystem(first.workspaceProjects);
  const project = findByPathKey(second, "C:\\work\\repo");
  assert.equal(project.prompt, "Prompt A");
  assert.equal(project.includeGlobalPrompt, false);
  assert.equal("includeProjectInstructions" in project, false);
});

test("resolveWorkspacePromptConfig returns defaults for unknown or empty paths", () => {
  const projects = [baseProject()];
  assert.deepEqual(workspacePrompt.resolveWorkspacePromptConfig(projects, ""), {
    prompt: "",
    includeGlobalPrompt: true,
    includeProjectInstructions: false,
  });
  assert.deepEqual(
    workspacePrompt.resolveWorkspacePromptConfig(projects, "D:\\somewhere\\else"),
    workspacePrompt.DEFAULT_WORKSPACE_PROMPT_CONFIG,
  );
});

test("resolveWorkspacePromptConfig matches workdirs across path spellings", () => {
  const projects = [
    baseProject({
      prompt: "Workspace prompt",
      includeGlobalPrompt: false,
      includeProjectInstructions: true,
    }),
  ];
  for (const workdir of ["C:\\work\\repo", "c:/WORK/repo/", "C:\\work\\repo\\"]) {
    const config = workspacePrompt.resolveWorkspacePromptConfig(projects, workdir);
    assert.deepEqual(config, {
      prompt: "Workspace prompt",
      includeGlobalPrompt: false,
      includeProjectInstructions: true,
    });
  }
});

test("composeAgentPrompt layers global, workspace, and instruction prompts", () => {
  const composed = workspacePrompt.composeAgentPrompt({
    globalPrompt: "  global  ",
    workspacePrompt: "workspace",
    projectInstructions: { fileName: "CLAUDE.md", content: "instructions" },
  });
  const [globalPart, workspacePart, instructionsPart] = composed.split("\n\n");
  assert.equal(globalPart, "global");
  assert.equal(workspacePart, "workspace");
  assert.match(instructionsPart, /CLAUDE\.md/);
  assert.match(instructionsPart, /instructions/);
});

test("composeAgentPrompt skips empty layers", () => {
  assert.equal(workspacePrompt.composeAgentPrompt({}), "");
  assert.equal(
    workspacePrompt.composeAgentPrompt({
      globalPrompt: "",
      workspacePrompt: "only workspace",
      projectInstructions: null,
    }),
    "only workspace",
  );
  assert.equal(
    workspacePrompt.composeAgentPrompt({
      projectInstructions: { fileName: "AGENTS.md", content: "   " },
    }),
    "",
  );
});

test("project instructions are truncated beyond the size cap", () => {
  const oversized = "x".repeat(workspacePrompt.PROJECT_INSTRUCTIONS_MAX_CHARS + 100);
  const truncated = workspacePrompt.truncateProjectInstructions(oversized);
  assert.equal(
    truncated.length,
    workspacePrompt.PROJECT_INSTRUCTIONS_MAX_CHARS + "\n[content truncated]".length,
  );
  assert.match(truncated, /\[content truncated\]$/);
  assert.equal(workspacePrompt.truncateProjectInstructions("  short  "), "short");
});

test("workspace prompt import accepts common text extensions", () => {
  for (const name of ["notes.md", "README.markdown", "rules.TXT", "guide.text"]) {
    assert.equal(workspacePrompt.isWorkspacePromptImportFileName(name), true);
  }
  for (const name of ["binary.pdf", "image.png", "script.js", ""]) {
    assert.equal(workspacePrompt.isWorkspacePromptImportFileName(name), false);
  }
  assert.equal(
    workspacePrompt.workspacePromptImportAcceptAttribute(),
    ".md,.txt,.markdown,.text",
  );
});

test("normalizeImportedWorkspacePromptContent trims, rejects empty, and caps size", () => {
  assert.deepEqual(workspacePrompt.normalizeImportedWorkspacePromptContent("  hello  "), {
    ok: true,
    content: "hello",
    truncated: false,
  });
  assert.deepEqual(workspacePrompt.normalizeImportedWorkspacePromptContent("\uFEFF  "), {
    ok: false,
    reason: "empty",
  });
  const oversized = "y".repeat(workspacePrompt.WORKSPACE_PROMPT_IMPORT_MAX_CHARS + 50);
  const normalized = workspacePrompt.normalizeImportedWorkspacePromptContent(oversized);
  assert.equal(normalized.ok, true);
  if (normalized.ok) {
    assert.equal(normalized.truncated, true);
    assert.match(normalized.content, /\[content truncated\]$/);
  }
});

test("mergeImportedWorkspacePrompt replaces empty and appends to existing", () => {
  assert.equal(workspacePrompt.mergeImportedWorkspacePrompt("", "new rules"), "new rules");
  assert.equal(
    workspacePrompt.mergeImportedWorkspacePrompt("existing", "imported"),
    "existing\n\nimported",
  );
  assert.equal(workspacePrompt.mergeImportedWorkspacePrompt("keep me", "   "), "keep me");
});
