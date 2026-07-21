import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const pathUtils = loader.loadModule("src/lib/tools/pathUtils.ts");
const systemTools = loader.loadModule("src/lib/tools/customSystemTools.ts");
const systemToolOptions = loader.loadModule("src/lib/tools/systemToolOptions.ts");
const skillBuiltinHelpers = loader.loadModule("src/lib/skills/builtin.ts");

test("ToolPathResolver accepts broad workspace path inputs", async () => {
  const resolver = new pathUtils.ToolPathResolver({ workdir: "/workspace/project" });

  const relative = await resolver.resolvePath(" ./src\\App.tsx ", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(relative.scope, "workspace");
  assert.equal(relative.relativePath, "src/App.tsx");
  assert.equal(relative.absolutePath, "/workspace/project/src/App.tsx");
  assert.equal(relative.displayPath, "src/App.tsx");
  assert.equal(relative.root, "/workspace/project");
  assert.ok(!("pathRef" in relative));

  const absolute = await resolver.resolvePath("/workspace/project/src/App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(absolute.scope, "workspace");
  assert.equal(absolute.relativePath, "src/App.tsx");

  const fileUrl = await resolver.resolvePath("file:///workspace/project/src/App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(fileUrl.scope, "workspace");
  assert.equal(fileUrl.relativePath, "src/App.tsx");

  const pathRef = await resolver.resolvePath("workspace:src/App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(pathRef.scope, "workspace");
  assert.equal(pathRef.relativePath, "src/App.tsx");

  await assert.rejects(
    () =>
      resolver.resolvePath("../secret", {
        label: "Read.path",
        intent: "read",
        required: true,
      }),
    /cannot contain \.\./,
  );
  await assert.rejects(
    () =>
      resolver.resolvePath("//server/share/file.txt", {
        label: "Read.path",
        intent: "read",
        required: true,
      }),
    /UNC path/,
  );
  await assert.rejects(
    () =>
      resolver.resolvePath("file:////server/share/file.txt", {
        label: "Read.path",
        intent: "read",
        required: true,
        allowExternal: true,
      }),
    /UNC paths are not supported/,
  );
  await assert.rejects(
    () =>
      resolver.resolvePath("file://server/share/file.txt", {
        label: "Read.path",
        intent: "read",
        required: true,
        allowExternal: true,
      }),
    /UNC paths are not supported/,
  );
});

test("ToolPathResolver normalizes Windows workspace path variants", async () => {
  const resolver = new pathUtils.ToolPathResolver({ workdir: "C:/Users/Alice/Repo" });

  const relative = await resolver.resolvePath("src\\App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(relative.scope, "workspace");
  assert.equal(relative.relativePath, "src/App.tsx");
  assert.equal(relative.absolutePath, "C:/Users/Alice/Repo/src/App.tsx");

  const absolute = await resolver.resolvePath("C:\\Users\\Alice\\Repo\\src\\App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(absolute.scope, "workspace");
  assert.equal(absolute.relativePath, "src/App.tsx");

  const lowercaseDrive = await resolver.resolvePath("c:/users/alice/repo/src/App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(lowercaseDrive.scope, "workspace");
  assert.equal(lowercaseDrive.relativePath, "src/App.tsx");

  const driveFileUrl = await resolver.resolvePath("file:///C:/Users/Alice/Repo/src/App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(driveFileUrl.scope, "workspace");
  assert.equal(driveFileUrl.relativePath, "src/App.tsx");

  const localhostFileUrl = await resolver.resolvePath(
    "file://localhost/C:/Users/Alice/Repo/src/App.tsx",
    {
      label: "Read.path",
      intent: "read",
      required: true,
    },
  );
  assert.equal(localhostFileUrl.scope, "workspace");
  assert.equal(localhostFileUrl.relativePath, "src/App.tsx");

  const extendedWorkdirResolver = new pathUtils.ToolPathResolver({
    workdir: "\\\\?\\C:\\Users\\Alice\\Repo",
  });
  const normalPathWithExtendedWorkdir = await extendedWorkdirResolver.resolvePath(
    "C:\\Users\\Alice\\Repo\\src\\App.tsx",
    {
      label: "Read.path",
      intent: "read",
      required: true,
    },
  );
  assert.equal(normalPathWithExtendedWorkdir.scope, "workspace");
  assert.equal(normalPathWithExtendedWorkdir.relativePath, "src/App.tsx");

  const extendedPath = await resolver.resolvePath("\\\\?\\C:\\Users\\Alice\\Repo\\src\\App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(extendedPath.scope, "workspace");
  assert.equal(extendedPath.relativePath, "src/App.tsx");

  await assert.rejects(
    () =>
      resolver.resolvePath("C:Users\\Alice\\Repo\\src\\App.tsx", {
        label: "Read.path",
        intent: "read",
        required: true,
      }),
    /cannot contain ':' path segments/,
  );
  await assert.rejects(
    () =>
      resolver.resolvePath("\\\\server\\share\\file.txt", {
        label: "Read.path",
        intent: "read",
        required: true,
        allowExternal: true,
      }),
    /UNC path/,
  );
  await assert.rejects(
    () =>
      resolver.resolvePath("\\\\?\\UNC\\server\\share\\file.txt", {
        label: "Read.path",
        intent: "read",
        required: true,
        allowExternal: true,
      }),
    /UNC path/,
  );
});

test("ToolPathResolver resolves enabled Skill paths and gates external paths by intent", async () => {
  const resolver = new pathUtils.ToolPathResolver({
    workdir: "/workspace/project",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
    skillAccessPolicy: {
      allowedSkillNames: ["skills-creator"],
      allowedSkillBaseDirs: ["skills-creator"],
    },
  });

  const skillUrl = await resolver.resolvePath("skill://skills-creator/SKILL.md", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(skillUrl.scope, "skill");
  assert.equal(skillUrl.relativePath, "skills-creator/SKILL.md");
  assert.equal(skillUrl.absolutePath, "/Users/me/.liveagent/skills/skills-creator/SKILL.md");
  assert.equal(skillUrl.displayPath, "skill://skills-creator/SKILL.md");
  assert.equal(skillUrl.root, "/Users/me/.liveagent/skills");
  assert.ok(!("pathRef" in skillUrl));

  const absoluteSkill = await resolver.resolvePath(
    "/Users/me/.liveagent/skills/skills-creator/SKILL.md",
    {
      label: "Read.path",
      intent: "read",
      required: true,
    },
  );
  assert.equal(absoluteSkill.scope, "skill");
  assert.equal(absoluteSkill.relativePath, "skills-creator/SKILL.md");

  await assert.rejects(
    () =>
      resolver.resolvePath("skill://metaphysics-steward/SKILL.md", {
        label: "Read.path",
        intent: "read",
        required: true,
      }),
    /not enabled/,
  );

  const stagedUpload = await resolver.resolvePath(
    "/Users/me/.liveagent/uploads/1721550000000/report.pdf",
    {
      label: "Read.path",
      intent: "read",
      required: true,
    },
  );
  assert.equal(stagedUpload.scope, "uploads");
  assert.equal(stagedUpload.root, "/Users/me/.liveagent/uploads");
  assert.equal(stagedUpload.relativePath, "1721550000000/report.pdf");
  assert.equal(stagedUpload.displayPath, "uploads/1721550000000/report.pdf");

  const stagedUploadDir = await resolver.resolvePath(
    "C:\\Users\\Me\\.liveagent\\uploads\\1721550000000",
    {
      label: "List.path",
      intent: "list",
      required: true,
    },
  );
  assert.equal(stagedUploadDir.scope, "uploads");
  assert.equal(stagedUploadDir.relativePath, "1721550000000");

  await assert.rejects(
    () =>
      resolver.resolvePath("/Users/me/.liveagent/uploads/1721550000000/report.pdf", {
        label: "Write.path",
        intent: "write",
        required: true,
      }),
    /only supports read access/,
  );
  await assert.rejects(
    () =>
      resolver.resolvePath("/Users/me/.liveagent/uploads/1721550000000/report.pdf", {
        label: "Delete.path",
        intent: "delete",
        required: true,
      }),
    /only supports read access/,
  );

  const externalImage = await resolver.resolvePath("/Users/me/Pictures/chart.png", {
    label: "Image.path",
    intent: "image",
    required: true,
    allowExternal: true,
  });
  assert.equal(externalImage.scope, "external");
  assert.equal(externalImage.root, "/Users/me/Pictures/chart.png");
  assert.equal(externalImage.displayPath, "/Users/me/Pictures/chart.png");

  await assert.rejects(
    () =>
      resolver.resolvePath("/Users/me/Pictures/chart.png", {
        label: "Write.path",
        intent: "write",
        required: true,
      }),
    /outside the workspace and enabled Skills/,
  );
});

test("ToolPathResolver teaches the skill:// shape when the skill path is empty", async () => {
  const resolver = new pathUtils.ToolPathResolver({
    workdir: "/workspace/project",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
  });

  await assert.rejects(
    () =>
      resolver.resolvePath("skill://", {
        label: "Write.path",
        intent: "write",
        required: true,
      }),
    /Write\.path must include the skill name and a file path after skill:\/\/.*skill:\/\/<skill-name>\/SKILL\.md/,
  );

  // Listing the skills root (required: false) still resolves.
  const skillsRoot = await resolver.resolvePath("skill://", {
    label: "List.path",
    intent: "read",
    required: false,
  });
  assert.equal(skillsRoot.scope, "skill");
  assert.equal(skillsRoot.relativePath, undefined);
  assert.equal(skillsRoot.root, "/Users/me/.liveagent/skills");
});

test("ToolPathResolver prefers the skill scope when the skills root nests inside the workspace", async () => {
  const resolver = new pathUtils.ToolPathResolver({
    workdir: "/workspace/project",
    skillsRootEnabled: true,
    skillsRootDir: "/workspace/project/.liveagent/skills",
  });

  const nestedSkill = await resolver.resolvePath(
    "/workspace/project/.liveagent/skills/demo/SKILL.md",
    {
      label: "Read.path",
      intent: "read",
      required: true,
    },
  );
  assert.equal(nestedSkill.scope, "skill");
  assert.equal(nestedSkill.relativePath, "demo/SKILL.md");
  assert.equal(nestedSkill.root, "/workspace/project/.liveagent/skills");
  assert.equal(nestedSkill.displayPath, "skill://demo/SKILL.md");

  const workspaceFile = await resolver.resolvePath("/workspace/project/src/App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(workspaceFile.scope, "workspace");
  assert.equal(workspaceFile.relativePath, "src/App.tsx");
  assert.equal(workspaceFile.root, "/workspace/project");
});

test("ToolPathResolver expands ~ only with an injected home directory", async () => {
  const withHome = new pathUtils.ToolPathResolver({
    workdir: "/Users/me/project",
    homeDir: "/Users/me",
  });
  const expanded = await withHome.resolvePath("~/project/notes/todo.md", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(expanded.scope, "workspace");
  assert.equal(expanded.relativePath, "notes/todo.md");
  assert.equal(expanded.absolutePath, "/Users/me/project/notes/todo.md");

  const withAsyncHome = new pathUtils.ToolPathResolver({
    workdir: "/workspace/project",
    resolveHomeDir: async () => "/Users/me",
  });
  const external = await withAsyncHome.resolvePath("~/notes.md", {
    label: "Image.path",
    intent: "image",
    required: true,
    allowExternal: true,
  });
  assert.equal(external.scope, "external");
  assert.equal(external.absolutePath, "/Users/me/notes.md");
  assert.equal(external.root, "/Users/me/notes.md");
  assert.equal(external.displayPath, "/Users/me/notes.md");

  const withoutHome = new pathUtils.ToolPathResolver({ workdir: "/workspace/project" });
  await assert.rejects(
    () =>
      withoutHome.resolvePath("~/notes.md", {
        label: "Read.path",
        intent: "read",
        required: true,
      }),
    /Cannot resolve ~\/ paths in this session; use a workspace-relative or absolute path instead/,
  );

  const fixedSkills = new pathUtils.ToolPathResolver({
    workdir: "/workspace/project",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
  });
  const skillViaHome = await fixedSkills.resolvePath("~/.liveagent/skills/demo/SKILL.md", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(skillViaHome.scope, "skill");
  assert.equal(skillViaHome.relativePath, "demo/SKILL.md");
  assert.equal(skillViaHome.displayPath, "skill://demo/SKILL.md");
});

test("ToolPathResolver still accepts legacy workspace:/skill: prefixed inputs", async () => {
  const resolver = new pathUtils.ToolPathResolver({
    workdir: "/workspace/project",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
  });

  const workspaceRef = await resolver.resolvePath("workspace:src/App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(workspaceRef.scope, "workspace");
  assert.equal(workspaceRef.relativePath, "src/App.tsx");
  assert.equal(workspaceRef.displayPath, "src/App.tsx");
  assert.ok(!("pathRef" in workspaceRef));

  const skillRef = await resolver.resolvePath("skill:demo/SKILL.md", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(skillRef.scope, "skill");
  assert.equal(skillRef.relativePath, "demo/SKILL.md");
  assert.equal(skillRef.displayPath, "skill://demo/SKILL.md");
  assert.ok(!("pathRef" in skillRef));
});

test("builtin agent skills stay selected and sort first", () => {
  assert.deepEqual(skillBuiltinHelpers.mergeAlwaysEnabledSkillNames(["demo-skill"]), [
    "skills-creator",
    "skills-installer",
    "demo-skill",
  ]);
  assert.deepEqual(
    skillBuiltinHelpers.sortSkillsForDisplay([
      { name: "z-skill" },
      { name: "skills-installer" },
      { name: "a-skill" },
      { name: "liveagent-code-review" },
      { name: "skills-creator" },
    ]).map((skill) => skill.name),
    ["skills-creator", "skills-installer", "a-skill", "liveagent-code-review", "z-skill"],
  );
  assert.equal(skillBuiltinHelpers.isUserSelectableSkillName("liveagent-code-review"), true);
  assert.equal(skillBuiltinHelpers.isUserSelectableSkillName("skills-creator"), false);
  assert.equal(skillBuiltinHelpers.isUserSelectableSkillName("workflow-skill"), true);
});

test("file tools can read enabled Skill files via skill URLs", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          assert.equal(command, "fs_read_text");
          return {
            kind: "text",
            path: args.path,
            content: "1\t---\n2\tname: demo\n",
            truncated: false,
            startLine: 1,
            numLines: 2,
            totalLines: 2,
            isPartialView: false,
            mtimeMs: 10,
            contentHash: "hash",
            fileId: "5:77",
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
    fileState: fileToolState.createFileToolState(),
  });

  const readTool = bundle.tools.find((tool) => tool.name === "Read");
  assert.doesNotMatch(JSON.stringify(readTool.parameters), /"root"/);
  assert.equal(readTool.parameters.additionalProperties, false);
  assert.match(JSON.stringify(readTool.parameters), /skill:\/\//);

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "read-skill-file",
    name: "Read",
    arguments: {
      path: "skill://skills-creator/SKILL.md",
      limit: 20,
    },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "read_text");
  assert.equal(result.details.scope, "skill");
  assert.equal(result.details.path, "skill://skills-creator/SKILL.md");
  assert.equal(result.details.relativePath, "skills-creator/SKILL.md");
  assert.equal(result.details.fileId, "5:77");
  assert.ok(!("pathRef" in result.details));
  assert.match(result.content[0].text, /Read: skill:\/\/skills-creator\/SKILL\.md/);
  assert.deepEqual(invocations, [
    {
      command: "fs_read_text",
      args: {
        workdir: "/Users/me/.liveagent/skills",
        path: "skills-creator/SKILL.md",
        start_line: undefined,
        limit: 20,
        page_start: undefined,
        page_limit: undefined,
        cell_start: undefined,
        cell_limit: undefined,
      },
    },
  ]);
});

test("file tool schemas are strict and reject unsupported root arguments", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  for (const tool of bundle.tools) {
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name} should be strict`);
    assert.doesNotMatch(JSON.stringify(tool.parameters), /"root"/);
  }

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "read-with-old-root",
    name: "Read",
    arguments: {
      root: "workspace",
      path: "README.md",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unsupported argument: root/);
  assert.deepEqual(invocations, []);
});

test("file tools enforce enabled Skill allowlist for skill URLs", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
    skillAccessPolicy: {
      allowedSkillNames: ["skills-creator"],
      allowedSkillBaseDirs: ["skills-creator"],
    },
    fileState: fileToolState.createFileToolState(),
  });

  const readResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-skill-read",
    name: "Read",
    arguments: {
      path: "skill://metaphysics-steward/SKILL.md",
    },
  });
  assert.equal(readResult.isError, true);
  assert.match(readResult.content[0].text, /metaphysics-steward\/SKILL\.md.*is not enabled/);
  assert.match(readResult.content[0].text, /Allowed Skills in this conversation: skills-creator/);

  const globResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-skill-glob",
    name: "Glob",
    arguments: {
      pattern: "metaphysics-steward/scripts/**/*",
      path: "skill://metaphysics-steward/scripts",
    },
  });
  assert.equal(globResult.isError, true);
  assert.match(globResult.content[0].text, /metaphysics-steward\/scripts.*is not enabled/);
  assert.deepEqual(invocations, []);
});

test("file tools allow direct mutations inside enabled Skills when mutation is granted", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "fs_path_status") {
            return {
              path: args.path,
              exists: false,
              kind: null,
              sizeBytes: null,
              mtimeMs: null,
              fileId: null,
            };
          }
          assert.equal(command, "fs_write_text");
          return {
            path: args.path,
            existedBefore: false,
            bytesWritten: 34,
            mtimeMs: 123,
            contentHash: "hash",
            totalLines: 4,
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
    skillAccessPolicy: {
      allowedSkillNames: ["demo"],
      allowedSkillBaseDirs: ["demo"],
      allowSkillMutation: true,
    },
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-skill-write",
    name: "Write",
    arguments: {
      path: "skill://demo/SKILL.md",
      content: "---\nname: demo\ndescription: Demo\n---\n",
    },
  });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /File created successfully at: skill:\/\/demo\/SKILL\.md/);
  assert.doesNotMatch(result.content[0].text, /mode=rewrite/);
  assert.deepEqual(invocations, [
    {
      command: "fs_path_status",
      args: {
        workdir: "/Users/me/.liveagent/skills",
        path: "demo/SKILL.md",
      },
    },
    {
      command: "fs_write_text",
      args: {
        workdir: "/Users/me/.liveagent/skills",
        path: "demo/SKILL.md",
        content: "---\nname: demo\ndescription: Demo\n---\n",
        mode: "rewrite",
        expected_mtime_ms: undefined,
        expected_content_hash: undefined,
      },
    },
  ]);
});

test("Write strips legacy mode before schema validation and omits it from the schema", async () => {
  const fsLoader = createTsModuleLoader();
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });
  const writeTool = bundle.tools.find((tool) => tool.name === "Write");

  assert.ok(writeTool);
  assert.doesNotMatch(writeTool.description, /mode/);
  assert.deepEqual(Object.keys(writeTool.parameters.properties), ["path", "content"]);

  const prepared = writeTool.prepareArguments({
    path: "test8/gomoku.html",
    mode: "",
    content: "",
  });
  const args = validateToolArguments(writeTool, {
    type: "toolCall",
    id: "legacy-empty-mode",
    name: "Write",
    arguments: prepared,
  });

  assert.deepEqual(args, {
    path: "test8/gomoku.html",
    content: "",
  });
});

test("Write auto-primes a full text snapshot before overwriting an unread file", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "fs_path_status") {
            return {
              path: args.path,
              exists: args.path === "existing.html",
              kind: args.path === "existing.html" ? "file" : null,
              sizeBytes: args.path === "existing.html" ? 128 : null,
              mtimeMs: args.path === "existing.html" ? 44 : null,
              fileId: null,
            };
          }
          if (command === "fs_read_text") {
            assert.equal(args.path, "existing.html");
            assert.equal(args.limit, 5000);
            return {
              kind: "text",
              path: "existing.html",
              content: "1\t<html>old</html>\n",
              truncated: false,
              startLine: 1,
              numLines: 1,
              totalLines: 1,
              isPartialView: false,
              mtimeMs: 44,
              contentHash: "before-hash",
            };
          }
          assert.equal(command, "fs_write_text");
          return {
            path: args.path,
            existedBefore: args.path === "existing.html",
            bytesWritten: args.content.length,
            mtimeMs: 45,
            contentHash: "after-hash",
            totalLines: 1,
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  const overwritten = await bundle.executeToolCall({
    type: "toolCall",
    id: "write-existing-unread",
    name: "Write",
    arguments: {
      path: "existing.html",
      content: "<html>new</html>\n",
    },
  });

  assert.equal(overwritten.isError, false);
  assert.match(overwritten.content[0].text, /File updated successfully at: existing\.html/);
  assert.match(overwritten.content[0].text, /autoRead=full/);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["fs_path_status", "fs_read_text", "fs_write_text"],
  );
  const writeInvocation = invocations.at(-1);
  assert.equal(writeInvocation.args.expected_mtime_ms, 44);
  assert.equal(writeInvocation.args.expected_content_hash, "before-hash");

  invocations.length = 0;
  const created = await bundle.executeToolCall({
    type: "toolCall",
    id: "write-new-file",
    name: "Write",
    arguments: {
      path: "new.html",
      content: "<html>fresh</html>\n",
    },
  });

  assert.equal(created.isError, false);
  assert.doesNotMatch(created.content[0].text, /autoRead/);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["fs_path_status", "fs_write_text"],
  );
  assert.equal(invocations.at(-1).args.expected_mtime_ms, undefined);
  assert.equal(invocations.at(-1).args.expected_content_hash, undefined);
});

test("Write drops the auto-primed snapshot when the backend write fails", async () => {
  const fileContent = "1\t<html>secret-on-disk</html>\n";
  let failWrites = true;
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          if (command === "fs_path_status") {
            return {
              path: args.path,
              exists: true,
              kind: "file",
              sizeBytes: 30,
              mtimeMs: 44,
              fileId: null,
            };
          }
          if (command === "fs_read_text") {
            return {
              kind: "text",
              path: args.path,
              content: fileContent,
              truncated: false,
              startLine: 1,
              numLines: 1,
              totalLines: 1,
              isPartialView: false,
              mtimeMs: 44,
              contentHash: "disk-hash",
            };
          }
          assert.equal(command, "fs_write_text");
          if (failWrites) {
            throw { code: "io", message: "Permission denied", path: args.path };
          }
          return {
            path: args.path,
            existedBefore: true,
            bytesWritten: args.content.length,
            mtimeMs: 45,
            contentHash: "after-hash",
            totalLines: 1,
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  const failed = await bundle.executeToolCall({
    type: "toolCall",
    id: "write-fails-after-prime",
    name: "Write",
    arguments: { path: "locked.html", content: "<html>new</html>\n" },
  });
  assert.equal(failed.isError, true);

  // The auto-primed snapshot must not survive the failed write: a follow-up
  // Read has to return the real content, never an "unchanged" stub for
  // content the model has never seen.
  const read = await bundle.executeToolCall({
    type: "toolCall",
    id: "read-after-failed-write",
    name: "Read",
    arguments: { path: "locked.html" },
  });
  assert.equal(read.isError, false);
  assert.doesNotMatch(read.content[0].text, /unchanged since the previous Read/);
  assert.match(read.content[0].text, /secret-on-disk/);

  failWrites = false;
  const retried = await bundle.executeToolCall({
    type: "toolCall",
    id: "write-retry-after-read",
    name: "Write",
    arguments: { path: "locked.html", content: "<html>new</html>\n" },
  });
  assert.equal(retried.isError, false);
  assert.doesNotMatch(retried.content[0].text, /autoRead/);
});

test("Write rejects directory paths with filename guidance before touching the backend", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          assert.equal(command, "fs_path_status");
          return {
            path: args.path,
            exists: args.path === "output",
            kind: args.path === "output" ? "dir" : null,
            sizeBytes: args.path === "output" ? 96 : null,
            mtimeMs: args.path === "output" ? 55 : null,
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  const writeTool = bundle.tools.find((tool) => tool.name === "Write");
  assert.match(writeTool.description, /notes\/todo\.txt/);
  assert.match(writeTool.description, /does not choose filenames from directory paths/);

  const blocked = await bundle.executeToolCall({
    type: "toolCall",
    id: "write-directory",
    name: "Write",
    arguments: {
      path: "output",
      content: "",
    },
  });

  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /directory, not a file: output/);
  assert.match(blocked.content[0].text, /path="output\/notes\.md"/);
  assert.match(blocked.content[0].text, /no separate create-directory step/);
  assert.deepEqual(invocations, [
    {
      command: "fs_path_status",
      args: {
        workdir: "/workspace",
        path: "output",
      },
    },
  ]);
});

test("Write does not infer filenames from content when path is a directory", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          assert.equal(command, "fs_path_status");
          return {
            path: args.path,
            exists: true,
            kind: "dir",
            sizeBytes: 96,
            mtimeMs: 55,
            fileId: null,
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "write-content-dir",
    name: "Write",
    arguments: {
      path: "test8",
      content: '{"ok":true}\n',
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /directory, not a file: test8/);
  assert.match(result.content[0].text, /path="test8\/notes\.md"/);
  assert.match(result.content[0].text, /no separate create-directory step/);
  assert.doesNotMatch(result.content[0].text, /data\.json|index\.html/);
  assert.deepEqual(invocations, [
    {
      command: "fs_path_status",
      args: {
        workdir: "/workspace",
        path: "test8",
      },
    },
  ]);
});

test("Write preserves extensionless file paths instead of adding a content-derived extension", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "fs_path_status") {
            return {
              path: args.path,
              exists: false,
              kind: null,
              sizeBytes: null,
              mtimeMs: null,
              fileId: null,
            };
          }
          assert.equal(command, "fs_write_text");
          return {
            path: args.path,
            existedBefore: false,
            bytesWritten: args.content.length,
            mtimeMs: 125,
            contentHash: "hash-index",
            totalLines: 2,
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "write-extensionless",
    name: "Write",
    arguments: {
      path: "scripts/run",
      content: "#!/usr/bin/env bash\necho ok\n",
    },
  });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /File created successfully at: scripts\/run/);
  assert.equal(result.details.path, "scripts/run");
  assert.deepEqual(invocations, [
    {
      command: "fs_path_status",
      args: {
        workdir: "/workspace",
        path: "scripts/run",
      },
    },
    {
      command: "fs_write_text",
      args: {
        workdir: "/workspace",
        path: "scripts/run",
        content: "#!/usr/bin/env bash\necho ok\n",
        mode: "rewrite",
        expected_mtime_ms: undefined,
        expected_content_hash: undefined,
      },
    },
  ]);
});

test("Write replays the Gomoku failure sequence with generic directory recovery guidance", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "fs_path_status") {
            return {
              path: args.path,
              exists: args.path === "test8",
              kind: args.path === "test8" ? "dir" : null,
              sizeBytes: args.path === "test8" ? 96 : null,
              mtimeMs: args.path === "test8" ? 55 : null,
            };
          }
          assert.equal(command, "fs_write_text");
          return {
            path: args.path,
            existedBefore: false,
            bytesWritten: args.content.length,
            mtimeMs: 126,
            contentHash: "hash-gomoku",
            totalLines: 2,
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });
  const writeTool = bundle.tools.find((tool) => tool.name === "Write");

  assert.deepEqual(
    validateToolArguments(writeTool, {
      type: "toolCall",
      id: "gomoku-empty-mode",
      name: "Write",
      arguments: writeTool.prepareArguments({
        path: "test8/gomoku.html",
        mode: "",
        content: "",
      }),
    }),
    {
      path: "test8/gomoku.html",
      content: "",
    },
  );

  const directoryBlocked = await bundle.executeToolCall({
    type: "toolCall",
    id: "gomoku-directory-empty",
    name: "Write",
    arguments: {
      path: "test8",
      content: "",
    },
  });

  assert.equal(directoryBlocked.isError, true);
  assert.match(directoryBlocked.content[0].text, /directory, not a file: test8/);
  assert.match(directoryBlocked.content[0].text, /path="test8\/notes\.md"/);
  assert.doesNotMatch(directoryBlocked.content[0].text, /mode constant|index\.html/);

  const recovered = await bundle.executeToolCall({
    type: "toolCall",
    id: "gomoku-directory-html",
    name: "Write",
    arguments: {
      path: "test8/index.html",
      content: "<!doctype html>\n<html></html>\n",
    },
  });

  assert.equal(recovered.isError, false);
  assert.match(recovered.content[0].text, /File created successfully at: test8\/index\.html/);
  assert.doesNotMatch(recovered.content[0].text, /mode=rewrite|target=/);
  assert.equal(recovered.details.path, "test8/index.html");
  assert.deepEqual(invocations, [
    {
      command: "fs_path_status",
      args: {
        workdir: "/workspace",
        path: "test8",
      },
    },
    {
      command: "fs_path_status",
      args: {
        workdir: "/workspace",
        path: "test8/index.html",
      },
    },
    {
      command: "fs_write_text",
      args: {
        workdir: "/workspace",
        path: "test8/index.html",
        content: "<!doctype html>\n<html></html>\n",
        mode: "rewrite",
        expected_mtime_ms: undefined,
        expected_content_hash: undefined,
      },
    },
  ]);
});

test("file tools block direct mutations inside backend-verified built-in Skills", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
    skillAccessPolicy: {
      allowedSkillNames: ["liveagent-code-review"],
      allowedSkillBaseDirs: ["liveagent-code-review"],
      protectedSkillNames: ["liveagent-code-review"],
      protectedSkillBaseDirs: ["liveagent-code-review"],
      allowSkillMutation: true,
    },
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-builtin-skill-write",
    name: "Write",
    arguments: {
      path: "skill://liveagent-code-review/SKILL.md",
      content: "---\nname: liveagent-code-review\ndescription: Changed\n---\n",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /built-in Skill "liveagent-code-review" is protected/);
  assert.match(result.content[0].text, /cannot be modified by the model/);
  assert.deepEqual(invocations, []);
});

test("file tools normalize absolute enabled Skill paths", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          assert.equal(command, "fs_read_text");
          return {
            kind: "text",
            path: args.path,
            content: "1\t---\n2\tname: skills-installer\n",
            truncated: false,
            startLine: 1,
            numLines: 2,
            totalLines: 2,
            isPartialView: false,
            mtimeMs: 10,
            contentHash: "hash",
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "absolute-skill-read",
    name: "Read",
    arguments: {
      path: "/Users/me/.liveagent/skills/skills-installer/SKILL.md",
    },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.scope, "skill");
  assert.equal(result.details.path, "skill://skills-installer/SKILL.md");
  assert.equal(result.details.relativePath, "skills-installer/SKILL.md");
  assert.deepEqual(invocations, [
    {
      command: "fs_read_text",
      args: {
        workdir: "/Users/me/.liveagent/skills",
        path: "skills-installer/SKILL.md",
        start_line: undefined,
        limit: undefined,
        page_start: undefined,
        page_limit: undefined,
        cell_start: undefined,
        cell_limit: undefined,
      },
    },
  ]);
});

test("file tool runtime string errors surface the backend message with the display path", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          throw "I/O error: No such file or directory (os error 2)";
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "missing-skill-file",
    name: "Read",
    arguments: {
      path: "skill://demo/missing.md",
    },
  });

  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "Read failed for skill://demo/missing.md: I/O error: No such file or directory (os error 2)",
  );
  assert.doesNotMatch(result.content[0].text, /pathRef/);
  assert.deepEqual(invocations, [
    {
      command: "fs_read_text",
      args: {
        workdir: "/Users/me/.liveagent/skills",
        path: "demo/missing.md",
        start_line: undefined,
        limit: undefined,
        page_start: undefined,
        page_limit: undefined,
        cell_start: undefined,
        cell_limit: undefined,
      },
    },
  ]);
});

test("file tool not_found errors offer didYouMean or Glob/List recovery", async () => {
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          assert.equal(command, "fs_read_text");
          throw {
            code: "not_found",
            message: "file not found",
            path: args.path,
            workdir: args.workdir,
            didYouMean: args.path === "src/Appp.tsx" ? ["src/App.tsx"] : [],
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  const withSuggestion = await bundle.executeToolCall({
    type: "toolCall",
    id: "not-found-suggestion",
    name: "Read",
    arguments: { path: "src/Appp.tsx" },
  });
  assert.equal(withSuggestion.isError, true);
  assert.equal(
    withSuggestion.content[0].text,
    "Read failed: src/Appp.tsx does not exist (workspace root: /workspace). Did you mean: src/App.tsx? Retry with one of these exact paths.",
  );

  const withoutSuggestion = await bundle.executeToolCall({
    type: "toolCall",
    id: "not-found-plain",
    name: "Read",
    arguments: { path: "missing/none.md" },
  });
  assert.equal(withoutSuggestion.isError, true);
  assert.equal(
    withoutSuggestion.content[0].text,
    'Read failed: missing/none.md does not exist (workspace root: /workspace). Locate it with Glob pattern="**/none.md" or List the parent directory, then retry with the returned path.',
  );
});

test("Grep passes file paths straight to the backend and reports the single-file note", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          assert.equal(command, "fs_grep");
          assert.equal(args.path, "src/App.tsx");
          assert.equal(args.file_pattern, undefined);
          return {
            path: "src/App.tsx",
            targetKind: "file",
            pattern: "render",
            filePattern: null,
            ignoreCase: true,
            outputMode: "content",
            headLimit: 20,
            offset: 0,
            context: 0,
            multiline: false,
            matchCount: 1,
            fileCount: 1,
            hasMore: false,
            matches: [
              {
                path: "src/App.tsx",
                line: 12,
                text: "render();",
                before: [],
                after: [],
              },
            ],
            files: [{ path: "src/App.tsx", count: 1, firstLine: 12 }],
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "grep-file-path",
    name: "Grep",
    arguments: {
      path: "src/App.tsx",
      pattern: "render",
      output_mode: "content",
      head_limit: 20,
    },
  });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /note=path is a file; searched that single file/);
  assert.match(result.content[0].text, /src\/App\.tsx:12: render\(\);/);
  assert.equal(result.details.path, "src/App.tsx");
  assert.equal(result.details.targetKind, "file");
  assert.equal(result.details.filePattern, undefined);
  assert.equal(invocations.length, 1);
});

test("Edit auto-primes a full text snapshot before replacement", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "fs_path_status") {
            assert.equal(args.path, "src/App.tsx");
            return {
              path: "src/App.tsx",
              exists: true,
              kind: "file",
              sizeBytes: 21,
              mtimeMs: 44,
              fileId: null,
            };
          }
          if (command === "fs_read_text") {
            assert.equal(args.path, "src/App.tsx");
            assert.equal(args.limit, 5000);
            return {
              kind: "text",
              path: "src/App.tsx",
              content: "1\tconst value = 'old';\n",
              truncated: false,
              startLine: 1,
              numLines: 1,
              totalLines: 1,
              isPartialView: false,
              mtimeMs: 44,
              contentHash: "before-hash",
            };
          }
          assert.equal(command, "fs_edit_text");
          assert.equal(args.path, "src/App.tsx");
          assert.equal(args.expected_mtime_ms, 44);
          assert.equal(args.expected_content_hash, "before-hash");
          return {
            path: "src/App.tsx",
            replacements: 1,
            replaceAll: false,
            mtimeMs: 45,
            contentHash: "after-hash",
            totalLines: 1,
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "edit-without-read",
    name: "Edit",
    arguments: {
      path: "src/App.tsx",
      old_string: "old",
      new_string: "new",
    },
  });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /autoRead=full/);
  assert.equal(result.details.replacements, 1);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["fs_path_status", "fs_read_text", "fs_edit_text"],
  );
});

test("Edit reuses full-read snapshots across path spellings via fileId", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "fs_read_text") {
            assert.equal(args.path, "src/App.tsx");
            return {
              kind: "text",
              path: "src/App.tsx",
              content: "1\tconst value = 'old';\n",
              truncated: false,
              startLine: 1,
              numLines: 1,
              totalLines: 1,
              isPartialView: false,
              mtimeMs: 44,
              contentHash: "before-hash",
              fileId: "1:42",
            };
          }
          if (command === "fs_path_status") {
            assert.equal(args.path, "SRC/App.TSX");
            return {
              path: "SRC/App.TSX",
              exists: true,
              kind: "file",
              sizeBytes: 21,
              mtimeMs: 44,
              fileId: "1:42",
            };
          }
          assert.equal(command, "fs_edit_text");
          assert.equal(args.path, "SRC/App.TSX");
          assert.equal(args.expected_mtime_ms, 44);
          assert.equal(args.expected_content_hash, "before-hash");
          return {
            path: "SRC/App.TSX",
            replacements: 1,
            replaceAll: false,
            mtimeMs: 45,
            contentHash: "after-hash",
            totalLines: 1,
            fileId: "1:42",
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  const readResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "read-lowercase-path",
    name: "Read",
    arguments: { path: "src/App.tsx" },
  });
  assert.equal(readResult.isError, false);
  assert.equal(readResult.details.fileId, "1:42");

  const editResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "edit-uppercase-path",
    name: "Edit",
    arguments: {
      path: "SRC/App.TSX",
      old_string: "old",
      new_string: "new",
    },
  });

  assert.equal(editResult.isError, false);
  assert.doesNotMatch(editResult.content[0].text, /autoRead/);
  assert.equal(editResult.details.fileId, "1:42");
  assert.equal(editResult.details.replacements, 1);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["fs_read_text", "fs_path_status", "fs_edit_text"],
  );
});

test("SkillsManager read accepts explicit skill entry paths", async () => {
  const invocations = [];
  const skillLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          assert.equal(command, "system_manage_skill");
          return {
            action: "read",
            rootDir: "/Users/me/.liveagent/skills",
            path: args.payload.path,
            content: "line one\nline two\n",
            truncated: false,
            startLine: 3,
            numLines: 2,
          };
        },
      },
    },
  });
  const skillTools = skillLoader.loadModule("src/lib/tools/skillTools.ts");
  const bundle = skillTools.createSkillTools();

  assert.equal(bundle.metadataByName.get("SkillsManager").kind, "manage_skill");
  assert.equal(bundle.metadataByName.get("SkillsManager").isReadOnly, false);

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "skill-read",
    name: "SkillsManager",
    arguments: {
      action: "read",
      path: "skill://skills-installer/SKILL.md",
      offset: 2,
      length: 2,
    },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "read_skill");
  assert.equal(result.details.path, "skills-installer/SKILL.md");
  assert.equal(result.details.startLine, 3);
  assert.equal(result.details.numLines, 2);
  assert.match(result.content[0].text, /<LiveAgentSkillFileRules>/);
  assert.match(result.content[0].text, /skill:\/\/skills-installer\/\.\.\./);
  assert.match(result.content[0].text, /path="skill:\/\/skills-installer\/\.\.\."/);
  assert.match(result.content[0].text, /Do not use Bash/);
  assert.deepEqual(invocations, [
    {
      command: "system_manage_skill",
      args: {
        payload: {
          action: "read",
          path: "skills-installer/SKILL.md",
          offset: 2,
          length: 2,
        },
      },
    },
  ]);
});

test("SkillsManager install resolves local relative sources against the workspace", async () => {
  const invocations = [];
  const skillLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          assert.equal(command, "system_manage_skill");
          return {
            action: "install",
            rootDir: "/Users/me/.liveagent/skills",
            installed: [
              {
                name: "chart-image",
                target: "/Users/me/.liveagent/skills/chart-image",
                backup: null,
                skillFile: "chart-image/SKILL.md",
              },
            ],
          };
        },
      },
    },
  });
  const skillTools = skillLoader.loadModule("src/lib/tools/skillTools.ts");
  const bundle = skillTools.createSkillTools({
    workdir: "/Users/me/project",
    skillAccessPolicy: {
      allowedSkillNames: ["skills-installer"],
      allowedSkillBaseDirs: ["skills-installer"],
      allowSkillManagement: true,
    },
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "install-relative-source",
    name: "SkillsManager",
    arguments: {
      action: "install",
      source: "./skills/chart-image",
    },
  });

  assert.equal(result.isError, false);
  assert.equal(
    invocations[0].args.payload.source,
    "/Users/me/project/skills/chart-image",
  );
});

test("SkillsManager clawhub_install forwards owner handle for slug disambiguation", async () => {
  const invocations = [];
  const skillLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          assert.equal(command, "system_manage_skill");
          return {
            action: "clawhub_install",
            rootDir: "/Users/me/.liveagent/skills",
            clawhubSlug: "example-skill",
            clawhubDownloadUrl:
              "https://clawhub.ai/api/v1/download?slug=example-skill&tag=latest&ownerHandle=acme",
            installed: [
              {
                name: "example-skill",
                target: "/Users/me/.liveagent/skills/example-skill",
                backup: null,
                skillFile: "example-skill/SKILL.md",
              },
            ],
          };
        },
      },
    },
  });
  const skillTools = skillLoader.loadModule("src/lib/tools/skillTools.ts");
  const bundle = skillTools.createSkillTools({
    skillAccessPolicy: {
      allowedSkillNames: ["skills-installer"],
      allowedSkillBaseDirs: ["skills-installer"],
      allowSkillManagement: true,
    },
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "clawhub-install-owner",
    name: "SkillsManager",
    arguments: {
      action: "clawhub_install",
      slug: "example-skill",
      owner: "acme",
      conflict: "backup",
    },
  });

  assert.equal(result.isError, false);
  assert.equal(invocations[0].args.payload.slug, "example-skill");
  assert.equal(invocations[0].args.payload.owner, "acme");
});

test("SkillsManager blocks unread enabled-Skill policy violations before backend invoke", async () => {
  const invocations = [];
  const skillLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });
  const skillTools = skillLoader.loadModule("src/lib/tools/skillTools.ts");
  const bundle = skillTools.createSkillTools({
    skillAccessPolicy: {
      allowedSkillNames: ["skills-creator"],
      allowedSkillBaseDirs: ["skills-creator"],
      allowSkillInventory: false,
      allowSkillManagement: false,
    },
  });

  const readResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-skill-manager-read",
    name: "SkillsManager",
    arguments: {
      action: "read",
      path: "metaphysics-steward/SKILL.md",
    },
  });
  assert.equal(readResult.isError, true);
  assert.match(readResult.content[0].text, /metaphysics-steward\/SKILL\.md.*is not enabled/);

  const listResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-skill-manager-list",
    name: "SkillsManager",
    arguments: {
      action: "list",
    },
  });
  assert.equal(listResult.isError, true);
  assert.match(listResult.content[0].text, /SkillsManager\(action=list\) is blocked/);

  const installResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-skill-manager-install",
    name: "SkillsManager",
    arguments: {
      action: "install",
      source: "https://github.com/example/repo/tree/main/skills/new-skill",
    },
  });
  assert.equal(installResult.isError, true);
  assert.match(installResult.content[0].text, /SkillsManager\(action="install"\) is blocked/);
  const packageResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-skill-manager-package",
    name: "SkillsManager",
    arguments: {
      action: "package",
      name: "demo",
    },
  });
  assert.equal(packageResult.isError, true);
  assert.match(packageResult.content[0].text, /SkillsManager\(action="package"\) is blocked/);
  assert.deepEqual(invocations, []);
});

test("SkillsManager blocks built-in Skill create/install targets before backend invoke", async () => {
  const invocations = [];
  const skillLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });
  const skillTools = skillLoader.loadModule("src/lib/tools/skillTools.ts");
  const bundle = skillTools.createSkillTools({
    skillAccessPolicy: {
      allowedSkillNames: ["skills-creator", "skills-installer", "liveagent-code-review"],
      allowedSkillBaseDirs: ["skills-creator", "skills-installer", "liveagent-code-review"],
      protectedSkillNames: ["liveagent-code-review"],
      protectedSkillBaseDirs: ["liveagent-code-review"],
      allowSkillManagement: true,
    },
  });

  const createResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-builtin-create",
    name: "SkillsManager",
    arguments: {
      action: "create",
      name: "skills-creator",
      description: "Changed creator",
      body: "## Workflow\n\n1. Change builtin.",
      conflict: "overwrite",
    },
  });
  assert.equal(createResult.isError, true);
  assert.match(createResult.content[0].text, /built-in Skill "skills-creator" is protected/);

  const installResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-builtin-install",
    name: "SkillsManager",
    arguments: {
      action: "install",
      source: "./replacement",
      name: "skills-installer",
      conflict: "overwrite",
    },
  });
  assert.equal(installResult.isError, true);
  assert.match(installResult.content[0].text, /built-in Skill "skills-installer" is protected/);

  const deleteResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-builtin-delete",
    name: "SkillsManager",
    arguments: {
      action: "delete",
      name: "liveagent-code-review",
    },
  });
  assert.equal(deleteResult.isError, true);
  assert.match(deleteResult.content[0].text, /built-in Skill "liveagent-code-review" is protected/);
  assert.deepEqual(invocations, []);
});

test("SkillsManager management can auto-enable installed Skills without exposing inventory", async () => {
  const invocations = [];
  const changes = [];
  const events = [];
  const skillLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          assert.equal(command, "system_manage_skill");
          const action = args.payload.action;
          if (action === "install") {
            return {
              action: "install",
              rootDir: "/Users/me/.liveagent/skills",
              installed: [
                {
                  name: "new-skill",
                  target: "/Users/me/.liveagent/skills/new-skill",
                  backup: null,
                  skillFile: "new-skill/SKILL.md",
                },
              ],
            };
          }
          if (action === "read") {
            assert.equal(args.payload.path, "new-skill/SKILL.md");
            return {
              action: "read",
              rootDir: "/Users/me/.liveagent/skills",
              path: "new-skill/SKILL.md",
              content: "---\nname: new-skill\ndescription: New Skill\n---\n",
              truncated: false,
              startLine: 1,
              numLines: 4,
            };
          }
          if (action === "list") {
            return {
              action: "list",
              rootDir: "/Users/me/.liveagent/skills",
              skills: [
                {
                  name: "skills-creator",
                  description: "Create Skills",
                  target: "/Users/me/.liveagent/skills/skills-creator",
                  skillFile: "skills-creator/SKILL.md",
                  baseDir: "skills-creator",
                },
                {
                  name: "skills-installer",
                  description: "Install Skills",
                  target: "/Users/me/.liveagent/skills/skills-installer",
                  skillFile: "skills-installer/SKILL.md",
                  baseDir: "skills-installer",
                },
                {
                  name: "new-skill",
                  description: "New Skill",
                  target: "/Users/me/.liveagent/skills/new-skill",
                  skillFile: "new-skill/SKILL.md",
                  baseDir: "new-skill",
                },
                {
                  name: "hidden-skill",
                  description: "Hidden Skill",
                  target: "/Users/me/.liveagent/skills/hidden-skill",
                  skillFile: "hidden-skill/SKILL.md",
                  baseDir: "hidden-skill",
                },
              ],
              invalid: [],
            };
          }
          throw new Error(`unexpected action ${action}`);
        },
      },
    },
  });
  const skillTools = skillLoader.loadModule("src/lib/tools/skillTools.ts");
  const policy = {
    allowedSkillNames: ["skills-creator", "skills-installer"],
    allowedSkillBaseDirs: ["skills-creator", "skills-installer"],
    allowSkillInventory: true,
    allowSkillManagement: true,
  };
  const bundle = skillTools.createSkillTools({
    skillAccessPolicy: policy,
    onManagedSkillsChanged(change) {
      changes.push(change);
    },
  });
  const previousWindow = globalThis.window;
  globalThis.window = {
    dispatchEvent(event) {
      events.push(event.type);
    },
  };

  try {
    const installResult = await bundle.executeToolCall({
      type: "toolCall",
      id: "skill-install",
      name: "SkillsManager",
      arguments: {
        action: "install",
        source: "https://github.com/example/repo/tree/main/skills/new-skill",
        conflict: "backup",
      },
    });

    assert.equal(installResult.isError, false);
    assert.match(installResult.content[0].text, /installed=1/);
    assert.match(installResult.content[0].text, /skillFile=new-skill\/SKILL\.md/);
    assert.match(installResult.content[0].text, /enabled=true/);
    assert.deepEqual(policy.allowedSkillNames, [
      "skills-creator",
      "skills-installer",
      "new-skill",
    ]);
    assert.deepEqual(policy.allowedSkillBaseDirs, [
      "skills-creator",
      "skills-installer",
      "new-skill",
    ]);
    assert.deepEqual(changes, [
      {
        action: "install",
        names: ["new-skill"],
        baseDirs: ["new-skill"],
      },
    ]);

    const listResult = await bundle.executeToolCall({
      type: "toolCall",
      id: "visible-list-after-install",
      name: "SkillsManager",
      arguments: { action: "list" },
    });
    assert.equal(listResult.isError, false);
    assert.match(listResult.content[0].text, /visible=enabled-skills-only/);
    assert.match(listResult.content[0].text, /skills=3/);
    assert.match(listResult.content[0].text, /skills-creator/);
    assert.match(listResult.content[0].text, /skills-installer/);
    assert.match(listResult.content[0].text, /new-skill/);
    assert.doesNotMatch(listResult.content[0].text, /hidden-skill/);
    assert.equal(listResult.details.skillsCount, 3);

    const readResult = await bundle.executeToolCall({
      type: "toolCall",
      id: "read-new-skill",
      name: "SkillsManager",
      arguments: {
        action: "read",
        path: "new-skill/SKILL.md",
      },
    });
    assert.equal(readResult.isError, false);
    assert.equal(readResult.details.path, "new-skill/SKILL.md");
    assert.deepEqual(events, ["liveagent:skills-discovery-updated"]);
  } finally {
    if (typeof previousWindow === "undefined") {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("SkillsManager list filters installed Skills when inventory is explicitly allowed", async () => {
  const skillLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command) {
          assert.equal(command, "system_manage_skill");
          return {
            action: "list",
            rootDir: "/Users/me/.liveagent/skills",
            skills: [
              {
                name: "skills-creator",
                description: "Create Skills",
                skillFile: "skills-creator/SKILL.md",
                baseDir: "skills-creator",
              },
              {
                name: "metaphysics-steward",
                description: "Metaphysics",
                skillFile: "metaphysics-steward/SKILL.md",
                baseDir: "metaphysics-steward",
              },
            ],
            invalid: [],
          };
        },
      },
    },
  });
  const skillTools = skillLoader.loadModule("src/lib/tools/skillTools.ts");
  const bundle = skillTools.createSkillTools({
    skillAccessPolicy: {
      allowedSkillNames: ["skills-creator"],
      allowedSkillBaseDirs: ["skills-creator"],
      allowSkillInventory: true,
      allowSkillManagement: false,
    },
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "filtered-skill-list",
    name: "SkillsManager",
    arguments: { action: "list" },
  });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /skills=1/);
  assert.match(result.content[0].text, /skills-creator/);
  assert.doesNotMatch(result.content[0].text, /metaphysics-steward/);
  assert.equal(result.details.skillsCount, 1);
});

test("SkillsManager read errors route sibling Skill files back to file tools", async () => {
  const skillLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command) {
          assert.equal(command, "system_manage_skill");
          throw new Error("Failed to resolve the Skill file: No such file or directory (os error 2)");
        },
      },
    },
  });
  const skillTools = skillLoader.loadModule("src/lib/tools/skillTools.ts");
  const bundle = skillTools.createSkillTools();

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "skill-read-missing-sibling",
    name: "SkillsManager",
    arguments: {
      action: "read",
      path: "global-memory/settings.json",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /SkillsManager\(action="read"\) is for Skill entry files/);
  assert.match(result.content[0].text, /looks like a sibling file inside a Skill/);
  assert.match(result.content[0].text, /Read\/List\/Glob\/Grep using path="skill:\/\/global-memory\/\.\.\."/);
  assert.match(result.content[0].text, /Do not use Bash cat\/ls\/find\/grep/);
});

test("SkillsManager create action builds payload and refreshes skill discovery", async () => {
  const invocations = [];
  const events = [];
  const changes = [];
  const skillLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          assert.equal(command, "system_manage_skill");
          const action = args.payload.action;
          if (action === "create") {
            return {
              action,
              rootDir: "/Users/me/.liveagent/skills",
              created: {
                name: "workflow-skill",
                target: "/Users/me/.liveagent/skills/workflow-skill",
                backup: null,
                skillFile: "workflow-skill/SKILL.md",
              },
            };
          }
          if (action === "validate") {
            return {
              action,
              rootDir: "/Users/me/.liveagent/skills",
              validation: {
                name: "workflow-skill",
                target: "/Users/me/.liveagent/skills/workflow-skill",
                ok: true,
                errors: [],
              },
            };
          }
          if (action === "package") {
            return {
              action,
              rootDir: "/Users/me/.liveagent/skills",
              package: {
                name: "workflow-skill",
                target: "/Users/me/.liveagent/skills/workflow-skill",
                archive: "/Users/me/.liveagent/skills/.packages/workflow-skill.skill",
              },
            };
          }
          throw new Error(`unexpected action ${action}`);
        },
      },
    },
  });
  const skillTools = skillLoader.loadModule("src/lib/tools/skillTools.ts");
  const policy = {
    allowedSkillNames: ["skills-creator", "skills-installer"],
    allowedSkillBaseDirs: ["skills-creator", "skills-installer"],
    allowSkillInventory: false,
    allowSkillManagement: true,
  };
  const bundle = skillTools.createSkillTools({
    skillAccessPolicy: policy,
    onManagedSkillsChanged(change) {
      changes.push(change);
    },
  });
  const previousWindow = globalThis.window;
  globalThis.window = {
    dispatchEvent(event) {
      events.push(event.type);
    },
  };

  try {
    const result = await bundle.executeToolCall({
      type: "toolCall",
      id: "skill-create",
      name: "SkillsManager",
      arguments: {
        action: "create",
        name: "workflow-skill",
        description: "Capture a repeated workflow",
        body: "## Workflow\n\n1. Do the thing.",
        files: [{ path: "references/notes.md", content: "Notes" }],
        conflict: "fail",
      },
    });

    assert.equal(result.isError, false);
    assert.equal(result.details.kind, "manage_skill");
    assert.equal(result.details.action, "create");
    assert.equal(result.details.createdName, "workflow-skill");
    assert.equal(result.details.target, "/Users/me/.liveagent/skills/workflow-skill");
    assert.match(result.content[0].text, /pathScheme=skill:\/\/<baseDir>\/\.\.\./);
    assert.match(result.content[0].text, /target=skill:\/\/workflow-skill/);
    assert.match(result.content[0].text, /skillFile=workflow-skill\/SKILL\.md/);
    assert.match(result.content[0].text, /enabled=true/);
    assert.doesNotMatch(result.content[0].text, /\/Users\/me\/\.liveagent\/skills/);
    assert.deepEqual(policy.allowedSkillNames, [
      "skills-creator",
      "skills-installer",
      "workflow-skill",
    ]);
    assert.deepEqual(policy.allowedSkillBaseDirs, [
      "skills-creator",
      "skills-installer",
      "workflow-skill",
    ]);
    assert.deepEqual(changes, [
      {
        action: "create",
        names: ["workflow-skill"],
        baseDirs: ["workflow-skill"],
      },
    ]);

    const validateResult = await bundle.executeToolCall({
      type: "toolCall",
      id: "skill-validate",
      name: "SkillsManager",
      arguments: {
        action: "validate",
        name: "workflow-skill",
      },
    });
    assert.equal(validateResult.isError, false);
    assert.equal(validateResult.details.validationOk, true);

    const packageResult = await bundle.executeToolCall({
      type: "toolCall",
      id: "skill-package",
      name: "SkillsManager",
      arguments: {
        action: "package",
        name: "workflow-skill",
      },
    });
    assert.equal(packageResult.isError, false);
    assert.match(packageResult.content[0].text, /archive=skill:\/\/\.packages\/workflow-skill\.skill/);
    assert.deepEqual(events, ["liveagent:skills-discovery-updated"]);
    assert.deepEqual(invocations, [
      {
        command: "system_manage_skill",
        args: {
          payload: {
            action: "create",
            name: "workflow-skill",
            description: "Capture a repeated workflow",
            body: "## Workflow\n\n1. Do the thing.",
            files: [{ path: "references/notes.md", content: "Notes" }],
            conflict: "fail",
          },
        },
      },
      {
        command: "system_manage_skill",
        args: {
          payload: {
            action: "validate",
            name: "workflow-skill",
          },
        },
      },
      {
        command: "system_manage_skill",
        args: {
          payload: {
            action: "package",
            name: "workflow-skill",
          },
        },
      },
    ]);
  } finally {
    if (typeof previousWindow === "undefined") {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("Image file tool returns display image details and inline image content", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          return {
            kind: "image",
            path: "uploads/001.jpg",
            mimeType: "image/jpeg",
            data: "abc123",
            sizeBytes: 12,
            mtimeMs: 10,
            contentHash: "hash",
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  assert.deepEqual(bundle.tools.map((tool) => tool.name).slice(0, 2), ["Read", "Image"]);
  assert.equal(bundle.metadataByName.get("Image").kind, "display_image");
  assert.equal(bundle.metadataByName.get("Image").isReadOnly, true);

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "image-call",
    name: "Image",
    arguments: { path: "uploads/001.jpg" },
  });

  assert.equal(result.isError, false);
  assert.equal(result.toolName, "Image");
  assert.equal(result.details.kind, "display_image");
  assert.equal(result.details.path, "uploads/001.jpg");
  assert.equal(result.details.mimeType, "image/jpeg");
  assert.deepEqual(result.details.images, [
    {
      path: "uploads/001.jpg",
      scope: "workspace",
      absolutePath: "/workspace/uploads/001.jpg",
      relativePath: "uploads/001.jpg",
      displayPath: "uploads/001.jpg",
      fileId: undefined,
      sourceType: "path",
      renderMode: "inline",
      mimeType: "image/jpeg",
      sizeBytes: 12,
      mtimeMs: 10,
      contentHash: "hash",
    },
  ]);
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].mimeType, "image/jpeg");
  assert.equal(result.content[1].data, "abc123");
  assert.deepEqual(invocations, [
    {
      command: "fs_read_image_source",
      args: {
        workdir: "/workspace",
        source: "uploads/001.jpg",
        source_type: "path",
        mime_type: undefined,
      },
    },
  ]);
});

test("Image file tool reads installed Skill images through skill URLs", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          return {
            kind: "image",
            path: args.source,
            mimeType: "image/png",
            data: "skill-image",
            sizeBytes: 64,
            mtimeMs: 12,
            contentHash: "skill-hash",
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
    fileState: fileToolState.createFileToolState(),
  });

  const imageTool = bundle.tools.find((tool) => tool.name === "Image");
  assert.doesNotMatch(JSON.stringify(imageTool.parameters), /"root"/);
  assert.equal(imageTool.parameters.additionalProperties, false);
  assert.match(JSON.stringify(imageTool.parameters), /skill:\/\//);

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "image-skill-call",
    name: "Image",
    arguments: { path: "skill://demo/assets/logo.png" },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "display_image");
  assert.equal(result.details.images[0].scope, "skill");
  assert.equal(result.details.images[0].path, "skill://demo/assets/logo.png");
  assert.equal(result.details.images[0].relativePath, "demo/assets/logo.png");
  assert.ok(!("pathRef" in result.details.images[0]));
  assert.match(result.content[0].text, /Display image: skill:\/\/demo\/assets\/logo\.png/);
  assert.deepEqual(invocations, [
    {
      command: "fs_read_image_source",
      args: {
        workdir: "/Users/me/.liveagent/skills",
        source: "demo/assets/logo.png",
        source_type: "path",
        mime_type: undefined,
      },
    },
  ]);
});

test("Image file tool normalizes absolute workspace and Skill image paths", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          return {
            kind: "image",
            path: args.source,
            mimeType: "image/png",
            data: "image-bytes",
            sizeBytes: 64,
            mtimeMs: 12,
            contentHash: "image-hash",
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
    fileState: fileToolState.createFileToolState(),
  });

  const workspaceResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "absolute-workspace-image",
    name: "Image",
    arguments: { path: "/workspace/uploads/logo.png" },
  });
  assert.equal(workspaceResult.isError, false);
  assert.equal(workspaceResult.details.images[0].scope, "workspace");
  assert.equal(workspaceResult.details.images[0].path, "uploads/logo.png");

  const skillsResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "absolute-skill-image",
    name: "Image",
    arguments: { path: "/Users/me/.liveagent/skills/demo/assets/logo.png" },
  });
  assert.equal(skillsResult.isError, false);
  assert.equal(skillsResult.details.images[0].scope, "skill");
  assert.equal(skillsResult.details.images[0].path, "skill://demo/assets/logo.png");

  const homeSkillsResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "home-skill-image",
    name: "Image",
    arguments: { path: "~/.liveagent/skills/demo/assets/logo.png" },
  });
  assert.equal(homeSkillsResult.isError, false);
  assert.equal(homeSkillsResult.details.images[0].scope, "skill");
  assert.equal(homeSkillsResult.details.images[0].path, "skill://demo/assets/logo.png");
  assert.deepEqual(
    invocations.map((call) => [call.args.workdir, call.args.source]),
    [
      ["/workspace", "uploads/logo.png"],
      ["/Users/me/.liveagent/skills", "demo/assets/logo.png"],
      ["/Users/me/.liveagent/skills", "demo/assets/logo.png"],
    ],
  );
});

test("Image file tool blocks fixed Skills root paths when Skills are disabled", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/Users/me/project",
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-disabled-skill-image",
    name: "Image",
    arguments: { path: "~/.liveagent/skills/demo/assets/logo.png" },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /installed Skill files, but Skills are not enabled/);
  assert.match(result.content[0].text, /skill:\/\/demo\/assets\/logo\.png/);
  assert.deepEqual(invocations, []);
});

test("Image runtime errors surface the backend message for resolved local paths", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          throw "I/O error: No such file or directory (os error 2)";
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "missing-skill-image",
    name: "Image",
    arguments: { path: "skill://demo/assets/missing.png" },
  });

  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "Image failed for skill://demo/assets/missing.png: I/O error: No such file or directory (os error 2)",
  );
  assert.doesNotMatch(result.content[0].text, /Pass the path exactly as returned/);
  assert.deepEqual(invocations, [
    {
      command: "fs_read_image_source",
      args: {
        workdir: "/Users/me/.liveagent/skills",
        source: "demo/assets/missing.png",
        source_type: "path",
        mime_type: undefined,
      },
    },
  ]);
});

test("Image base64 errors keep exact-source guidance when no path was resolved", async () => {
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command) {
          assert.equal(command, "fs_read_image_source");
          throw "unsupported image data";
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "broken-base64-image",
    name: "Image",
    arguments: { base64: "data:image/png;base64,abc123" },
  });

  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /Image failed for source="data:image\/png;base64,abc123": unsupported image data/,
  );
  assert.match(result.content[0].text, /Pass the path exactly as returned/);
  assert.match(result.content[0].text, /Do not use Bash/);
});

test("Image file tool returns multiple inline images from one call", async () => {
  const invocations = [];
  const imageByPath = new Map([
    [
      "uploads/001.jpg",
      {
        kind: "image",
        path: "uploads/001.jpg",
        mimeType: "image/jpeg",
        data: "abc123",
        sizeBytes: 12,
        mtimeMs: 10,
        contentHash: "hash-1",
      },
    ],
    [
      "uploads/002.png",
      {
        kind: "image",
        path: "uploads/002.png",
        mimeType: "image/png",
        data: "def456",
        sizeBytes: 34,
        mtimeMs: 11,
        contentHash: "hash-2",
      },
    ],
  ]);
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          return imageByPath.get(args.source);
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "image-call",
    name: "Image",
    arguments: { paths: ["uploads/001.jpg", "uploads/002.png"] },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "display_image");
  assert.equal(result.details.path, "uploads/001.jpg");
  assert.deepEqual(
    result.details.images.map((image) => image.path),
    ["uploads/001.jpg", "uploads/002.png"],
  );
  assert.equal(result.content.length, 3);
  assert.match(result.content[0].text, /Display images: 2/);
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].mimeType, "image/jpeg");
  assert.equal(result.content[1].data, "abc123");
  assert.equal(result.content[2].type, "image");
  assert.equal(result.content[2].mimeType, "image/png");
  assert.equal(result.content[2].data, "def456");
  assert.deepEqual(invocations.map((call) => call.args.source), [
    "uploads/001.jpg",
    "uploads/002.png",
  ]);
  assert.deepEqual(invocations.map((call) => call.args.source_type), ["path", "path"]);
});

test("Image file tool forwards SVG sources as inline images", async () => {
  const invocations = [];
  const svgSource = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          return {
            kind: "image",
            path: "inline-svg:image/svg+xml:40 bytes",
            mimeType: "image/svg+xml",
            data: "PHN2Zy8+",
            sizeBytes: 40,
            mtimeMs: 0,
            contentHash: "svg-hash",
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  const imageTool = bundle.tools.find((tool) => tool.name === "Image");
  assert.match(imageTool.description, /SVG images/);

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "image-call",
    name: "Image",
    arguments: { source: svgSource },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "display_image");
  assert.equal(result.details.mimeType, "image/svg+xml");
  assert.equal(result.details.images[0].mimeType, "image/svg+xml");
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].mimeType, "image/svg+xml");
  assert.equal(result.content[1].data, "PHN2Zy8+");
  assert.match(result.content[0].text, /mime=image\/svg\+xml/);
  assert.deepEqual(
    invocations.map((call) => [call.command, call.args.source_type, call.args.source]),
    [["fs_read_image_source", "auto", svgSource]],
  );
});

test("Image file tool accepts absolute paths, URLs, and base64 input", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          return {
            kind: "image",
            path:
              args.source_type === "base64"
                ? "base64:image/png:12 bytes"
                : args.source,
            mimeType: args.source_type === "url" ? "image/webp" : "image/png",
            data: `${args.source_type}-data`,
            sizeBytes: 12,
            mtimeMs: args.source_type === "path" ? 15 : 0,
            contentHash: `${args.source_type}-hash`,
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "image-call",
    name: "Image",
    arguments: {
      path: "/Users/me/Pictures/local.png",
      url: "https://example.com/remote.webp",
      base64: "data:image/png;base64,abc123",
    },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "display_image");
  assert.deepEqual(
    invocations.map((call) => [call.command, call.args.source_type, call.args.source]),
    [
      ["fs_read_image_source", "path", "/Users/me/Pictures/local.png"],
      ["fs_read_image_source", "base64", "data:image/png;base64,abc123"],
    ],
  );
  assert.deepEqual(
    result.details.images.map((image) => image.path),
    [
      "/Users/me/Pictures/local.png",
      "https://example.com/remote.webp",
      "base64:image/png:12 bytes",
    ],
  );
  assert.deepEqual(
    result.content.slice(1).map((block) => [block.type, block.mimeType, block.data]),
    [
      ["image", "image/png", "path-data"],
      ["image", "image/png", "base64-data"],
    ],
  );
  assert.equal(result.details.images[1].sourceType, "url");
  assert.equal(result.details.images[1].renderMode, "proxy");
  assert.equal(result.details.images[1].sourceUrl, "https://example.com/remote.webp");
  assert.equal(result.details.loadMode, "mixed");
});

test("Image generic source infers raw base64 image input", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          return {
            kind: "image",
            path: "base64:image/png:12 bytes",
            mimeType: "image/png",
            data: "base64-data",
            sizeBytes: 12,
            mtimeMs: 0,
            contentHash: "base64-hash",
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "image-call",
    name: "Image",
    arguments: {
      source: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ",
      mimeType: "image/png",
    },
  });

  assert.equal(result.isError, false);
  assert.deepEqual(
    invocations.map((call) => [call.command, call.args.source_type, call.args.mime_type]),
    [["fs_read_image_source", "base64", "image/png"]],
  );
});

test("custom system tools expose only selected tools for the requested runtime scope", async () => {
  const bundle = systemTools.createCustomSystemTools({
    selectedToolIds: ["http_get_test"],
    runtimeScope: "chat",
    currentChatModel: { customProviderId: "p", model: "m" },
  });

  assert.equal(bundle.groupId, "system");
  assert.deepEqual(bundle.tools.map((tool) => tool.name), ["HttpGetTest"]);
  assert.equal(bundle.metadataByName.get("HttpGetTest").isReadOnly, true);
  assert.equal(bundle.metadataByName.get("HttpGetTest").displayCategory, "system");

  const aborted = new AbortController();
  aborted.abort();
  const abortedResult = await bundle.executeToolCall(
    { id: "call-1", name: "HttpGetTest", arguments: {} },
    aborted.signal,
  );
  assert.equal(abortedResult.isError, true);
  assert.equal(abortedResult.content[0].text, "Cancelled");

  const unknownResult = await bundle.executeToolCall({
    id: "call-2",
    name: "MissingTool",
    arguments: {},
  });
  assert.equal(unknownResult.isError, true);
  assert.match(unknownResult.content[0].text, /Unknown tool/);
});

test("custom system tool options remain in sync with selectable definitions", () => {
  assert.deepEqual(systemTools.CUSTOM_SYSTEM_TOOL_OPTIONS, [
    {
      id: "http_get_test",
      label: "本地 HTTP Test",
      description: "Call the network test endpoint and return the response body.",
    },
  ]);
});

test("system tool options include user-selectable tools", () => {
  assert.deepEqual(systemToolOptions.SYSTEM_TOOL_OPTIONS, [
    {
      id: "http_get_test",
      label: "本地 HTTP Test",
      description: "Call the network test endpoint and return the response body.",
      kind: "custom",
      runtimeScopes: ["chat", "cron_auto_prompt"],
    },
  ]);
});

test("Write rejection for external paths echoes the resolved path and a corrected example", async () => {
  const resolver = new pathUtils.ToolPathResolver({ workdir: "/workspace/project" });

  await assert.rejects(
    resolver.resolvePath("/", {
      label: "Write.path",
      intent: "write",
      required: true,
    }),
    (error) => {
      assert.match(error.message, /Write\.path resolves outside the workspace and enabled Skills: \//);
      assert.match(error.message, /path="notes\.md"/);
      assert.match(error.message, /skill:\/\//);
      return true;
    },
  );
});

test("repeated identical failing calls escalate with a loop-breaking notice", async () => {
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          assert.equal(command, "fs_path_status");
          return {
            path: args.path,
            exists: true,
            kind: "dir",
            sizeBytes: 96,
            mtimeMs: 55,
            fileId: null,
          };
        },
      },
    },
  });
  const fsTools = fsLoader.loadModule("src/lib/tools/fsTools.ts");
  const fileToolState = fsLoader.loadModule("src/lib/tools/fileToolState.ts");
  const bundle = fsTools.createFsTools({
    workdir: "/workspace",
    fileState: fileToolState.createFileToolState(),
  });

  const callWriteToDirectory = (id) =>
    bundle.executeToolCall({
      type: "toolCall",
      id,
      name: "Write",
      arguments: { path: "tool-test", content: "test" },
    });

  const first = await callWriteToDirectory("loop-1");
  assert.equal(first.isError, true);
  assert.doesNotMatch(first.content[0].text, /times in a row/);

  const second = await callWriteToDirectory("loop-2");
  assert.match(second.content[0].text, /failed 2 times in a row/);
  assert.match(second.content[0].text, /Do not retry with the same arguments/);

  const third = await callWriteToDirectory("loop-3");
  assert.match(third.content[0].text, /failed 3 times in a row/);

  // Re-running the same physical tool call id must not inflate the counter.
  const replay = await callWriteToDirectory("loop-3");
  assert.match(replay.content[0].text, /failed 3 times in a row/);

  // A different failing call with the same shape keeps escalating.
  const different = await callWriteToDirectory("loop-4");
  assert.match(different.content[0].text, /failed 4 times in a row/);
});
