import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const toastSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/NotifyToast.tsx", import.meta.url),
  "utf8",
);
const sidebarSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ChatHistorySidebar.tsx", import.meta.url),
  "utf8",
);
const commonStyles = readFileSync(
  new URL("../../../agent-ui/src/styles/common-components.css", import.meta.url),
  "utf8",
);

test("folder import notifications adapt to locale, theme, and narrow screens", () => {
  assert.match(toastSource, /useLocale\(\)/);
  assert.match(toastSource, /t\("common\.dismissNotification"\)/);
  assert.match(toastSource, /dark:bg-(?:amber|emerald|red)-950/);
  assert.match(toastSource, /w-\[min\(18rem,calc\(100vw-2rem\)\)\]/);
  assert.match(toastSource, /whitespace-pre-wrap break-words/);
});

test("folder import notifications expose accessible status and motion behavior", () => {
  assert.match(toastSource, /role=\{item\.type === "error" \? "alert" : "status"\}/);
  assert.match(toastSource, /aria-live=\{item\.type === "error" \? "assertive" : "polite"\}/);
  assert.match(toastSource, /aria-label=\{t\("common\.dismissNotification"\)\}/);
  assert.match(commonStyles, /\.notify-toast-enter,\s*\n\s*\.notify-toast-exit/);
});

test("workspace drop label truncates safely in narrow translated layouts", () => {
  assert.match(
    sidebarSource,
    /<span className="truncate">\s*\{workspaceFolderDropActive[\s\S]*?chat\.workspaceDropFolder/,
  );
});
