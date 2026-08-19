import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function readShared(path) {
  return readFileSync(new URL(`../../../agent-ui/src/${path}`, import.meta.url), "utf8");
}

const providersSectionSource = readShared("pages/settings/ProvidersSection.tsx");
const modelPickerSource = readShared("pages/settings/modelPicker.tsx");
const baseStylesSource = readShared("styles/base.css");

const popupPortalSources = [
  ["Select", readShared("components/ui/select.tsx")],
  ["DropdownMenu", readShared("components/ui/dropdown-menu.tsx")],
  ["Popover", readShared("components/ui/popover.tsx")],
  ["Tooltip", readShared("components/ui/tooltip.tsx")],
];

const modalPortalSources = [
  ["Dialog", readShared("components/ui/dialog.tsx")],
  ["Sheet", readShared("components/ui/sheet.tsx")],
  ["AlertDialog", readShared("components/ui/alert-dialog.tsx")],
];

function layerValue(name) {
  const match = baseStylesSource.match(new RegExp(`${name}:\\s*(\\d+);`));
  assert.ok(match, `${name} should be declared`);
  return Number(match[1]);
}

function collectSourceFiles(directoryUrl) {
  const files = [];
  const pending = [fileURLToPath(directoryUrl)];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
    }
  }
  return files;
}

test("the provider failover queue uses the shared model picker", () => {
  assert.match(providersSectionSource, /<ModelPicker[\s\S]*options=\{addableProviderOptions\}/);
  assert.match(providersSectionSource, /ariaLabel=\{t\("settings\.failoverQueueAdd"\)\}/);
  assert.match(providersSectionSource, /placeholder=\{t\("settings\.failoverQueueAdd"\)\}/);
  assert.match(providersSectionSource, /collapsibleGroups=\{false\}/);
});

test("the shared model picker can render options without a collapsible group", () => {
  assert.match(modelPickerSource, /collapsibleGroups = true/);
  assert.match(modelPickerSource, /\{collapsibleGroups \? \(/);
  assert.match(modelPickerSource, /!collapsibleGroups \|\| expanded/);
  assert.match(modelPickerSource, /searchPlaceholder\?: string/);
  assert.match(modelPickerSource, /emptyLabel\?: string/);
  assert.match(modelPickerSource, /option\.description/);
  assert.match(providersSectionSource, /description: provider\.baseUrl/);
});

test("all shared popup primitives use the semantic popover layer", () => {
  for (const [name, source] of popupPortalSources) {
    assert.match(source, /<\w+(?:Primitive)?\.Portal>/, `${name} should render through a Portal`);
    assert.match(source, /className="layer-popover(?: isolate)?"/, `${name} should use layer-popover`);
  }
});

test("all shared modal primitives use the semantic modal layer", () => {
  for (const [name, source] of modalPortalSources) {
    assert.match(source, /Portal/, `${name} should render through a Portal`);
    assert.match(source, /layer-modal fixed/, `${name} should use layer-modal`);
  }
});

test("modal and nested popup portals share a DOM-ordered interaction plane", () => {
  const popoverLayer = layerValue("--layer-popover");
  const modalLayer = layerValue("--layer-modal");
  const toastLayer = layerValue("--layer-toast");
  const criticalLayer = layerValue("--layer-critical");

  assert.equal(popoverLayer, modalLayer);
  assert.ok(toastLayer > modalLayer);
  assert.ok(criticalLayer > toastLayer);
});

test("custom React portals opt into a semantic overlay layer", () => {
  const sourceRoots = [
    new URL("../../../agent-ui/src/", import.meta.url),
    new URL("../../src/", import.meta.url),
    new URL("../../../agent-gateway/web/src/", import.meta.url),
  ];
  const portalFiles = sourceRoots
    .flatMap(collectSourceFiles)
    .map((path) => [path, readFileSync(path, "utf8")])
    .filter(([, source]) => source.includes("createPortal("));

  assert.ok(portalFiles.length > 0);
  for (const [path, source] of portalFiles) {
    const portalCalls = source.split("createPortal(").slice(1);
    for (const [index, portalCall] of portalCalls.entries()) {
      assert.match(
        portalCall,
        /layer-(?:popover|modal|toast|critical)/,
        `${path} createPortal call ${index + 1} should use a semantic overlay layer`,
      );
    }
  }
});
