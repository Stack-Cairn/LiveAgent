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

test("empty hook events render only the content-area add action", () => {
  assert.match(hooksSource, /activeHooks\.length > 0 \? \([\s\S]*?<Button[\s\S]*?onClick=\{openAdd\}/);
  assert.match(hooksSource, /activeHooks\.length === 0 \? \([\s\S]*settings\.hooksAdd/);
});

test("mobile hook headers keep an existing hook action beside its title", () => {
  assert.match(hooksSource, /web:max-820:flex-row! web:max-820:items-start! web:max-820:gap-10px!/);
  assert.match(hooksSource, /web:max-380:flex-col! web:max-380:items-stretch!/);
  assert.match(hooksSource, /settings-section-action[^"\n]*web:max-820:flex-none/);
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

test("mobile provider toolbar stacks tabs above a full-width action group", () => {
  assert.match(providersSource, /flex min-h-0 flex-1 flex-col web:max-820:min-w-0/);
  assert.match(
    providersSource,
    /web:max-820:flex web:max-820:w-full web:max-820:flex-col web:max-820:items-stretch/,
  );
  assert.match(
    providersSource,
    /inline-flex h-36px[^"\n]*max-640:w-full max-640:flex-none/,
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
    /<SheetContent[\s\S]*?web:max-820:inset-0/,
  );
});
