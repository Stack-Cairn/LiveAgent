import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const commonSettingsCss = await readFile(
  new URL("../../../agent-ui/src/styles/common-settings.css", import.meta.url),
  "utf8",
);

test("shared settings dialogs override the legacy hidden panel baseline", () => {
  assert.match(
    commonSettingsCss,
    /\.settings-modal-panel\[data-slot="dialog-content"\]\s*\{[^}]*opacity:\s*1;/s,
  );
  assert.match(
    commonSettingsCss,
    /\.settings-modal-panel\[data-slot="dialog-content"\]\[data-starting-style\]/,
  );
  assert.match(
    commonSettingsCss,
    /\.settings-modal-panel\[data-slot="dialog-content"\]\[data-ending-style\]/,
  );
});
