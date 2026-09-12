import { readStyleSource } from "../../../agent-ui/test-support/style-values.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const toastSource = readFileSync(
  new URL("../../../agent-ui/src/components/ui/toaster.tsx", import.meta.url),
  "utf8",
);
const managerSource = readFileSync(new URL("../../../agent-ui/src/components/ui/toast-manager.ts", import.meta.url), "utf8");
const sidebarSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ChatHistorySidebar.tsx", import.meta.url),
  "utf8",
);
const animationStyles = readStyleSource(new URL("../../../agent-ui/src/styles/animations.css", import.meta.url));

test("folder import notifications adapt to locale, theme, and narrow screens", () => {
  assert.match(toastSource, /useLocale\(\)/);
  assert.match(toastSource, /t\("common\.dismissNotification"\)/);
  assert.match(toastSource, /dark:bg-(?:amber|emerald|red)-950/);
  assert.match(toastSource, /w-notification/);
  assert.match(toastSource, /whitespace-pre-wrap break-words/);
});

test("folder import notifications expose accessible status and motion behavior", () => {
  assert.match(managerSource, /priority: type === "error" \? "high" : "low"/);
  assert.match(toastSource, /<ToastDescription/);
  assert.match(toastSource, /aria-label=\{t\("common\.dismissNotification"\)\}/);
  assert.match(managerSource, /timeout: options.duration \?\? 5000/);
  assert.match(toastSource, /useReducedMotion\(\)/);
  assert.match(toastSource, /data-\[ending-style\]:opacity-0/);
  assert.doesNotMatch(animationStyles, /@keyframes notifyFadeOut/);
});

test("workspace drop label truncates safely in narrow translated layouts", () => {
  assert.match(
    sidebarSource,
    /<span className="truncate">\s*\{showWorkspaceFolderDrop[\s\S]*?chat\.workspaceDropFolder/,
  );
  assert.match(sidebarSource, /showWorkspaceFolderDrop = workspaceFolderDropActive && !reorder\.draggingKey/);
});
