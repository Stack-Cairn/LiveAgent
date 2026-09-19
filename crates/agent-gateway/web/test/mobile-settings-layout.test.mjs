import { readStyleSource } from "../../../agent-ui/test-support/style-values.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeClassGroups } from "../../../agent-ui/test-support/source-class-groups.mjs";

const hooksSource = normalizeClassGroups(readFileSync(
  new URL("../../../agent-ui/src/pages/settings/HooksSection.tsx", import.meta.url),
  "utf8",
));
const devicesSource = normalizeClassGroups(readFileSync(
  new URL("../src/pages/settings/DevicesSection.tsx", import.meta.url),
  "utf8",
));
const cronSource = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/CronTaskViewModal.tsx", import.meta.url),
  "utf8",
);
const providersSource = normalizeClassGroups(readFileSync(
  new URL("../../../agent-ui/src/pages/settings/ProvidersSection.tsx", import.meta.url),
  "utf8",
));
const settingsShellSource = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/SettingsShell.tsx", import.meta.url),
  "utf8",
);
const themeSource = readStyleSource(new URL("../../../agent-ui/src/styles/tokens.css", import.meta.url));

// Hooks 页重写为单一布局：标题旁常驻一个「添加」按钮（无论有无 hook），空态卡片
// 只作说明不再重复放按钮；不再靠 web:max-* 断点翻转头部方向，而是用包裹布局。
test("hook events render exactly one add action beside the event title", () => {
  const addButtons = hooksSource.match(/onClick=\{openAdd\}/g) ?? [];
  assert.equal(addButtons.length, 1, "one add action in the section header");
  assert.match(hooksSource, /<Button size="sm" onClick=\{openAdd\}>[\s\S]*?settings\.hooksAdd/);
  assert.match(hooksSource, /activeHooks\.length === 0 \? \([\s\S]*?settings\.hooksEmptyTitle/);
  assert.doesNotMatch(
    hooksSource,
    /activeHooks\.length === 0 \? \([\s\S]*?settings\.hooksAdd[\s\S]*?\) : \(/,
    "empty state must not duplicate the add action",
  );
});

test("mobile hook headers wrap instead of relying on breakpoint overrides", () => {
  assert.match(hooksSource, /flex flex-wrap items-center justify-between gap-3/);
  assert.match(hooksSource, /grid items-start gap-6 md:grid-cols-\[13rem_minmax\(0,1fr\)\]/);
  assert.doesNotMatch(hooksSource, /web:max-820:|web:max-380:/);
});

test("mobile device rows move text actions below the client details", () => {
  assert.match(devicesSource, /settings-devices-card-row/);
  assert.match(devicesSource, /min-w-0 flex-1 max-820:min-w-0/);
  assert.match(devicesSource, /flex shrink-0[^"\n]*max-820:col-span-full max-820:w-full/);
  assert.match(
    devicesSource,
    /max-820:grid max-820:grid-cols-settings-devices-card-row/,
  );
  assert.match(themeSource, /--grid-template-columns-settings-devices-card-row:\s*36px minmax\(0, 1fr\);/);
  assert.match(devicesSource, /max-820:\[&_>_button\]:min-w-0/);
});

test("mobile cron details give configuration more room and compact log summaries", () => {
  assert.match(cronSource, /max-\[820px\]:max-h-\[55%\]/);
  assert.doesNotMatch(cronSource, /max-\[820px\]:max-h-\[42%\]/);
  assert.match(
    settingsShellSource,
    /settings-log-row\]:grid[^"\n]*settings-log-row\]:grid-cols-\[auto_minmax\(0,1fr\)_auto_auto_auto\]/,
  );
  assert.match(
    settingsShellSource,
    /settings-log-row>span:first-of-type\]:truncate/,
  );
});

// 工具栏改为包裹布局：窄屏下 tabs 与动作组自然换行，动作组在 640px 以下撑满
// 一行并平分；自定义设置从 Sheet 改为 fullscreen-mobile 的 Dialog。
test("mobile provider toolbar stacks tabs above a full-width action group", () => {
  assert.match(providersSource, /flex min-h-0 flex-1 flex-col gap-4/);
  assert.match(providersSource, /flex shrink-0 flex-wrap items-center justify-between gap-3/);
  assert.match(providersSource, /max-w-full overflow-x-auto pb-1/);
  assert.match(
    providersSource,
    /inline-flex min-w-0 shrink-0 flex-wrap items-center gap-2[\s\S]{0,200}?max-640:w-full max-640:\[&>\.settings-provider-action\]:flex-1/,
  );
  assert.match(
    providersSource,
    /max-\[860px\]:hidden max-640:inline/,
  );
  assert.match(
    providersSource,
    /web:max-820:w-settings-provider-empty-add-w[^"\n]*web:max-520:w-full/,
  );
  assert.match(
    providersSource,
    /<DialogContent[\s\S]*?layout="fullscreen-mobile"/,
  );
});
