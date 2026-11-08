// The automatic memory organizer schedule lives in K-brain (`/v1/settings`
// memoryOrganizer). The settings row shows only when the backend reports it and
// saves only the field that changed.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const toasts = [];
const icon = (name) => (props) => env.React.createElement("svg", { ...props, "data-icon": name });
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": {
      Check: icon("check"),
      ChevronDown: icon("chevron-down"),
      ChevronUp: icon("chevron-up"),
    },
    "@liveagent/ui/components/ui/toast-manager": {
      toast: { error: (message) => toasts.push(message), success() {} },
    },
  },
});
const {
  loadMemoryOrganizer,
  MemoryOrganizerSchedule,
  memoryOrganizerFromSettings,
  memoryOrganizerIntervalLabel,
} = env.loadModule("@liveagent/ui/pages/settings/memory/MemoryOrganizerSchedule.tsx");

function adapter({ capability = 1, schedule = { enabled: true, intervalHours: 24 }, fail } = {}) {
  // capability null: a backend without the setting.
  const state = { schedule, puts: [] };
  return {
    state,
    kbrain: {
      isKbrain: true,
      getCapabilities: async () => (capability === null ? {} : { memory_organizer_settings: capability }),
      getSettings: async () => ({ memoryOrganizer: state.schedule }),
      updateSettings: async (update) => {
        state.puts.push(update);
        if (fail) throw new Error(fail);
        state.schedule = { ...state.schedule, ...update.memoryOrganizer };
        return { memoryOrganizer: state.schedule };
      },
    },
  };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await env.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function render(kbrain) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  await env.act(async () => root.render(env.React.createElement(MemoryOrganizerSchedule, { kbrain })));
  await settle();
  return { host, root };
}

test("the schedule is read only from backends that report it", async () => {
  assert.equal(await loadMemoryOrganizer(adapter({ capability: null }).kbrain), null);
  assert.deepEqual(await loadMemoryOrganizer(adapter().kbrain), { enabled: true, intervalHours: 24 });
  // Adapters without capabilities (the WebUI) rely on the document carrying it.
  const { kbrain } = adapter();
  delete kbrain.getCapabilities;
  assert.deepEqual(await loadMemoryOrganizer(kbrain), { enabled: true, intervalHours: 24 });
  assert.equal(memoryOrganizerFromSettings({}), null);
  assert.equal(memoryOrganizerFromSettings({ memoryOrganizer: { enabled: "yes", intervalHours: 1 } }), null);
  assert.equal(memoryOrganizerFromSettings({ memoryOrganizer: { enabled: true, intervalHours: Number.NaN } }), null);
});

test("older backends show no schedule row", async () => {
  const { host, root } = await render(adapter({ capability: null }).kbrain);
  assert.equal(host.querySelector('[data-testid="memory-organizer-schedule"]'), null);
  await env.act(async () => root.unmount());
});

test("turning the organizer off saves only `enabled` and hides the frequency", async () => {
  const { kbrain, state } = adapter({ schedule: { enabled: true, intervalHours: 6 } });
  const { host, root } = await render(kbrain);
  const section = host.querySelector('[data-testid="memory-organizer-schedule"]');
  assert.ok(section, "schedule row is shown");
  assert.match(section.textContent, /每 6 小时/);
  const toggle = section.querySelector('[role="switch"]');
  assert.equal(toggle.getAttribute("aria-checked"), "true");

  await env.act(async () => toggle.click());
  await settle();
  assert.deepEqual(state.puts, [{ memoryOrganizer: { enabled: false } }]);
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.doesNotMatch(section.textContent, /每 6 小时/);
  await env.act(async () => root.unmount());
});

test("a failed save goes back to what the backend holds and says so", async () => {
  toasts.length = 0;
  const { kbrain } = adapter({ fail: "memoryOrganizer.intervalHours must be between 1 and 168" });
  const { host, root } = await render(kbrain);
  const toggle = host.querySelector('[role="switch"]');
  await env.act(async () => toggle.click());
  await settle();
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.equal(toasts.length, 1);
  await env.act(async () => root.unmount());
});

test("intervals read as words, and a value saved elsewhere still reads", () => {
  const t = (key) =>
    ({
      "settings.memoryOrganizerEveryDay": "Daily",
      "settings.memoryOrganizerEveryHours": "Every {count} hours",
    })[key] ?? key;
  assert.equal(memoryOrganizerIntervalLabel(t, 24), "Daily");
  assert.equal(memoryOrganizerIntervalLabel(t, 1.5), "Every 1.5 hours");
});
