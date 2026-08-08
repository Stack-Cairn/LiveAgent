import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const notesRoot = loader.loadModule("src/lib/notes/root.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");
const rightDockModel = loader.loadModule("src/components/project-tools/rightDockModel.ts");

test("notes helpers recognize editable markdown paths and default names", () => {
  assert.equal(notesRoot.isNotesEditablePath("inbox/todo.md"), true);
  assert.equal(notesRoot.isNotesEditablePath("inbox/todo.MDX"), true);
  assert.equal(notesRoot.isNotesEditablePath("inbox/todo.txt"), true);
  assert.equal(notesRoot.isNotesEditablePath("inbox/todo.markdown"), true);
  assert.equal(notesRoot.isNotesEditablePath("inbox/todo.json"), false);
  assert.match(notesRoot.defaultNewNoteName(), /^note-\d{8}-\d{4}\.md$/);
});

test("right dock registers notes as a global singleton tool tab", () => {
  assert.ok(settings.RIGHT_DOCK_TOOL_KINDS.includes("notes"));
  assert.equal(settings.GLOBAL_NOTES_DOCK_PATH_KEY, "__global-notes__");
  assert.equal(settings.RIGHT_DOCK_SINGLETON_TAB_IDS.notes, "tool:notes");
  assert.equal(rightDockModel.NOTES_TAB_ID, "tool:notes");
  assert.equal(rightDockModel.rightDockTabRequiresProject("notes"), false);

  const opened = settings.openRightDockToolTabState(
    settings.normalizeRightDockProjectState({}),
    "notes",
  );
  assert.ok(opened.tools.notes);
  assert.equal(opened.activeTabId, "tool:notes");
  assert.ok(opened.tabOrder.includes("tool:notes"));
  assert.deepEqual(
    rightDockModel.getRightDockVisibleTabs({
      backgroundTasksVisible: false,
      localSessions: [],
      projectPathKey: "",
      projectState: opened,
      tunnelAvailable: false,
    }),
    [{ id: "tool:notes", kind: "notes" }],
  );
});
