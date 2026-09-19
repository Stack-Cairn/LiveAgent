import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hooksSource = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/HooksSection.tsx", import.meta.url),
  "utf8",
);
const devicesSource = readFileSync(
  new URL("../src/pages/settings/DevicesSection.tsx", import.meta.url),
  "utf8",
);
const cronSource = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/CronTaskViewModal.tsx", import.meta.url),
  "utf8",
);
const providersSource = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/ProvidersSection.tsx", import.meta.url),
  "utf8",
);
const providerDetailSource = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/providers/ProviderDetail.tsx", import.meta.url),
  "utf8",
);
const customSettingsDrawerSource = readFileSync(
  new URL(
    "../../../agent-ui/src/pages/settings/providers/ProviderCustomSettingsDrawer.tsx",
    import.meta.url,
  ),
  "utf8",
);
const responsiveStylesSource = readFileSync(
  new URL("../src/styles/responsive.css", import.meta.url),
  "utf8",
);

test("empty hook events render only the content-area add action", () => {
  assert.match(hooksSource, /activeHooks\.length > 0 \? \([\s\S]*settings-hooks-detail-add/);
  assert.match(hooksSource, /activeHooks\.length === 0 \? \([\s\S]*settings\.hooksAdd/);
});

test("mobile hook headers keep an existing hook action beside its title", () => {
  assert.match(hooksSource, /settings-hooks-detail-heading/);
  assert.match(responsiveStylesSource, /\.settings-hooks-detail-heading\s*\{[\s\S]*flex-direction:\s*row;/);
  assert.match(responsiveStylesSource, /\.settings-hooks-detail-add\s*\{[\s\S]*flex:\s*0 0 auto;/);
});

test("mobile device rows move text actions below the client details", () => {
  assert.match(devicesSource, /settings-devices-card-row/);
  assert.match(devicesSource, /settings-devices-card-main min-w-0 flex-1/);
  assert.match(devicesSource, /settings-devices-card-actions flex shrink-0/);
  assert.match(
    responsiveStylesSource,
    /\.settings-devices-card-row\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*36px minmax\(0, 1fr\);/,
  );
  assert.match(
    responsiveStylesSource,
    /\.settings-devices-card-actions\s*\{[\s\S]*grid-column:\s*1 \/ -1;[\s\S]*width:\s*100%;/,
  );
});

test("mobile cron details give configuration more room and compact log summaries", () => {
  assert.match(cronSource, /max-\[820px\]:max-h-\[55%\]/);
  assert.doesNotMatch(cronSource, /max-\[820px\]:max-h-\[42%\]/);
  assert.match(
    responsiveStylesSource,
    /\.settings-log-row\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto auto;/,
  );
  assert.match(
    responsiveStylesSource,
    /\.settings-log-row\s*> span:first-of-type\s*\{[\s\S]*text-overflow:\s*ellipsis;/,
  );
});

test("mobile provider page collapses the two columns into list → detail and keeps the custom sheet full-screen", () => {
  // 三栏结构：窄屏两栏塌成一栏，列表与详情二选一显示，详情顶部有返回按钮。
  assert.match(providersSource, /settings-provider-section flex min-h-0 flex-1 flex-col/);
  assert.match(
    providersSource,
    /settings-provider-columns grid min-h-0 flex-1 grid-cols-\[264px_minmax\(0,1fr\)\] gap-5 max-\[720px\]:grid-cols-1/,
  );
  assert.match(providersSource, /settings-provider-column-list[^"]*max-\[720px\]:border-r-0/);
  assert.match(providersSource, /mobileDetailOpen && "max-\[720px\]:hidden"/);
  assert.match(providersSource, /!mobileDetailOpen && "max-\[720px\]:hidden"/);
  assert.match(
    providerDetailSource,
    /settings-provider-back hidden h-8 w-8 max-\[720px\]:inline-flex/,
  );
  // 网关壳：页面容器允许收缩，自定义设置抽屉在手机上全屏。
  assert.match(
    responsiveStylesSource,
    /\.settings-provider-section\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?min-height:\s*0;/,
  );
  assert.match(
    responsiveStylesSource,
    /\.settings-provider-custom-sheet\s*\{[\s\S]*inset:\s*0;/,
  );
  assert.match(customSettingsDrawerSource, /settings-provider-custom-sheet /);
});
