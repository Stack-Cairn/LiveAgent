import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const pageSource = readFileSync(
  new URL("../../../agent-ui/src/pages/mcp-hub/McpHubPage.tsx", import.meta.url),
  "utf8",
);
const toolbarSource = readFileSync(
  new URL("../../../agent-ui/src/pages/mcp-hub/McpRegistryToolbar.tsx", import.meta.url),
  "utf8",
);
const importPickerSource = readFileSync(
  new URL("../../../agent-ui/src/pages/mcp-hub/McpImportSourcePicker.tsx", import.meta.url),
  "utf8",
);
const importViewSource = readFileSync(
  new URL("../../../agent-ui/src/pages/mcp-hub/McpImportView.tsx", import.meta.url),
  "utf8",
);
const serversFormSource = readFileSync(
  new URL("../../../agent-ui/src/pages/mcp-hub/McpServersForm.tsx", import.meta.url),
  "utf8",
);
const serverCardSource = readFileSync(
  new URL("../../../agent-ui/src/pages/mcp-hub/McpServerCard.tsx", import.meta.url),
  "utf8",
);
const registryBrowserSource = readFileSync(
  new URL("../../../agent-ui/src/pages/mcp-hub/McpRegistryBrowser.tsx", import.meta.url),
  "utf8",
);
const externalToolIconSource = readFileSync(
  new URL(
    "../../../agent-ui/src/components/resources/ExternalToolSourceIcon.tsx",
    import.meta.url,
  ),
  "utf8",
);
const resourceTabsSource = readFileSync(
  new URL("../../../agent-ui/src/components/resources/ResourceTabsList.tsx", import.meta.url),
  "utf8",
);
const guiTranslations = createTsModuleLoader().loadModule("src/i18n/config.ts").translations;
const webRoot = fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url));
const webTranslations = createTsModuleLoader({ rootDir: webRoot }).loadModule(
  "src/i18n/config.ts",
).translations;

test("MCP navigation uses the same standard segmented and quiet Tabs as Skills Hub", () => {
  for (const source of [toolbarSource, importPickerSource]) {
    assert.match(source, /components\/ui\/tabs/);
    assert.match(source, /<Tabs/);
    assert.match(source, /<TabsList/);
    assert.match(source, /<TabsTrigger/);
    assert.doesNotMatch(source, /ToggleGroup/);
  }
  assert.match(pageSource, /<ResourceTabsList/);
  assert.match(resourceTabsSource, /components\/ui\/tabs/);
  assert.match(resourceTabsSource, /<TabsList[\s\S]*<TabsTrigger/);
  assert.match(resourceTabsSource, /h-9[^"\n]*rounded-lg bg-muted p-1/);
  assert.match(resourceTabsSource, /data-\[active\]:bg-background/);
  assert.match(toolbarSource, /border border-transparent/);
  assert.match(importPickerSource, /border border-transparent/);
});

test("MCP header and primary navigation share the Skills Hub hierarchy", () => {
  assert.match(pageSource, /<HubHeader/);
  assert.match(pageSource, /prominent/);
  assert.match(pageSource, /actions=\{/);
  assert.match(pageSource, /icon:\s*(Server|Cloud|Download)/);
  assert.match(pageSource, /<Badge/);
  assert.doesNotMatch(pageSource, /Status banner/);
  assert.doesNotMatch(pageSource, /statusReady/);
});

test("MCP search stays above the primary tabs and is shared by every view", () => {
  const searchPosition = pageSource.indexOf('type="search"');
  const tabsPosition = pageSource.indexOf("<ResourceTabsList");
  assert.ok(searchPosition >= 0);
  assert.ok(tabsPosition > searchPosition);
  assert.match(pageSource, /const \[searchQueries, setSearchQueries\]/);
  assert.match(pageSource, /query=\{searchQueries\.installed\}/);
  assert.match(pageSource, /query=\{searchQueries\.store\}/);
  assert.match(pageSource, /query=\{searchQueries\.import\}/);
  assert.doesNotMatch(serversFormSource, /type="search"/);
  assert.doesNotMatch(toolbarSource, /type="search"/);
  assert.match(registryBrowserSource, /window\.setTimeout\([\s\S]*runSearch\("replace", query\)/);
  assert.match(importViewSource, /rankFuzzySearchResults/);
});

test("MCP import tabs keep source icons and compact count badges", () => {
  assert.match(importPickerSource, /ExternalToolSourceIcon/);
  assert.match(externalToolIconSource, /"claude-code": ClaudeIcon/);
  assert.match(externalToolIconSource, /codex: OpenaiChatgptIcon/);
  assert.match(externalToolIconSource, /codebuddy: Bot/);
  assert.match(importPickerSource, /<Badge/);
  assert.match(importPickerSource, /min-w-4/);
});

test("installed MCP resources use a compact settings list while Store keeps its card grid", () => {
  assert.match(serversFormSource, /divide-y[^"\n]*overflow-hidden[^"\n]*rounded-xl[^"\n]*border/);
  assert.match(serverCardSource, /min-h-16[^"\n]*items-center/);
  assert.match(serverCardSource, /ResourceActivationSwitch/);
  assert.match(serverCardSource, /ToolPolicyToggle/);
  assert.match(serverCardSource, /const argsCount = \(server\.args \?\? \[\]\)\.filter\(Boolean\)\.length/);
  assert.match(serverCardSource, /const envCount = server\.env \? Object\.keys\(server\.env\)\.length : 0/);
  assert.match(
    serverCardSource,
    /const headerCount = server\.headers \? Object\.keys\(server\.headers\)\.length : 0/,
  );
  assert.match(serverCardSource, /label=\{t\("mcpHub\.previewArgs"\)\}/);
  assert.match(serverCardSource, /label=\{t\("mcpHub\.previewEnv"\)\}/);
  assert.match(serverCardSource, /label=\{t\("mcpHub\.previewHeaders"\)\}/);
  assert.match(serverCardSource, /grid-cols-\[auto_2rem_2rem\]/);
  assert.match(serverCardSource, /aria-hidden="true"/);
  assert.ok(
    serverCardSource.indexOf("<ResourceActivationSwitch") <
      serverCardSource.indexOf("onClick={onEdit}"),
  );
  assert.ok(
    serverCardSource.lastIndexOf("<ConfirmDeletePopover") >
      serverCardSource.indexOf("<Settings"),
  );
  assert.match(
    serverCardSource,
    /className="h-8 w-8 text-muted-foreground transition-colors hover:bg-destructive\/10 hover:text-destructive"/,
  );
  assert.doesNotMatch(serverCardSource, /border-emerald/);
  assert.doesNotMatch(serverCardSource, /hover:-translate-y/);
  assert.match(registryBrowserSource, /sm:grid-cols-2 lg:grid-cols-3/);
  assert.doesNotMatch(registryBrowserSource, /xl:grid-cols-4/);
  assert.doesNotMatch(registryBrowserSource, /hover:-translate-y/);
});

test("MCP Store automatically appends pages in multiples of four at the scroll boundary", () => {
  const pageLimit = Number(
    registryBrowserSource.match(/MCP_STORE_PAGE_LIMIT = (\d+)/)?.[1],
  );
  assert.ok(pageLimit > 0);
  assert.equal(pageLimit % 4, 0);
  assert.match(registryBrowserSource, /STORE_SKELETON_IDS = Array\.from\(\{ length: 8 \}/);
  assert.match(registryBrowserSource, /new IntersectionObserver/);
  assert.match(registryBrowserSource, /root: scrollRootRef\.current|root,/);
  assert.match(registryBrowserSource, /rootMargin: "0px 0px 320px 0px"/);
  assert.match(registryBrowserSource, /loadMoreRequestRef\.current/);
  assert.match(registryBrowserSource, /ref=\{loadMoreSentinelRef\}/);
  assert.doesNotMatch(registryBrowserSource, /mcpHub\.storeLoadMore/);
});

test("MCP Store cards center connection previews and use working external and add actions", () => {
  assert.match(registryBrowserSource, /shims\/tauriOpener/);
  assert.match(registryBrowserSource, /void openUrl\(link\)/);
  assert.match(registryBrowserSource, /flex min-h-\[40px\] items-center/);
  assert.match(registryBrowserSource, /<Plus className="h-3\.5 w-3\.5"/);
  assert.doesNotMatch(registryBrowserSource, /<Sparkles/);
});

test("MCP Hub description follows the active Chinese locale", () => {
  assert.match(pageSource, /subtitle=\{t\("mcpHub\.subtitle"\)\}/);
  for (const translations of [guiTranslations, webTranslations]) {
    assert.equal(translations["zh-CN"]["mcpHub.subtitle"], "管理模型上下文协议（MCP）服务器");
    assert.equal(translations["zh-CN"]["mcpHub.storeSearchPlaceholder"], "搜索 MCP 服务器");
  }
});

test("MCP local import rescan reports progress and completion without replacing existing content", () => {
  assert.match(importViewSource, /const \[rescanComplete, setRescanComplete\]/);
  assert.match(importViewSource, /aria-busy=\{loading\}/);
  assert.match(importViewSource, /loading \? \(\s*<Loader2[^>]*animate-spin/);
  assert.match(importViewSource, /rescanComplete[\s\S]*settings\.skillsScanComplete/);
  assert.match(importViewSource, /aria-live="polite"/);
  assert.doesNotMatch(importViewSource, /onClick=\{\(\) => void rescan\(\)\}/);
});
