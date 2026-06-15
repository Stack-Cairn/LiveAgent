import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const pathUtils = loader.loadModule("src/lib/tools/pathUtils.ts");
const systemTools = loader.loadModule("src/lib/tools/customSystemTools.ts");
const skillBuiltinHelpers = loader.loadModule("src/lib/skills/builtin.ts");

test("required tool paths must be relative workspace paths", () => {
  assert.equal(pathUtils.normalizeRequiredToolRelPath(" ./src\\App.tsx ", "path"), "src/App.tsx");

  for (const value of ["", ".", "..", "../secret", "/tmp/file", "C:/tmp/file", "safe:name"]) {
    assert.throws(
      () => pathUtils.normalizeRequiredToolRelPath(value, "path"),
      /path must be a relative path/,
      `expected ${value} to be rejected`,
    );
  }
});

test("optional tool paths allow empty root but reject escapes", () => {
  assert.equal(pathUtils.normalizeOptionalToolRelPath("", "path"), undefined);
  assert.equal(pathUtils.normalizeOptionalToolRelPath(".", "path"), undefined);
  assert.equal(pathUtils.normalizeOptionalToolRelPath("docs/readme.md", "path"), "docs/readme.md");

  for (const value of ["../secret", "/tmp/file", "C:/tmp/file", "foo:bar"]) {
    assert.throws(
      () => pathUtils.normalizeOptionalToolRelPath(value, "path"),
      /path must be a relative path/,
    );
  }
});

test("file tool roots default to workspace and gate skills root", () => {
  assert.equal(pathUtils.normalizeToolFileRoot(undefined, "Read.root"), "workspace");
  assert.equal(pathUtils.normalizeToolFileRoot("workspace", "Read.root"), "workspace");
  assert.equal(
    pathUtils.normalizeToolFileRoot("skills", "Read.root", { allowSkillsRoot: true }),
    "skills",
  );
  assert.throws(
    () => pathUtils.normalizeToolFileRoot("skills", "Read.root"),
    /root=skills is only available when Skills are enabled/,
  );
  assert.throws(
    () => pathUtils.normalizeToolFileRoot("home", "Read.root", { allowSkillsRoot: true }),
    /root must be workspace or skills/,
  );
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
      { name: "skills-creator" },
    ]).map((skill) => skill.name),
    ["skills-creator", "skills-installer", "a-skill", "z-skill"],
  );
  assert.equal(skillBuiltinHelpers.isUserSelectableSkillName("skills-creator"), false);
  assert.equal(skillBuiltinHelpers.isUserSelectableSkillName("workflow-skill"), true);
});

test("file tools can read from the fixed skills root without exposing absolute paths as arguments", async () => {
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
  assert.match(JSON.stringify(readTool.parameters), /"skills"/);

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "read-skill-file",
    name: "Read",
    arguments: {
      root: "skills",
      path: "skills-creator/SKILL.md",
      limit: 20,
    },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "read_text");
  assert.equal(result.details.root, "skills");
  assert.equal(result.details.path, "skills-creator/SKILL.md");
  assert.match(result.content[0].text, /Read: root=skills path=skills-creator\/SKILL\.md/);
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

test("file tools enforce enabled Skill allowlist for root=skills", async () => {
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
      root: "skills",
      path: "metaphysics-steward/SKILL.md",
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
      root: "skills",
      pattern: "metaphysics-steward/scripts/**/*",
    },
  });
  assert.equal(globResult.isError, true);
  assert.match(globResult.content[0].text, /metaphysics-steward\/scripts\/\*\*\/\*/);
  assert.deepEqual(invocations, []);
});

test("file tools allow direct mutations inside enabled Skills when mutation is granted", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          assert.equal(command, "fs_write_text");
          return {
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
      root: "skills",
      path: "demo/SKILL.md",
      content: "---\nname: demo\ndescription: Demo\n---\n",
    },
  });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Write: root=skills path=demo\/SKILL\.md/);
  assert.match(result.content[0].text, /mode=rewrite/);
  assert.deepEqual(invocations, [
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

test("file tools block direct mutations inside built-in Skills", async () => {
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
      allowedSkillNames: ["skills-creator", "skills-installer"],
      allowedSkillBaseDirs: ["skills-creator", "skills-installer"],
      allowSkillMutation: true,
    },
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-builtin-skill-write",
    name: "Write",
    arguments: {
      root: "skills",
      path: "skills-creator/SKILL.md",
      content: "---\nname: skills-creator\ndescription: Changed\n---\n",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /built-in Skill "skills-creator" is protected/);
  assert.match(result.content[0].text, /cannot be modified by the model/);
  assert.deepEqual(invocations, []);
});

test("file tools reject absolute skills paths with a root=skills retry hint", async () => {
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
    fileState: fileToolState.createFileToolState(),
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "bad-read",
    name: "Read",
    arguments: {
      path: "/Users/me/.liveagent/skills/skills-installer/SKILL.md",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Retry with root="skills"/);
  assert.match(result.content[0].text, /path="skills-installer\/SKILL\.md"/);
  assert.match(result.content[0].text, /Do not use Bash/);
  assert.deepEqual(invocations, []);
});

test("file tool runtime errors tell the model to stay on scoped file tools", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          throw new Error("I/O error: No such file or directory (os error 2)");
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
      root: "skills",
      path: "demo/missing.md",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Read failed for root=skills path=demo\/missing\.md/);
  assert.match(result.content[0].text, /Retry with root="skills", path="demo\/missing\.md"/);
  assert.match(result.content[0].text, /Use List\/Glob\/Grep with the same root to locate files/);
  assert.match(result.content[0].text, /Do not use Bash/);
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

test("Grep retries file paths as parent directory plus file_pattern", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          assert.equal(command, "fs_grep");
          if (invocations.length === 1) {
            assert.equal(args.path, "src/App.tsx");
            assert.equal(args.file_pattern, undefined);
            throw new Error("Grep.path must be a directory");
          }
          assert.equal(args.path, "src");
          assert.equal(args.file_pattern, "App.tsx");
          return {
            path: "src",
            pattern: "render",
            filePattern: "App.tsx",
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
  assert.match(result.content[0].text, /autoCorrectedPath=src\/App\.tsx file_pattern=App\.tsx/);
  assert.equal(result.details.path, "src");
  assert.equal(result.details.filePattern, "App.tsx");
  assert.equal(invocations.length, 2);
});

test("Edit auto-primes a full text snapshot before replacement", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
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
  assert.deepEqual(invocations.map((call) => call.command), ["fs_read_text", "fs_edit_text"]);
});

test("SkillsManager legacy read form is routed through manage action payload", async () => {
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
      path: "skills-installer/SKILL.md",
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
  assert.match(result.content[0].text, /root="skills"/);
  assert.match(result.content[0].text, /path="skills-installer\/\.\.\."/);
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
      allowedSkillNames: ["skills-creator", "skills-installer"],
      allowedSkillBaseDirs: ["skills-creator", "skills-installer"],
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
  assert.match(result.content[0].text, /Read\/List\/Glob\/Grep using root="skills" and path="global-memory\/\.\.\."/);
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
    assert.match(result.content[0].text, /root=skills/);
    assert.match(result.content[0].text, /target=skills:workflow-skill/);
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
    assert.match(packageResult.content[0].text, /archive=skills:\.packages\/workflow-skill\.skill/);
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

test("Image file tool reads installed Skill images through root=skills", async () => {
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
  assert.match(JSON.stringify(imageTool.parameters), /"skills"/);

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "image-skill-call",
    name: "Image",
    arguments: { root: "skills", path: "demo/assets/logo.png" },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "display_image");
  assert.equal(result.details.images[0].root, "skills");
  assert.equal(result.details.images[0].path, "demo/assets/logo.png");
  assert.match(result.content[0].text, /Display image: root=skills path=demo\/assets\/logo\.png/);
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

test("Image file tool rejects absolute workspace and Skill paths with scoped retry hints", async () => {
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
    fileState: fileToolState.createFileToolState(),
  });

  const workspaceResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "bad-workspace-image",
    name: "Image",
    arguments: { path: "/workspace/uploads/logo.png" },
  });
  assert.equal(workspaceResult.isError, true);
  assert.match(
    workspaceResult.content[0].text,
    /Retry with root="workspace" \(or omit root\), path="uploads\/logo\.png"/,
  );
  assert.match(workspaceResult.content[0].text, /Do not use Bash/);

  const skillsResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "bad-skill-image",
    name: "Image",
    arguments: { path: "/Users/me/.liveagent/skills/demo/assets/logo.png" },
  });
  assert.equal(skillsResult.isError, true);
  assert.match(skillsResult.content[0].text, /Retry with root="skills", path="demo\/assets\/logo\.png"/);
  assert.match(skillsResult.content[0].text, /Do not use Bash/);

  const homeSkillsResult = await bundle.executeToolCall({
    type: "toolCall",
    id: "bad-home-skill-image",
    name: "Image",
    arguments: { path: "~/.liveagent/skills/demo/assets/logo.png" },
  });
  assert.equal(homeSkillsResult.isError, true);
  assert.match(
    homeSkillsResult.content[0].text,
    /Retry with root="skills", path="demo\/assets\/logo\.png"/,
  );
  assert.match(homeSkillsResult.content[0].text, /Do not use Bash/);
  assert.deepEqual(invocations, []);
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
  assert.match(result.content[0].text, /fixed Skills root.*blocked/);
  assert.match(result.content[0].text, /Enable the Skill.*root="skills", path="demo\/assets\/logo\.png"/);
  assert.deepEqual(invocations, []);
});

test("Image runtime errors tell the model to retry with scoped image paths", async () => {
  const invocations = [];
  const fsLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          throw new Error("I/O error: No such file or directory (os error 2)");
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
    arguments: { root: "skills", path: "demo/assets/missing.png" },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Image failed for root=skills path=demo\/assets\/missing\.png/);
  assert.match(result.content[0].text, /Retry with root="skills", path="demo\/assets\/missing\.png"/);
  assert.match(result.content[0].text, /Use List\/Glob\/Grep with the same root to locate files/);
  assert.match(result.content[0].text, /Do not use Bash/);
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

test("CrateBay sandbox system tools are default-off until selected", () => {
  const bundle = systemTools.createCustomSystemTools({
    selectedToolIds: [],
    runtimeScope: "chat",
  });

  assert.deepEqual(bundle.tools, []);
  assert.equal(bundle.metadataByName.has("CrateBayStatus"), false);
  assert.ok(
    systemTools.CRATEBAY_SYSTEM_TOOL_IDS.length > 0,
    "CrateBay tool ids should still be available for explicit selection",
  );
});

test("custom system tool options remain in sync with selectable definitions", () => {
  assert.deepEqual(systemTools.CUSTOM_SYSTEM_TOOL_OPTIONS, [
    {
      id: "http_get_test",
      label: "本地 HTTP Test",
      description: "Call the network test endpoint and return the response body.",
    },
    {
      id: "cratebay_status",
      label: "CrateBay Status",
      description:
        "Check whether the optional CrateBay sandbox backend is installed and report CrateBay Engine VM state.",
    },
    {
      id: "cratebay_install",
      label: "CrateBay Install",
      description:
        "Download, verify, and install the optional CrateBay headless sandbox backend from GitHub Releases.",
    },
    {
      id: "cratebay_list_containers",
      label: "CrateBay Containers",
      description: "List CrateBay sandbox containers through the CrateBay Engine CLI surface.",
    },
    {
      id: "cratebay_create_container",
      label: "CrateBay Create",
      description: "Create a real CrateBay sandbox container through the CrateBay Engine CLI surface.",
    },
    {
      id: "cratebay_run",
      label: "CrateBay Run",
      description:
        "Run a one-shot sandbox container through the CrateBay Engine CLI surface and return captured output.",
    },
    {
      id: "cratebay_sandbox_run",
      label: "CrateBay Sandbox Run",
      description:
        "Start CrateBay Engine if needed, create an ephemeral CrateBay pod, run a one-shot container through the native Engine API, and clean up the pod by default.",
    },
    {
      id: "cratebay_exec",
      label: "CrateBay Exec",
      description:
        "Execute a command inside an existing CrateBay sandbox container through the CrateBay Engine CLI surface.",
    },
    {
      id: "cratebay_logs",
      label: "CrateBay Logs",
      description: "Read logs from an existing CrateBay sandbox container through the CrateBay Engine CLI surface.",
    },
    {
      id: "cratebay_remove_container",
      label: "CrateBay Remove",
      description: "Remove a CrateBay sandbox container through the CrateBay Engine CLI surface.",
    },
    {
      id: "cratebay_runtime_status",
      label: "CrateBay Engine VM",
      description: "Read the CrateBay-managed Engine VM status.",
    },
    {
      id: "cratebay_runtime_start",
      label: "CrateBay Engine VM Start",
      description: "Start the CrateBay-managed Engine VM.",
    },
    {
      id: "cratebay_runtime_stop",
      label: "CrateBay Engine VM Stop",
      description: "Stop the CrateBay-managed Engine VM.",
    },
    {
      id: "cratebay_engine_status",
      label: "CrateBay Engine Status",
      description: "Read the native CrateBay Engine contract from the installed sandbox backend.",
    },
    {
      id: "cratebay_engine_substrate",
      label: "CrateBay Engine Substrate",
      description: "Inspect the CrateBay-owned VM, containerd shim lifecycle, CNI network manager, storage manager, and compatibility endpoint.",
    },
    {
      id: "cratebay_engine_storage_gc",
      label: "CrateBay Storage GC",
      description: "Run CrateBay storage garbage collection for exited sandbox metadata/logs. Defaults to dry-run unless apply is true.",
    },
    {
      id: "cratebay_engine_shim_tasks",
      label: "CrateBay Shim Tasks",
      description: "List CrateBay-managed containerd shim tasks and their lifecycle state.",
    },
    {
      id: "cratebay_engine_shim_reap",
      label: "CrateBay Reap Shim Task",
      description: "Reap exited CrateBay shim task metadata/logs. Defaults to dry-run unless apply is true.",
    },
    {
      id: "cratebay_engine_containers",
      label: "CrateBay Native Containers",
      description: "List containers through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_images",
      label: "CrateBay Native Images",
      description: "List images through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_pull_image",
      label: "CrateBay Native Pull Image",
      description: "Pull an image through the native CrateBay Engine API using containerd first.",
    },
    {
      id: "cratebay_engine_inspect_image",
      label: "CrateBay Native Inspect Image",
      description: "Inspect an image through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_remove_image",
      label: "CrateBay Native Remove Image",
      description: "Remove an image through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_tag_image",
      label: "CrateBay Native Tag Image",
      description: "Tag an image through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_pack_image",
      label: "CrateBay Native Pack Image",
      description:
        "Pack a running CrateBay container root filesystem into an image through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_export_images",
      label: "CrateBay Native Export Images",
      description: "Export one or more images into a tar archive through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_import_image",
      label: "CrateBay Native Import Image",
      description: "Import an image tar archive through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_networks",
      label: "CrateBay Native Networks",
      description: "List CrateBay-managed CNI networks through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_inspect_network",
      label: "CrateBay Native Inspect Network",
      description: "Inspect a CrateBay-managed CNI network, including IPAM and attached containers.",
    },
    {
      id: "cratebay_engine_create_network",
      label: "CrateBay Native Create Network",
      description: "Create a CrateBay-managed bridge CNI network through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_remove_network",
      label: "CrateBay Native Remove Network",
      description: "Remove a network through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_volumes",
      label: "CrateBay Native Volumes",
      description: "List volumes through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_inspect_volume",
      label: "CrateBay Native Inspect Volume",
      description: "Inspect a CrateBay-managed storage volume, including path and size.",
    },
    {
      id: "cratebay_engine_create_volume",
      label: "CrateBay Native Create Volume",
      description: "Create a volume through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_remove_volume",
      label: "CrateBay Native Remove Volume",
      description: "Remove a volume through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_pods",
      label: "CrateBay Native Pods",
      description: "List CrateBay-managed pod networks through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_create_pod",
      label: "CrateBay Native Create Pod",
      description: "Create a CrateBay-managed pod network backed by CNI through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_remove_pod",
      label: "CrateBay Native Remove Pod",
      description: "Remove a pod through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_attach_pod",
      label: "CrateBay Native Attach Pod",
      description: "Attach a container to a CrateBay-managed pod through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_detach_pod",
      label: "CrateBay Native Detach Pod",
      description: "Detach a container from a CrateBay-managed pod through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_create",
      label: "CrateBay Native Create",
      description:
        "Create a container through the native CrateBay Engine API as a containerd-managed task with bind/volume mounts.",
    },
    {
      id: "cratebay_engine_start",
      label: "CrateBay Native Start",
      description: "Start a container through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_stop",
      label: "CrateBay Native Stop",
      description: "Stop a container through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_remove",
      label: "CrateBay Native Remove",
      description: "Remove a container through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_inspect",
      label: "CrateBay Native Inspect",
      description: "Inspect a container through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_stats",
      label: "CrateBay Native Stats",
      description: "Read CPU and memory stats through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_logs",
      label: "CrateBay Native Logs",
      description: "Read container logs through the native CrateBay Engine API.",
    },
    {
      id: "cratebay_engine_exec",
      label: "CrateBay Native Exec",
      description:
        "Execute a command through the native CrateBay Engine API using containerd for CrateBay-managed tasks.",
    },
    {
      id: "cratebay_engine_terminal_open",
      label: "CrateBay Native Terminal Open",
      description: "Open a native CrateBay Engine PTY terminal session in a running container.",
    },
    {
      id: "cratebay_engine_terminal_input",
      label: "CrateBay Native Terminal Input",
      description: "Send input to a native CrateBay Engine PTY terminal session.",
    },
    {
      id: "cratebay_engine_terminal_read",
      label: "CrateBay Native Terminal Read",
      description: "Read pending output from a native CrateBay Engine PTY terminal session.",
    },
    {
      id: "cratebay_engine_terminal_resize",
      label: "CrateBay Native Terminal Resize",
      description: "Resize a native CrateBay Engine PTY terminal session.",
    },
    {
      id: "cratebay_engine_terminal_close",
      label: "CrateBay Native Terminal Close",
      description: "Close a native CrateBay Engine PTY terminal session.",
    },
  ]);
});

test("CrateBay sandbox run starts runtime, runs in an ephemeral pod, and cleans up", async () => {
  const invocations = [];
  const cratebayLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "cratebay_status") {
            return {
              installed: true,
              repository: "nicepkg/CrateBay",
              installDir: "/tmp/liveagent/cratebay-sandbox",
              binaryPath: "/tmp/liveagent/cratebay-sandbox/bin/cratebay",
            };
          }
          if (command === "cratebay_runtime_start") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: { state: "ready", engineResponsive: true },
            };
          }
          if (command === "cratebay_engine_pod_create") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: { name: args.name, driver: args.driver ?? "bridge" },
            };
          }
          if (command === "cratebay_engine_container_run") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: { exitCode: 0, stdout: "sandbox-pod-ok" },
            };
          }
          assert.equal(command, "cratebay_engine_pod_remove");
          return {
            ok: true,
            exitCode: 0,
            stdout: "",
            stderr: "",
            json: { removed: args.name },
          };
        },
      },
    },
  });
  const cratebaySystemTools = cratebayLoader.loadModule("src/lib/tools/customSystemTools.ts");
  const bundle = cratebaySystemTools.createCustomSystemTools({
    selectedToolIds: ["cratebay_sandbox_run"],
    runtimeScope: "chat",
  });

  assert.deepEqual(bundle.tools.map((tool) => tool.name), ["CrateBaySandboxRun"]);

  const result = await bundle.executeToolCall({
    id: "sandbox-run-1",
    name: "CrateBaySandboxRun",
    arguments: {
      image: "cratebay-ubuntu-base:v1",
      command: ["sh", "-lc", "printf sandbox-pod-ok"],
      pod_name: "liveagent-test-pod",
      env: ["A=1"],
      volume: ["/workspace:/workspace"],
      working_dir: "/workspace",
      driver: "bridge",
      no_pull: true,
      timeout: 20,
      max_output_bytes: 4096,
    },
  });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /liveagent-test-pod/);
  assert.match(result.content[0].text, /sandbox-pod-ok/);
  assert.equal(result.details.kind, "cratebay_sandbox_run");
  assert.equal(result.details.keepPod, false);
  assert.deepEqual(
    result.details.steps.map((step) => step.name),
    ["runtime_start", "pod_create", "container_run", "pod_cleanup"],
  );
  assert.deepEqual(invocations, [
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_runtime_start",
      args: {},
    },
    {
      command: "cratebay_engine_pod_create",
      args: {
        name: "liveagent-test-pod",
        driver: "bridge",
        internal: undefined,
        enable_ipv6: undefined,
      },
    },
    {
      command: "cratebay_engine_container_run",
      args: {
        request: {
          image: "cratebay-ubuntu-base:v1",
          command: ["sh", "-lc", "printf sandbox-pod-ok"],
          name: undefined,
          env: ["A=1"],
          volume: ["/workspace:/workspace"],
          cpu: undefined,
          memory: undefined,
          workingDir: "/workspace",
          entrypoint: undefined,
          pod: "liveagent-test-pod",
          network: undefined,
          user: undefined,
          readOnly: undefined,
          noPull: true,
          remove: true,
          keep: undefined,
          timeout: 20,
          maxOutputBytes: 4096,
        },
      },
    },
    {
      command: "cratebay_engine_pod_remove",
      args: {
        name: "liveagent-test-pod",
      },
    },
  ]);
});

test("CrateBay sandbox run cleans up the pod after a failed container run", async () => {
  const invocations = [];
  const cratebayLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "cratebay_status") {
            return {
              installed: true,
              repository: "nicepkg/CrateBay",
              installDir: "/tmp/liveagent/cratebay-sandbox",
              binaryPath: "/tmp/liveagent/cratebay-sandbox/bin/cratebay",
            };
          }
          if (command === "cratebay_runtime_start") {
            return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { state: "ready" } };
          }
          if (command === "cratebay_engine_pod_create") {
            return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { name: args.name } };
          }
          if (command === "cratebay_engine_container_run") {
            return {
              ok: false,
              exitCode: 42,
              stdout: "",
              stderr: "boom",
              json: { exitCode: 42, stderr: "boom" },
            };
          }
          assert.equal(command, "cratebay_engine_pod_remove");
          return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { removed: args.name } };
        },
      },
    },
  });
  const cratebaySystemTools = cratebayLoader.loadModule("src/lib/tools/customSystemTools.ts");
  const bundle = cratebaySystemTools.createCustomSystemTools({
    selectedToolIds: ["cratebay_sandbox_run"],
    runtimeScope: "chat",
  });

  const result = await bundle.executeToolCall({
    id: "sandbox-run-failed",
    name: "CrateBaySandboxRun",
    arguments: {
      command: ["sh", "-lc", "exit 42"],
      pod_name: "liveagent-failed-pod",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /CrateBay sandbox container run failed/);
  assert.deepEqual(
    result.details.steps.map((step) => [step.name, step.ok]),
    [
      ["runtime_start", true],
      ["pod_create", true],
      ["container_run", false],
      ["pod_cleanup", true],
    ],
  );
  assert.deepEqual(
    invocations.map((item) => item.command),
    [
      "cratebay_status",
      "cratebay_runtime_start",
      "cratebay_engine_pod_create",
      "cratebay_engine_container_run",
      "cratebay_engine_pod_remove",
    ],
  );
});

test("CrateBay sandbox run still cleans up a created pod after cancellation", async () => {
  const invocations = [];
  const controller = new AbortController();
  const cratebayLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "cratebay_status") {
            return {
              installed: true,
              repository: "nicepkg/CrateBay",
              installDir: "/tmp/liveagent/cratebay-sandbox",
              binaryPath: "/tmp/liveagent/cratebay-sandbox/bin/cratebay",
            };
          }
          if (command === "cratebay_runtime_start") {
            return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { state: "ready" } };
          }
          if (command === "cratebay_engine_pod_create") {
            controller.abort();
            return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { name: args.name } };
          }
          assert.equal(command, "cratebay_engine_pod_remove");
          return { ok: true, exitCode: 0, stdout: "", stderr: "", json: { removed: args.name } };
        },
      },
    },
  });
  const cratebaySystemTools = cratebayLoader.loadModule("src/lib/tools/customSystemTools.ts");
  const bundle = cratebaySystemTools.createCustomSystemTools({
    selectedToolIds: ["cratebay_sandbox_run"],
    runtimeScope: "chat",
  });

  const result = await bundle.executeToolCall(
    {
      id: "sandbox-run-cancelled",
      name: "CrateBaySandboxRun",
      arguments: {
        command: ["sh", "-lc", "printf should-not-run"],
        pod_name: "liveagent-cancelled-pod",
      },
    },
    controller.signal,
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Cancelled/);
  assert.deepEqual(
    result.details.steps.map((step) => step.name),
    ["runtime_start", "pod_create", "pod_cleanup"],
  );
  assert.deepEqual(
    invocations.map((item) => item.command),
    [
      "cratebay_status",
      "cratebay_runtime_start",
      "cratebay_engine_pod_create",
      "cratebay_engine_pod_remove",
    ],
  );
});

test("CrateBay system tools return install-required results when sandbox is absent", async () => {
  const invocations = [];
  const cratebayLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          assert.equal(command, "cratebay_status");
          return {
            installed: false,
            repository: "nicepkg/CrateBay",
            installDir: "/tmp/liveagent/cratebay-sandbox",
          };
        },
      },
    },
  });
  const cratebaySystemTools = cratebayLoader.loadModule("src/lib/tools/customSystemTools.ts");
  const bundle = cratebaySystemTools.createCustomSystemTools({
    selectedToolIds: ["cratebay_list_containers"],
    runtimeScope: "chat",
  });

  assert.deepEqual(bundle.tools.map((tool) => tool.name), ["CrateBayListContainers"]);

  const result = await bundle.executeToolCall({
    id: "cratebay-list",
    name: "CrateBayListContainers",
    arguments: { all: true },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /CrateBay sandbox is not installed/);
  assert.equal(result.details.kind, "cratebay_install_required");
  assert.deepEqual(invocations, [
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
  ]);
});

test("CrateBay system tools invoke backend commands with normalized payloads when installed", async () => {
  const invocations = [];
  const cratebayLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "cratebay_status") {
            return {
              installed: true,
              repository: "nicepkg/CrateBay",
              installDir: "/tmp/liveagent/cratebay-sandbox",
              binaryPath: "/tmp/liveagent/cratebay-sandbox/bin/cratebay",
            };
          }
          if (command === "cratebay_engine_containers") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.containers.v1",
                count: 1,
                items: [{ id: "sandbox-1", name: "sandbox-demo" }],
              },
            };
          }
          assert.equal(command, "cratebay_engine_container_run");
          return {
            ok: true,
            exitCode: 0,
            stdout: "",
            stderr: "",
            json: {
              exitCode: 0,
              stdout: "sandbox-ok",
            },
          };
        },
      },
    },
  });
  const cratebaySystemTools = cratebayLoader.loadModule("src/lib/tools/customSystemTools.ts");
  const bundle = cratebaySystemTools.createCustomSystemTools({
    selectedToolIds: ["cratebay_list_containers", "cratebay_run"],
    runtimeScope: "chat",
  });

  assert.deepEqual(bundle.tools.map((tool) => tool.name), ["CrateBayListContainers", "CrateBayRun"]);

  const listResult = await bundle.executeToolCall({
    id: "cratebay-list",
    name: "CrateBayListContainers",
    arguments: { all: true },
  });
  const result = await bundle.executeToolCall({
    id: "cratebay-run",
    name: "CrateBayRun",
    arguments: {
      image: "cratebay-ubuntu-base:v1",
      command: ["sh", "-lc", "printf sandbox-ok"],
      env: ["A=1"],
      volume: ["/workspace:/workspace"],
      working_dir: "/workspace",
      network: "none",
      no_pull: true,
      remove: false,
      timeout: 30,
      max_output_bytes: 4096,
    },
  });

  assert.equal(listResult.isError, false);
  assert.match(listResult.content[0].text, /cratebay.containers.v1/);
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /sandbox-ok/);
  assert.deepEqual(invocations, [
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_containers",
      args: {},
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_container_run",
      args: {
        request: {
          image: "cratebay-ubuntu-base:v1",
          command: ["sh", "-lc", "printf sandbox-ok"],
          name: undefined,
          env: ["A=1"],
          volume: ["/workspace:/workspace"],
          cpu: undefined,
          memory: undefined,
          workingDir: "/workspace",
          entrypoint: undefined,
          pod: undefined,
          network: "none",
          user: undefined,
          readOnly: undefined,
          noPull: true,
          remove: false,
          keep: undefined,
          timeout: 30,
          maxOutputBytes: 4096,
        },
      },
    },
  ]);
});

test("CrateBay exec and logs system tools route installed backend payloads", async () => {
  const invocations = [];
  const cratebayLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "cratebay_status") {
            return {
              installed: true,
              repository: "nicepkg/CrateBay",
              installDir: "/tmp/liveagent/cratebay-sandbox",
              binaryPath: "/tmp/liveagent/cratebay-sandbox/bin/cratebay",
            };
          }
          if (command === "cratebay_engine_container_exec") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: { exitCode: 0, stdout: "exec-ok" },
            };
          }
          assert.equal(command, "cratebay_engine_container_logs");
          return {
            ok: true,
            exitCode: 0,
            stdout: "log-ok\n",
            stderr: "",
          };
        },
      },
    },
  });
  const cratebaySystemTools = cratebayLoader.loadModule("src/lib/tools/customSystemTools.ts");
  const bundle = cratebaySystemTools.createCustomSystemTools({
    selectedToolIds: ["cratebay_exec", "cratebay_logs"],
    runtimeScope: "chat",
  });

  const execResult = await bundle.executeToolCall({
    id: "cratebay-exec",
    name: "CrateBayExec",
    arguments: {
      id: "sandbox-1",
      command: ["sh", "-lc", "printf exec-ok"],
      working_dir: "/workspace",
      timeout: 10,
      max_output_bytes: 2048,
    },
  });
  const logsResult = await bundle.executeToolCall({
    id: "cratebay-logs",
    name: "CrateBayLogs",
    arguments: {
      id: "sandbox-1",
      tail: 50,
      timestamps: true,
    },
  });

  assert.equal(execResult.isError, false);
  assert.match(execResult.content[0].text, /exec-ok/);
  assert.equal(logsResult.isError, false);
  assert.match(logsResult.content[0].text, /log-ok/);
  assert.deepEqual(invocations, [
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_container_exec",
      args: {
        request: {
          id: "sandbox-1",
          command: ["sh", "-lc", "printf exec-ok"],
          workingDir: "/workspace",
          timeout: 10,
          maxOutputBytes: 2048,
        },
      },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_container_logs",
      args: {
        request: {
          id: "sandbox-1",
          tail: 50,
          timestamps: true,
        },
      },
    },
  ]);
});

test("CrateBay create and remove system tools route installed backend payloads", async () => {
  const invocations = [];
  const cratebayLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "cratebay_status") {
            return {
              installed: true,
              repository: "nicepkg/CrateBay",
              installDir: "/tmp/liveagent/cratebay-sandbox",
              binaryPath: "/tmp/liveagent/cratebay-sandbox/bin/cratebay",
            };
          }
          return {
            ok: true,
            exitCode: 0,
            stdout: "",
            stderr: "",
            json: { ok: true },
          };
        },
      },
    },
  });
  const cratebaySystemTools = cratebayLoader.loadModule("src/lib/tools/customSystemTools.ts");
  const bundle = cratebaySystemTools.createCustomSystemTools({
    selectedToolIds: ["cratebay_create_container", "cratebay_remove_container"],
    runtimeScope: "chat",
  });

  const createResult = await bundle.executeToolCall({
    id: "cratebay-create",
    name: "CrateBayCreateContainer",
    arguments: {
      name: "sandbox-created",
      image: "cratebay-ubuntu-base:v1",
      command: "sleep 60",
      env: ["A=1"],
      network: "none",
      no_start: true,
      cpu: 2,
      memory: 512,
    },
  });
  const removeResult = await bundle.executeToolCall({
    id: "cratebay-remove",
    name: "CrateBayRemoveContainer",
    arguments: {
      id: "sandbox-created",
      force: true,
    },
  });

  assert.equal(createResult.isError, false);
  assert.equal(removeResult.isError, false);
  assert.deepEqual(invocations, [
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_container_create",
      args: {
        request: {
          name: "sandbox-created",
          image: "cratebay-ubuntu-base:v1",
          cpu: 2,
          memory: 512,
          command: "sleep 60",
          entrypoint: undefined,
          workingDir: undefined,
          env: ["A=1"],
          publish: undefined,
          volume: undefined,
          pod: undefined,
          network: "none",
          user: undefined,
          readOnly: undefined,
          noStart: true,
        },
      },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_container_remove",
      args: {
        id: "sandbox-created",
        force: true,
      },
    },
  ]);
});

test("CrateBay native engine system tools route installed backend commands", async () => {
  const invocations = [];
  const cratebayLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "cratebay_status") {
            return {
              installed: true,
              repository: "nicepkg/CrateBay",
              installDir: "/tmp/liveagent/cratebay-sandbox",
              binaryPath: "/tmp/liveagent/cratebay-sandbox/bin/cratebay",
            };
          }
          if (command === "cratebay_engine_status") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: { name: "CrateBay Engine", kind: "cratebay-containerd" },
            };
          }
          if (command === "cratebay_engine_substrate") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.substrate.v1",
                engine: "CrateBay Engine",
                shim: { manager: "cratebay-containerd-shim" },
                network: { manager: "cratebay-cni" },
                storage: { manager: "cratebay-storage" },
              },
            };
          }
          if (command === "cratebay_engine_shim_tasks") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.shim.tasks.v1",
                count: 1,
                items: [{ id: "abc123", state: "exited", pid: 0, managedBy: "cratebay-containerd-shim" }],
              },
            };
          }
          if (command === "cratebay_engine_shim_reap") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.shim.reap.v1",
                id: "abc123",
                applied: false,
                reaped: false,
              },
            };
          }
          if (command === "cratebay_engine_storage_gc") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.storage.gc.v1",
                applied: false,
                dryRun: true,
                candidateCount: 0,
              },
            };
          }
          if (command === "cratebay_engine_containers") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.containers.v1",
                count: 1,
                items: [{ id: "abc123", name: "sandbox-demo" }],
              },
            };
          }
          if (command === "cratebay_engine_images") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.images.v1",
                count: 1,
                items: [{ id: "sha256:abc123", repository: "cratebay-ubuntu-base", tag: "v1" }],
              },
            };
          }
          if (command === "cratebay_engine_image_pull") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.image.pull.v1",
                image: "alpine:latest",
                pulled: true,
              },
            };
          }
          if (command === "cratebay_engine_image_inspect") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.image.inspect.v1",
                id: "sha256:abc123",
                imageRef: "docker.io/library/alpine:latest",
                backend: "containerd",
              },
            };
          }
          if (command === "cratebay_engine_image_remove") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.image.remove.v1",
                id: "sha256:abc123",
                removed: true,
                backend: "containerd",
              },
            };
          }
          if (command === "cratebay_engine_image_tag") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.image.tag.v1",
                source: "alpine:latest",
                target: "sandbox:latest",
                tagged: true,
                backend: "containerd",
              },
            };
          }
          if (command === "cratebay_engine_image_pack") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.image.pack.v1",
                container: "abc123",
                image: "sandbox-pack:latest",
                packed: true,
                backend: "containerd",
              },
            };
          }
          if (command === "cratebay_engine_image_export") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.image.export.v1",
                images: ["sandbox:latest"],
                output: "/tmp/sandbox.tar",
                bytes: 128,
                backend: "containerd",
              },
            };
          }
          if (command === "cratebay_engine_image_import") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.image.import.v1",
                images: ["sandbox:latest"],
                imported: true,
                backend: "containerd",
              },
            };
          }
          if (command === "cratebay_engine_networks") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.networks.v1",
                count: 1,
                items: [{ id: "net123", name: "pod-demo", driver: "bridge" }],
              },
            };
          }
          if (command === "cratebay_engine_network_inspect") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.network.inspect.v1",
                id: "net123",
                name: "pod-demo",
                driver: "bridge",
                managedBy: "cratebay-cni",
                containers: ["abc123"],
              },
            };
          }
          if (command === "cratebay_engine_network_create") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.network.create.v1",
                id: "net123",
                name: "pod-demo",
                created: true,
              },
            };
          }
          if (command === "cratebay_engine_network_remove") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.network.remove.v1",
                id: "net123",
                removed: true,
              },
            };
          }
          if (command === "cratebay_engine_volumes") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.volumes.v1",
                count: 1,
                items: [{ name: "workspace-cache", driver: "local" }],
              },
            };
          }
          if (command === "cratebay_engine_volume_inspect") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.volume.inspect.v1",
                name: "workspace-cache",
                driver: "local",
                managedBy: "cratebay-storage",
                sizeBytes: 4096,
              },
            };
          }
          if (command === "cratebay_engine_volume_create") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.volume.create.v1",
                name: "workspace-cache",
                created: true,
              },
            };
          }
          if (command === "cratebay_engine_volume_remove") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.volume.remove.v1",
                name: "workspace-cache",
                removed: true,
              },
            };
          }
          if (command === "cratebay_engine_pods") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.pods.v1",
                count: 1,
                items: [{ id: "pod123", name: "demo-pod", driver: "bridge", containerCount: 0 }],
              },
            };
          }
          if (command === "cratebay_engine_pod_create") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.pod.create.v1",
                id: "pod123",
                name: "demo-pod",
                driver: "bridge",
                created: true,
              },
            };
          }
          if (command === "cratebay_engine_pod_remove") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.pod.remove.v1",
                name: "demo-pod",
                removed: true,
              },
            };
          }
          if (command === "cratebay_engine_pod_attach") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.pod.attach.v1",
                pod: "demo-pod",
                container: "abc123",
                attached: true,
              },
            };
          }
          if (command === "cratebay_engine_pod_detach") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.pod.detach.v1",
                pod: "demo-pod",
                container: "abc123",
                detached: true,
              },
            };
          }
          if (command === "cratebay_engine_container_create") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.container.create.v1",
                id: "abc123",
                name: "sandbox-demo",
                image: "alpine:latest",
                started: false,
              },
            };
          }
          if (command === "cratebay_engine_container_start") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: { api: "cratebay.container.start.v1", id: "abc123", state: "started" },
            };
          }
          if (command === "cratebay_engine_container_stop") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: { api: "cratebay.container.stop.v1", id: "abc123", state: "stopped" },
            };
          }
          if (command === "cratebay_engine_container_remove") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: { api: "cratebay.container.remove.v1", id: "abc123", removed: true },
            };
          }
          if (command === "cratebay_engine_container_inspect") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.container.inspect.v1",
                item: { id: "abc123", name: "sandbox-demo", state: { Status: "running" } },
              },
            };
          }
          if (command === "cratebay_engine_container_stats") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.container.stats.v1",
                id: "abc123",
                name: "sandbox-demo",
                backend: "containerd",
                cpu: { percent: 12.5, coresUsed: 0.125 },
                memory: { usedMb: 1, limitMb: 4, percent: 25 },
              },
            };
          }
          if (command === "cratebay_engine_container_logs") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.container.logs.v1",
                id: "abc123",
                stdout: "ready\n",
                stderr: "",
                logs: "ready\n",
              },
            };
          }
          if (command === "cratebay_engine_container_exec") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.container.exec.v1",
                id: "abc123",
                command: ["echo", "ok"],
                exitCode: 0,
                stdout: "ok\n",
                stderr: "",
              },
            };
          }
          if (command === "cratebay_engine_terminal_open") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.container.terminal.open.v1",
                backend: "containerd-pty",
                transport: "cratebay-native-pty",
                sessionId: "term-1",
              },
            };
          }
          if (command === "cratebay_engine_terminal_input") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.container.terminal.input.v1",
                sessionId: "term-1",
                bytes: 3,
              },
            };
          }
          if (command === "cratebay_engine_terminal_read") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.container.terminal.read.v1",
                sessionId: "term-1",
                chunks: [{ stream: "stdout", data: "ok\n" }],
                running: true,
              },
            };
          }
          if (command === "cratebay_engine_terminal_resize") {
            return {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              json: {
                api: "cratebay.container.terminal.resize.v1",
                sessionId: "term-1",
                resized: true,
                cols: 120,
                rows: 33,
              },
            };
          }
          assert.equal(command, "cratebay_engine_terminal_close");
          return {
            ok: true,
            exitCode: 0,
            stdout: "",
            stderr: "",
            json: {
              api: "cratebay.container.terminal.close.v1",
              sessionId: "term-1",
              closed: true,
            },
          };
        },
      },
    },
  });
  const cratebaySystemTools = cratebayLoader.loadModule("src/lib/tools/customSystemTools.ts");
  const bundle = cratebaySystemTools.createCustomSystemTools({
    selectedToolIds: [
      "cratebay_engine_status",
      "cratebay_engine_substrate",
      "cratebay_engine_storage_gc",
      "cratebay_engine_shim_tasks",
      "cratebay_engine_shim_reap",
      "cratebay_engine_containers",
      "cratebay_engine_images",
      "cratebay_engine_pull_image",
      "cratebay_engine_inspect_image",
      "cratebay_engine_remove_image",
      "cratebay_engine_tag_image",
      "cratebay_engine_pack_image",
      "cratebay_engine_export_images",
      "cratebay_engine_import_image",
      "cratebay_engine_networks",
      "cratebay_engine_inspect_network",
      "cratebay_engine_create_network",
      "cratebay_engine_remove_network",
      "cratebay_engine_volumes",
      "cratebay_engine_inspect_volume",
      "cratebay_engine_create_volume",
      "cratebay_engine_remove_volume",
      "cratebay_engine_pods",
      "cratebay_engine_create_pod",
      "cratebay_engine_remove_pod",
      "cratebay_engine_attach_pod",
      "cratebay_engine_detach_pod",
      "cratebay_engine_create",
      "cratebay_engine_start",
      "cratebay_engine_stop",
      "cratebay_engine_remove",
      "cratebay_engine_inspect",
      "cratebay_engine_stats",
      "cratebay_engine_logs",
      "cratebay_engine_exec",
      "cratebay_engine_terminal_open",
      "cratebay_engine_terminal_input",
      "cratebay_engine_terminal_read",
      "cratebay_engine_terminal_resize",
      "cratebay_engine_terminal_close",
    ],
    runtimeScope: "chat",
  });

  const statusResult = await bundle.executeToolCall({
    id: "cratebay-engine-status",
    name: "CrateBayEngineStatus",
    arguments: {},
  });
  const substrateResult = await bundle.executeToolCall({
    id: "cratebay-engine-substrate",
    name: "CrateBayEngineSubstrate",
    arguments: {},
  });
  const storageGcResult = await bundle.executeToolCall({
    id: "cratebay-engine-storage-gc",
    name: "CrateBayStorageGc",
    arguments: { apply: false },
  });
  const shimTasksResult = await bundle.executeToolCall({
    id: "cratebay-engine-shim-tasks",
    name: "CrateBayShimTasks",
    arguments: {},
  });
  const shimReapResult = await bundle.executeToolCall({
    id: "cratebay-engine-shim-reap",
    name: "CrateBayReapShimTask",
    arguments: { id: "abc123", apply: false },
  });
  const containersResult = await bundle.executeToolCall({
    id: "cratebay-engine-containers",
    name: "CrateBayNativeContainers",
    arguments: {},
  });
  const imagesResult = await bundle.executeToolCall({
    id: "cratebay-engine-images",
    name: "CrateBayNativeImages",
    arguments: {},
  });
  const pullImageResult = await bundle.executeToolCall({
    id: "cratebay-engine-pull-image",
    name: "CrateBayNativePullImage",
    arguments: { image: "alpine", tag: "latest" },
  });
  const inspectImageResult = await bundle.executeToolCall({
    id: "cratebay-engine-inspect-image",
    name: "CrateBayNativeInspectImage",
    arguments: { id: "sha256:abc123" },
  });
  const removeImageResult = await bundle.executeToolCall({
    id: "cratebay-engine-remove-image",
    name: "CrateBayNativeRemoveImage",
    arguments: { id: "sha256:abc123", force: true },
  });
  const tagImageResult = await bundle.executeToolCall({
    id: "cratebay-engine-tag-image",
    name: "CrateBayNativeTagImage",
    arguments: { source: "alpine:latest", target: "sandbox:latest" },
  });
  const packImageResult = await bundle.executeToolCall({
    id: "cratebay-engine-pack-image",
    name: "CrateBayNativePackImage",
    arguments: { container: "abc123", image: "sandbox-pack:latest" },
  });
  const exportImagesResult = await bundle.executeToolCall({
    id: "cratebay-engine-export-images",
    name: "CrateBayNativeExportImages",
    arguments: { images: ["sandbox:latest"], output: "/tmp/sandbox.tar" },
  });
  const importImageResult = await bundle.executeToolCall({
    id: "cratebay-engine-import-image",
    name: "CrateBayNativeImportImage",
    arguments: { input: "/tmp/sandbox.tar" },
  });
  const networksResult = await bundle.executeToolCall({
    id: "cratebay-engine-networks",
    name: "CrateBayNativeNetworks",
    arguments: {},
  });
  const inspectNetworkResult = await bundle.executeToolCall({
    id: "cratebay-engine-inspect-network",
    name: "CrateBayNativeInspectNetwork",
    arguments: { id: "net123" },
  });
  const createNetworkResult = await bundle.executeToolCall({
    id: "cratebay-engine-create-network",
    name: "CrateBayNativeCreateNetwork",
    arguments: { name: "pod-demo", driver: "bridge", internal: true, enable_ipv6: true },
  });
  const removeNetworkResult = await bundle.executeToolCall({
    id: "cratebay-engine-remove-network",
    name: "CrateBayNativeRemoveNetwork",
    arguments: { id: "net123" },
  });
  const volumesResult = await bundle.executeToolCall({
    id: "cratebay-engine-volumes",
    name: "CrateBayNativeVolumes",
    arguments: {},
  });
  const inspectVolumeResult = await bundle.executeToolCall({
    id: "cratebay-engine-inspect-volume",
    name: "CrateBayNativeInspectVolume",
    arguments: { name: "workspace-cache" },
  });
  const createVolumeResult = await bundle.executeToolCall({
    id: "cratebay-engine-create-volume",
    name: "CrateBayNativeCreateVolume",
    arguments: { name: "workspace-cache", driver: "local" },
  });
  const removeVolumeResult = await bundle.executeToolCall({
    id: "cratebay-engine-remove-volume",
    name: "CrateBayNativeRemoveVolume",
    arguments: { name: "workspace-cache" },
  });
  const podsResult = await bundle.executeToolCall({
    id: "cratebay-engine-pods",
    name: "CrateBayNativePods",
    arguments: {},
  });
  const createPodResult = await bundle.executeToolCall({
    id: "cratebay-engine-create-pod",
    name: "CrateBayNativeCreatePod",
    arguments: { name: "demo-pod", driver: "bridge", internal: true, enable_ipv6: true },
  });
  const removePodResult = await bundle.executeToolCall({
    id: "cratebay-engine-remove-pod",
    name: "CrateBayNativeRemovePod",
    arguments: { name: "demo-pod" },
  });
  const attachPodResult = await bundle.executeToolCall({
    id: "cratebay-engine-attach-pod",
    name: "CrateBayNativeAttachPod",
    arguments: { name: "demo-pod", container: "abc123" },
  });
  const detachPodResult = await bundle.executeToolCall({
    id: "cratebay-engine-detach-pod",
    name: "CrateBayNativeDetachPod",
    arguments: { name: "demo-pod", container: "abc123", force: true },
  });
  const createResult = await bundle.executeToolCall({
    id: "cratebay-engine-create",
    name: "CrateBayNativeCreate",
    arguments: {
      name: "sandbox-demo",
      image: "alpine:latest",
      command: "sleep 60",
      env: ["A=1"],
      publish: ["8080:80/tcp"],
      volume: ["/tmp:/tmp:ro"],
      pod: "demo-pod",
      read_only: true,
      no_start: true,
      cpu: 1,
      memory: 256,
    },
  });
  const startResult = await bundle.executeToolCall({
    id: "cratebay-engine-start",
    name: "CrateBayNativeStart",
    arguments: { id: "abc123" },
  });
  const stopResult = await bundle.executeToolCall({
    id: "cratebay-engine-stop",
    name: "CrateBayNativeStop",
    arguments: { id: "abc123", timeout: 5 },
  });
  const removeResult = await bundle.executeToolCall({
    id: "cratebay-engine-remove",
    name: "CrateBayNativeRemove",
    arguments: { id: "abc123", force: true },
  });
  const inspectResult = await bundle.executeToolCall({
    id: "cratebay-engine-inspect",
    name: "CrateBayNativeInspect",
    arguments: { id: "abc123" },
  });
  const statsResult = await bundle.executeToolCall({
    id: "cratebay-engine-stats",
    name: "CrateBayNativeStats",
    arguments: { id: "abc123" },
  });
  const logsResult = await bundle.executeToolCall({
    id: "cratebay-engine-logs",
    name: "CrateBayNativeLogs",
    arguments: { id: "abc123", tail: 20, timestamps: true },
  });
  const execResult = await bundle.executeToolCall({
    id: "cratebay-engine-exec",
    name: "CrateBayNativeExec",
    arguments: {
      id: "abc123",
      command: ["echo", "ok"],
      working_dir: "/workspace",
      timeout: 10,
      max_output_bytes: 2048,
    },
  });
  const terminalOpenResult = await bundle.executeToolCall({
    id: "cratebay-engine-terminal-open",
    name: "CrateBayNativeTerminalOpen",
    arguments: {
      id: "abc123",
      session_id: "term-1",
      working_dir: "/workspace",
      cols: 80,
      rows: 24,
      command: ["/bin/sh"],
    },
  });
  const terminalInputResult = await bundle.executeToolCall({
    id: "cratebay-engine-terminal-input",
    name: "CrateBayNativeTerminalInput",
    arguments: { id: "abc123", session_id: "term-1", data: "ls\n" },
  });
  const terminalReadResult = await bundle.executeToolCall({
    id: "cratebay-engine-terminal-read",
    name: "CrateBayNativeTerminalRead",
    arguments: { id: "abc123", session_id: "term-1" },
  });
  const terminalResizeResult = await bundle.executeToolCall({
    id: "cratebay-engine-terminal-resize",
    name: "CrateBayNativeTerminalResize",
    arguments: { id: "abc123", session_id: "term-1", cols: 120, rows: 33 },
  });
  const terminalCloseResult = await bundle.executeToolCall({
    id: "cratebay-engine-terminal-close",
    name: "CrateBayNativeTerminalClose",
    arguments: { id: "abc123", session_id: "term-1" },
  });

  assert.equal(statusResult.isError, false);
  assert.match(statusResult.content[0].text, /cratebay-containerd/);
  assert.equal(substrateResult.isError, false);
  assert.match(substrateResult.content[0].text, /cratebay-containerd-shim/);
  assert.equal(storageGcResult.isError, false);
  assert.match(storageGcResult.content[0].text, /cratebay.storage.gc.v1/);
  assert.equal(shimTasksResult.isError, false);
  assert.match(shimTasksResult.content[0].text, /cratebay.shim.tasks.v1/);
  assert.equal(shimReapResult.isError, false);
  assert.match(shimReapResult.content[0].text, /cratebay.shim.reap.v1/);
  assert.equal(containersResult.isError, false);
  assert.match(containersResult.content[0].text, /cratebay.containers.v1/);
  assert.equal(imagesResult.isError, false);
  assert.match(imagesResult.content[0].text, /cratebay.images.v1/);
  assert.equal(pullImageResult.isError, false);
  assert.match(pullImageResult.content[0].text, /cratebay.image.pull.v1/);
  assert.equal(inspectImageResult.isError, false);
  assert.match(inspectImageResult.content[0].text, /cratebay.image.inspect.v1/);
  assert.equal(removeImageResult.isError, false);
  assert.match(removeImageResult.content[0].text, /cratebay.image.remove.v1/);
  assert.equal(tagImageResult.isError, false);
  assert.match(tagImageResult.content[0].text, /cratebay.image.tag.v1/);
  assert.equal(packImageResult.isError, false);
  assert.match(packImageResult.content[0].text, /cratebay.image.pack.v1/);
  assert.equal(exportImagesResult.isError, false);
  assert.match(exportImagesResult.content[0].text, /cratebay.image.export.v1/);
  assert.equal(importImageResult.isError, false);
  assert.match(importImageResult.content[0].text, /cratebay.image.import.v1/);
  assert.equal(networksResult.isError, false);
  assert.match(networksResult.content[0].text, /cratebay.networks.v1/);
  assert.equal(inspectNetworkResult.isError, false);
  assert.match(inspectNetworkResult.content[0].text, /cratebay.network.inspect.v1/);
  assert.equal(createNetworkResult.isError, false);
  assert.match(createNetworkResult.content[0].text, /cratebay.network.create.v1/);
  assert.equal(removeNetworkResult.isError, false);
  assert.match(removeNetworkResult.content[0].text, /cratebay.network.remove.v1/);
  assert.equal(volumesResult.isError, false);
  assert.match(volumesResult.content[0].text, /cratebay.volumes.v1/);
  assert.equal(inspectVolumeResult.isError, false);
  assert.match(inspectVolumeResult.content[0].text, /cratebay.volume.inspect.v1/);
  assert.equal(createVolumeResult.isError, false);
  assert.match(createVolumeResult.content[0].text, /cratebay.volume.create.v1/);
  assert.equal(removeVolumeResult.isError, false);
  assert.match(removeVolumeResult.content[0].text, /cratebay.volume.remove.v1/);
  assert.equal(podsResult.isError, false);
  assert.match(podsResult.content[0].text, /cratebay.pods.v1/);
  assert.equal(createPodResult.isError, false);
  assert.match(createPodResult.content[0].text, /cratebay.pod.create.v1/);
  assert.equal(removePodResult.isError, false);
  assert.match(removePodResult.content[0].text, /cratebay.pod.remove.v1/);
  assert.equal(attachPodResult.isError, false);
  assert.match(attachPodResult.content[0].text, /cratebay.pod.attach.v1/);
  assert.equal(detachPodResult.isError, false);
  assert.match(detachPodResult.content[0].text, /cratebay.pod.detach.v1/);
  assert.equal(createResult.isError, false);
  assert.match(createResult.content[0].text, /cratebay.container.create.v1/);
  assert.equal(startResult.isError, false);
  assert.match(startResult.content[0].text, /cratebay.container.start.v1/);
  assert.equal(stopResult.isError, false);
  assert.match(stopResult.content[0].text, /cratebay.container.stop.v1/);
  assert.equal(removeResult.isError, false);
  assert.match(removeResult.content[0].text, /cratebay.container.remove.v1/);
  assert.equal(inspectResult.isError, false);
  assert.match(inspectResult.content[0].text, /cratebay.container.inspect.v1/);
  assert.equal(statsResult.isError, false);
  assert.match(statsResult.content[0].text, /cratebay.container.stats.v1/);
  assert.equal(logsResult.isError, false);
  assert.match(logsResult.content[0].text, /cratebay.container.logs.v1/);
  assert.equal(execResult.isError, false);
  assert.match(execResult.content[0].text, /cratebay.container.exec.v1/);
  assert.equal(terminalOpenResult.isError, false);
  assert.match(terminalOpenResult.content[0].text, /cratebay-native-pty/);
  assert.equal(terminalInputResult.isError, false);
  assert.match(terminalInputResult.content[0].text, /cratebay.container.terminal.input.v1/);
  assert.equal(terminalReadResult.isError, false);
  assert.match(terminalReadResult.content[0].text, /cratebay.container.terminal.read.v1/);
  assert.equal(terminalResizeResult.isError, false);
  assert.match(terminalResizeResult.content[0].text, /cratebay.container.terminal.resize.v1/);
  assert.equal(terminalCloseResult.isError, false);
  assert.match(terminalCloseResult.content[0].text, /cratebay.container.terminal.close.v1/);
  assert.deepEqual(invocations, [
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_status",
      args: {},
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_substrate",
      args: {},
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_storage_gc",
      args: { apply: false, prune_exited_containers: true },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_shim_tasks",
      args: {},
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_shim_reap",
      args: { id: "abc123", apply: false },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_containers",
      args: {},
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_images",
      args: {},
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_image_pull",
      args: { image: "alpine", tag: "latest" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_image_inspect",
      args: { id: "sha256:abc123" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_image_remove",
      args: { id: "sha256:abc123", force: true },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_image_tag",
      args: { source: "alpine:latest", target: "sandbox:latest" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_image_pack",
      args: { container: "abc123", image: "sandbox-pack:latest" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_image_export",
      args: { images: ["sandbox:latest"], output: "/tmp/sandbox.tar" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_image_import",
      args: { input: "/tmp/sandbox.tar" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_networks",
      args: {},
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_network_inspect",
      args: { id: "net123" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_network_create",
      args: {
        name: "pod-demo",
        driver: "bridge",
        internal: true,
        enable_ipv6: true,
      },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_network_remove",
      args: { id: "net123" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_volumes",
      args: {},
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_volume_inspect",
      args: { name: "workspace-cache" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_volume_create",
      args: { name: "workspace-cache", driver: "local" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_volume_remove",
      args: { name: "workspace-cache" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_pods",
      args: {},
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_pod_create",
      args: {
        name: "demo-pod",
        driver: "bridge",
        internal: true,
        enable_ipv6: true,
      },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_pod_remove",
      args: { name: "demo-pod" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_pod_attach",
      args: { name: "demo-pod", container: "abc123" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_pod_detach",
      args: { name: "demo-pod", container: "abc123", force: true },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_container_create",
      args: {
        request: {
          name: "sandbox-demo",
          image: "alpine:latest",
          cpu: 1,
          memory: 256,
          command: "sleep 60",
          entrypoint: undefined,
          workingDir: undefined,
          env: ["A=1"],
          publish: ["8080:80/tcp"],
          volume: ["/tmp:/tmp:ro"],
          pod: "demo-pod",
          network: undefined,
          user: undefined,
          readOnly: true,
          noStart: true,
        },
      },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_container_start",
      args: { id: "abc123" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_container_stop",
      args: { id: "abc123", timeout: 5 },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_container_remove",
      args: { id: "abc123", force: true },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_container_inspect",
      args: { id: "abc123" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_container_stats",
      args: { id: "abc123" },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_container_logs",
      args: {
        request: {
          id: "abc123",
          tail: 20,
          timestamps: true,
        },
      },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_container_exec",
      args: {
        request: {
          id: "abc123",
          command: ["echo", "ok"],
          workingDir: "/workspace",
          timeout: 10,
          maxOutputBytes: 2048,
        },
      },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_terminal_open",
      args: {
        request: {
          id: "abc123",
          sessionId: "term-1",
          workingDir: "/workspace",
          cols: 80,
          rows: 24,
          command: ["/bin/sh"],
        },
      },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_terminal_input",
      args: {
        request: {
          id: "abc123",
          sessionId: "term-1",
          data: "ls\n",
        },
      },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_terminal_read",
      args: {
        request: {
          id: "abc123",
          sessionId: "term-1",
        },
      },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_terminal_resize",
      args: {
        request: {
          id: "abc123",
          sessionId: "term-1",
          cols: 120,
          rows: 33,
        },
      },
    },
    {
      command: "cratebay_status",
      args: { include_prerelease: false },
    },
    {
      command: "cratebay_engine_terminal_close",
      args: {
        request: {
          id: "abc123",
          sessionId: "term-1",
        },
      },
    },
  ]);
});
