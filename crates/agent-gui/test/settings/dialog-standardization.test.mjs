import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dialogSource = await readFile(
  new URL("../../../agent-ui/src/components/ui/dialog.tsx", import.meta.url),
  "utf8",
);
const commonSettingsCss = await readFile(
  new URL("../../../agent-ui/src/styles/common-settings.css", import.meta.url),
  "utf8",
);

test("shared Dialog owns modal visibility and motion", () => {
  assert.match(dialogSource, /data-slot="dialog-overlay"/);
  assert.match(dialogSource, /data-slot="dialog-viewport"/);
  assert.match(dialogSource, /data-slot="dialog-content"/);
  assert.match(dialogSource, /data-\[starting-style\]:opacity-0/);
  assert.match(dialogSource, /data-\[ending-style\]:opacity-0/);
  assert.doesNotMatch(
    commonSettingsCss,
    /settings-modal-(?:overlay|panel)|modal-dialog-(?:backdrop|popup|viewport)|ssh-forward-dialog/,
  );
});
