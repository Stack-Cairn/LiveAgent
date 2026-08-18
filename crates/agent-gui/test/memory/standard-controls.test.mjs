import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const memoryPanel = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/memory/MemoryPanel.tsx", import.meta.url),
  "utf8",
);
const memorySettingsDrawer = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/memory/MemorySettingsDrawer.tsx", import.meta.url),
  "utf8",
);
const organizerHistoryModal = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/memory/OrganizerHistoryModal.tsx", import.meta.url),
  "utf8",
);

test("memory settings use shared form and navigation primitives", () => {
  assert.match(memoryPanel, /<Select\b/);
  assert.match(memoryPanel, /<SelectTrigger/);
  assert.match(memoryPanel, /<SelectItem/);
  assert.match(memoryPanel, /<Tabs\b/);
  assert.match(memoryPanel, /<TabsList/);
  assert.match(memoryPanel, /<TabsTrigger/);
  assert.match(memoryPanel, /<Textarea/);
  assert.doesNotMatch(memoryPanel, /<(?:button|select|option|textarea)\b/);

  assert.match(memorySettingsDrawer, /<SheetClose/);
  assert.match(memorySettingsDrawer, /<Input\b/);
  assert.doesNotMatch(memorySettingsDrawer, /<(?:button|input)\b/);

  assert.match(organizerHistoryModal, /<Button\b/);
  assert.match(organizerHistoryModal, /<Checkbox\b/);
  assert.doesNotMatch(organizerHistoryModal, /<(?:button|input)\b/);
});
