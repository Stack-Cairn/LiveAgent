import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));

function NullIcon() {
  return null;
}

function createCardModule(rootDir) {
  const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
  const jsxRuntime = requireFromRoot("react/jsx-runtime");
  const { renderToStaticMarkup } = requireFromRoot("react-dom/server");
  const loader = createTsModuleLoader({
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
      "@liveagent/app/components/icons": {
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
  { withActions = false, fileCount = 4 } = {},
) {
  const paths = [
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

function assertVerticalPath(html, fileName, directory, fromIndex = 0) {
  const fileNameIndex = html.indexOf(`>${fileName}</span>`, fromIndex);
  const directoryIndex = html.indexOf(`>${directory}</span>`, fileNameIndex);
  assert.notEqual(fileNameIndex, -1, `missing file name ${fileName}`);
  assert.notEqual(directoryIndex, -1, `missing directory ${directory}`);
  assert.ok(fileNameIndex < directoryIndex, `${fileName} must render above its directory`);
  return directoryIndex;
}

test("GUI changed-files rows render file names above directory paths", () => {
  const html = renderCard(createCardModule(rootDir));

  let position = assertVerticalPath(html, "ChangedFilesCard.tsx", "src/components/");
  position = assertVerticalPath(html, "README.md", ".", position);
  assertVerticalPath(html, "Settings.tsx", "src/pages/", position);

  assert.match(
    html,
    /class="[^"]*line-through[^"]*"[^>]*>removed\.ts<\/span><span[^>]*>tmp\/<\/span>/,
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

test("GUI changed-files scrolling starts with the sixth row", () => {
  const modules = createCardModule(rootDir);
  const fiveFiles = renderCard(modules, { fileCount: 5 });
  const sixFiles = renderCard(modules, { fileCount: 6 });

  assert.ok(!fiveFiles.includes("max-h-[calc(210px*var(--zone-font-scale,1))]"));
  assert.ok(!fiveFiles.includes("overscroll-contain"));
  assert.ok(sixFiles.includes("max-h-[calc(210px*var(--zone-font-scale,1))]"));
  assert.ok(sixFiles.includes("overflow-y-auto overscroll-contain"));
});

test("GUI changed-files actions include the localized action and canonical path", () => {
  const html = renderCard(createCardModule(rootDir), { withActions: true });
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
