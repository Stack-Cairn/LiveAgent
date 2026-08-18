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
const alertDialogSource = await readFile(
  new URL(
    "../../../agent-ui/src/components/ui/alert-dialog.tsx",
    import.meta.url,
  ),
  "utf8",
);
const gatewayDialogCss = ["base-chat.css", "responsive.css"].map((file) =>
  readFile(
    new URL(`../../../agent-gateway/web/src/styles/${file}`, import.meta.url),
    "utf8",
  ),
);
const gatewayDialogCssSource = (await Promise.all(gatewayDialogCss)).join("\n");

const retiredDialogCss =
  /settings-modal-(?:overlay|panel|header|subheader|body|footer|actions|step-row)|(?:external-link|history-share)-modal-(?:overlay|panel)|modal-dialog-(?:backdrop|popup|viewport)|ssh-forward-dialog/;

test("shared Dialog owns modal visibility and motion", () => {
  assert.match(dialogSource, /data-slot="dialog-overlay"/);
  assert.match(dialogSource, /data-slot="dialog-viewport"/);
  assert.match(dialogSource, /data-slot="dialog-content"/);
  assert.match(dialogSource, /safe-area-inset-top/);
  assert.match(dialogSource, /safe-area-inset-bottom/);
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
  assert.doesNotMatch(commonSettingsCss, retiredDialogCss);
  assert.doesNotMatch(gatewayDialogCssSource, retiredDialogCss);
});

test("shared AlertDialog owns its viewport and composition", () => {
  assert.match(alertDialogSource, /data-slot="alert-dialog-viewport"/);
  assert.match(alertDialogSource, /safe-area-inset-top/);
  assert.match(alertDialogSource, /safe-area-inset-bottom/);
  assert.match(alertDialogSource, /AlertDialogHeader/);
  assert.match(alertDialogSource, /AlertDialogBody/);
  assert.match(alertDialogSource, /AlertDialogFooter/);
  assert.match(alertDialogSource, /AlertDialogActions/);
  assert.doesNotMatch(
    alertDialogSource,
    /export (?:function|const) AlertDialog(?:Portal|Overlay)/,
  );
});
