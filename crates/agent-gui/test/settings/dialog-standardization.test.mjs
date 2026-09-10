import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dialogSource = await readFile(
  new URL("../../../agent-ui/src/components/ui/dialog.tsx", import.meta.url),
  "utf8",
);
const alertDialogSource = await readFile(
  new URL(
    "../../../agent-ui/src/components/ui/alert-dialog.tsx",
    import.meta.url,
  ),
  "utf8",
);
const retainedCssSource = await Promise.all(
  [
    "../../../agent-ui/src/styles/base.css",
    "../../../agent-gui/src/index.css",
    "../../../agent-gateway/web/src/index.css",
  ].map((file) => readFile(new URL(file, import.meta.url), "utf8")),
).then((sources) => sources.join("\n"));

const retiredDialogCss =
  /settings-modal-(?:overlay|panel|header|subheader|body|footer|actions|step-row)|(?:external-link|history-share)-modal-(?:overlay|panel)|modal-dialog-(?:backdrop|popup|viewport)|ssh-forward-dialog/;

test("shared Dialog owns modal visibility and motion", () => {
  assert.match(dialogSource, /data-slot="dialog-overlay"/);
  assert.match(dialogSource, /data-slot="dialog-viewport"/);
  assert.match(dialogSource, /data-slot="dialog-content"/);
  assert.match(dialogSource, /pt-safe-top/);
  assert.match(dialogSource, /pb-safe-bottom/);
  assert.match(
    dialogSource,
    /type DialogLayout = "center" \| "fullscreen-mobile" \| "bottom-sheet-mobile"/,
  );
  assert.match(dialogSource, /DialogHeader/);
  assert.match(dialogSource, /DialogBody/);
  assert.match(dialogSource, /DialogFooter/);
  assert.match(dialogSource, /DialogActions/);
  assert.match(dialogSource, /data-\[starting-style\]:opacity-0/);
  assert.match(dialogSource, /data-\[ending-style\]:opacity-0/);
  assert.doesNotMatch(
    dialogSource,
    /overlayClassName|viewportClassName|portalProps|z-\[\d+\]/,
  );
  assert.doesNotMatch(
    dialogSource,
    /export (?:function|const) Dialog(?:Portal|Overlay)/,
  );
  assert.doesNotMatch(retainedCssSource, retiredDialogCss);
});

test("shared AlertDialog owns its viewport and composition", () => {
  assert.match(alertDialogSource, /data-slot="alert-dialog-viewport"/);
  assert.match(alertDialogSource, /pt-safe-top/);
  assert.match(alertDialogSource, /pb-safe-bottom/);
  assert.match(alertDialogSource, /AlertDialogHeader/);
  assert.match(alertDialogSource, /AlertDialogBody/);
  assert.match(alertDialogSource, /AlertDialogFooter/);
  assert.match(alertDialogSource, /AlertDialogActions/);
  assert.doesNotMatch(
    alertDialogSource,
    /export (?:function|const) AlertDialog(?:Portal|Overlay)/,
  );
});
