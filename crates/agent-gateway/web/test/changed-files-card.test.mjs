import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

function NullIcon() {
  return null;
}

function createCardModule() {
  const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
  const jsxRuntime = requireFromRoot("react/jsx-runtime");
  const { renderToStaticMarkup } = requireFromRoot("react-dom/server");
  const loader = createWebModuleLoader({
    rootDir,
    mocks: {
      "react/jsx-runtime": jsxRuntime,
      "@liveagent/ui/i18n/index": {
        useLocale() {
          return {
            t(key) {
              return key;
            },
          };
        },
      },
      "@liveagent/ui/components/IconSet": {
        ChevronDown: NullIcon,
        FilePenLine: NullIcon,
        FolderTree: NullIcon,
        GitCommitHorizontal: NullIcon,
      },
      "@liveagent/ui/components/chat/fileTypeIcons": {
        getFileTypeIcon() {
          return NullIcon;
        },
      },
      "@liveagent/ui/components/chat/FileChangeBadge": {
        FileChangeBadge() {
          return null;
        },
      },
    },
  });

  return {
    cardModule: loader.loadModule("@liveagent/ui/components/chat/ChangedFilesCard.tsx"),
    jsxRuntime,
    renderToStaticMarkup,
  };
}

function renderCard(
  { cardModule, jsxRuntime, renderToStaticMarkup },
  { withActions = false, fileCount = 4, files } = {},
) {
  const paths = files ?? [
    { path: "src/components/ChangedFilesCard.tsx", deleted: false },
    { path: "README.md", deleted: false },
    { path: "src\\pages\\Settings.tsx", deleted: false },
    { path: "tmp/removed.ts", deleted: true },
    { path: "src/features/fifth.ts", deleted: false },
    { path: "src/features/sixth.ts", deleted: false },
  ];
  const summary = {
    files: paths.slice(0, fileCount).map((file, index) => ({
      ...file,
      added: index + 1,
      removed: index,
      lastToolCallId: `call-${index}`,
    })),
    totalAdded: 11,
    totalRemoved: 8,
  };

  const card = jsxRuntime.jsx(cardModule.ChangedFilesCard, { summary });
  if (!withActions) return renderToStaticMarkup(card);

  return renderToStaticMarkup(
    jsxRuntime.jsx(cardModule.ChangedFilesActionsProvider, {
      value: {
        onOpenFile() {},
        onRevealInFileTree() {},
        onOpenDiff() {},
      },
      children: card,
    }),
  );
}

function assertInlinePath(html, fileName, directory, fromIndex = 0) {
  const fileNameIndex = html.indexOf(`>${fileName}</span>`, fromIndex);
  assert.notEqual(fileNameIndex, -1, `missing file name ${fileName}`);
  if (!directory) return fileNameIndex;
  const directoryIndex = html.indexOf(`>${directory}</span>`, fromIndex);
  assert.notEqual(directoryIndex, -1, `missing directory ${directory}`);
  return Math.max(fileNameIndex, directoryIndex);
}

test("WebUI changed-files rows render file names and directory paths inline", () => {
  const html = renderCard(createCardModule());

  let position = assertInlinePath(html, "ChangedFilesCard.tsx", "src/components/");
  position = assertInlinePath(html, "README.md", null, position);
  assertInlinePath(html, "Settings.tsx", "src/pages/", position);

  assert.match(
    html,
    /<span[^>]*>tmp\/<\/span><span[^>]*line-through[^>]*>removed\.ts<\/span>/,
  );
  for (const filePath of [
    "src/components/ChangedFilesCard.tsx",
    "README.md",
    "src\\pages\\Settings.tsx",
    "tmp/removed.ts",
  ]) {
    assert.ok(html.includes(`title="${filePath}"`), `missing full-path tooltip for ${filePath}`);
  }
  assert.doesNotMatch(html, /aria-label="chat\.changedFiles\.(?:open|reveal|diff):/);
});

test("WebUI changed-files rows collapse after the fifth file", () => {
  const modules = createCardModule();
  const fiveFiles = renderCard(modules, { fileCount: 5 });
  const sixFiles = renderCard(modules, { fileCount: 6 });

  assert.ok(!fiveFiles.includes('aria-expanded="false"'));
  assert.ok(!fiveFiles.includes("chat.changedFiles.expand"));
  assert.ok(sixFiles.includes('aria-expanded="false"'));
  assert.ok(sixFiles.includes("chat.changedFiles.expand"));
  assert.ok(!sixFiles.includes("overflow-y-auto"));
});

test("WebUI changed-files actions include the localized action and canonical path", () => {
  const html = renderCard(createCardModule(), { withActions: true });
  const nestedPath = "src/components/ChangedFilesCard.tsx";

  for (const action of ["open", "reveal", "diff"]) {
    const label = `chat.changedFiles.${action}: ${nestedPath}`;
    assert.ok(html.includes(`aria-label="${label}"`), `missing accessible ${action} label`);
    assert.ok(html.includes(`title="${label}"`), `missing ${action} tooltip`);
  }

  assert.ok(
    html.includes('aria-label="chat.changedFiles.reveal: tmp/removed.ts"'),
    "deleted files should retain their available row actions",
  );
  assert.ok(
    !html.includes('aria-label="chat.changedFiles.open: tmp/removed.ts"'),
    "deleted files must not expose the open-file action",
  );
});

test("WebUI changed-files actions hide workspace-only controls for Skill paths", () => {
  const modules = createCardModule();
  const skillPath = "skill://demo/SKILL.md";
  const deletedSkillPath = "skill://demo/removed.md";
  const skillOnlyHtml = renderCard(modules, {
    withActions: true,
    fileCount: 2,
    files: [
      { path: skillPath, deleted: false },
      { path: deletedSkillPath, deleted: true },
    ],
  });

  assert.ok(skillOnlyHtml.includes(`aria-label="chat.changedFiles.open: ${skillPath}"`));
  for (const path of [skillPath, deletedSkillPath]) {
    assert.ok(!skillOnlyHtml.includes(`aria-label="chat.changedFiles.reveal: ${path}"`));
    assert.ok(!skillOnlyHtml.includes(`aria-label="chat.changedFiles.diff: ${path}"`));
  }
  assert.ok(!skillOnlyHtml.includes(`aria-label="chat.changedFiles.open: ${deletedSkillPath}"`));
  assert.ok(!skillOnlyHtml.includes(">chat.changedFiles.review</button>"));

  const workspacePath = "src/app.ts";
  const mixedHtml = renderCard(modules, {
    withActions: true,
    fileCount: 2,
    files: [
      { path: skillPath, deleted: false },
      { path: workspacePath, deleted: false },
    ],
  });
  assert.ok(mixedHtml.includes(`aria-label="chat.changedFiles.open: ${skillPath}"`));
  assert.ok(!mixedHtml.includes(`aria-label="chat.changedFiles.diff: ${skillPath}"`));
  assert.ok(mixedHtml.includes(`aria-label="chat.changedFiles.diff: ${workspacePath}"`));
  assert.ok(mixedHtml.includes(">chat.changedFiles.review</button>"));
});
