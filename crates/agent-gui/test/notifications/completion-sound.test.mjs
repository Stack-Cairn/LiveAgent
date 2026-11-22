import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const sound = loader.loadModule("src/lib/notifications/completionSound.ts");
const { playsCompletionSound } = loader.loadModule("src/lib/notifications/runAttention.ts");
const settings = loader.loadModule("@liveagent/ui/lib/settings/index.ts");

function fakeAudioContext({ state = "running" } = {}) {
  const log = { oscillators: [], gains: [], resumed: 0 };
  const param = () => {
    const calls = [];
    return {
      calls,
      setValueAtTime: (value, time) => calls.push(["set", value, time]),
      exponentialRampToValueAtTime: (value, time) => calls.push(["ramp", value, time]),
    };
  };
  const context = {
    currentTime: 10,
    destination: { id: "out" },
    state,
    resume: async () => {
      log.resumed += 1;
      context.state = "running";
    },
    createOscillator: () => {
      const oscillator = {
        frequency: param(),
        connect: (node) => (oscillator.to = node),
        start: (time) => (oscillator.startAt = time),
        stop: (time) => (oscillator.stopAt = time),
      };
      log.oscillators.push(oscillator);
      return oscillator;
    },
    createGain: () => {
      const gain = { gain: param(), connect: (node) => (gain.to = node) };
      log.gains.push(gain);
      return gain;
    },
  };
  return { context, log };
}

test("the chime only follows a finished run the user is not watching", () => {
  const done = { kind: "completed", conversationId: "a" };
  const background = { visibleConversationId: "a", windowFocused: false };
  const focused = { visibleConversationId: "b", windowFocused: true };
  assert.equal(playsCompletionSound(done, background), true, "the window is in the background");
  assert.equal(playsCompletionSound(done, focused), false, "the sidebar already shows it");
  assert.equal(playsCompletionSound({ kind: "approval", conversationId: "a" }, background), false);
  assert.equal(playsCompletionSound({ kind: "question", conversationId: "a" }, background), false);
});

test("the chime is generated: two click-free sine notes into the output", () => {
  const { context, log } = fakeAudioContext();
  const end = sound.scheduleChime(context);
  assert.equal(log.oscillators.length, sound.COMPLETION_CHIME.length);
  sound.COMPLETION_CHIME.forEach((note, index) => {
    const oscillator = log.oscillators[index];
    const gain = log.gains[index];
    assert.equal(oscillator.type, "sine");
    assert.equal(oscillator.frequency.calls[0][1], note.frequency);
    assert.equal(oscillator.to, gain);
    assert.equal(gain.to, context.destination);
    const [silent, attack, release] = gain.gain.calls;
    assert.deepEqual(silent.slice(0, 2), ["set", 0.0001], "starts silent");
    assert.equal(attack[1], note.gain);
    assert.ok(attack[2] - silent[2] <= 0.011, "fast attack");
    assert.deepEqual(release.slice(0, 2), ["ramp", 0.0001], "decays to silence");
    assert.ok(oscillator.stopAt > release[2], "stops after the decay");
  });
  assert.ok(end > context.currentTime && end - context.currentTime < 1, "under a second");
  assert.ok(log.oscillators[1].startAt > log.oscillators[0].startAt, "second note follows");
});

test("the player throttles bursts, resumes a suspended context and survives no audio", () => {
  let time = 0;
  const { context, log } = fakeAudioContext({ state: "suspended" });
  let created = 0;
  const player = sound.createCompletionSoundPlayer({
    createContext: () => {
      created += 1;
      return context;
    },
    now: () => time,
  });
  player.unlock();
  assert.equal(created, 1, "a gesture creates the context");
  assert.equal(log.resumed, 1, "and resumes it");
  assert.equal(player.play(), true);
  time = sound.COMPLETION_SOUND_MIN_INTERVAL_MS - 1;
  assert.equal(player.play(), false, "a second run right after shares the chime");
  time = sound.COMPLETION_SOUND_MIN_INTERVAL_MS + 1;
  assert.equal(player.play(), true);
  assert.equal(created, 1, "the context is reused");
  assert.equal(log.oscillators.length, 4);

  const silent = sound.createCompletionSoundPlayer({ createContext: () => null });
  assert.equal(silent.play(), false);
  const throwing = sound.createCompletionSoundPlayer({
    createContext: () => {
      throw new Error("no audio device");
    },
  });
  assert.doesNotThrow(() => throwing.unlock());
  assert.equal(throwing.play(), false);
});

test("the setting is off by default, local to the device and toggled on its own", () => {
  const defaults = settings.getDefaultSettings();
  assert.equal(defaults.customSettings.runCompletionSound, false);
  assert.equal(defaults.customSettings.runNotifications, true);
  const on = settings.updateRunCompletionSound(defaults, true);
  assert.equal(on.customSettings.runCompletionSound, true);
  assert.equal(on.customSettings.runNotifications, true);
  assert.equal(settings.updateRunCompletionSound(on, true), on);

  const sync = fs.readFileSync(
    new URL("../../../agent-ui/src/lib/settings/sync.ts", import.meta.url),
    "utf8",
  );
  assert.match(sync, /runCompletionSound: false,/, "never broadcast");
  assert.match(sync, /runCompletionSound: current\.customSettings\.runCompletionSound,/, "never overwritten by a peer");
  const row = fs.readFileSync(
    new URL("../../src/agent-ui-adapters/systemSettings.tsx", import.meta.url),
    "utf8",
  );
  assert.match(row, /data-settings-anchor="run-completion-sound"/);
  assert.match(row, /if \(enabled\) completionSoundPlayer\(\)\.play\(\);/, "turning it on previews the chime");
});

test("the notifier chimes once per update, only in the background, with or without banners", async () => {
  const plays = [];
  const unlocks = [];
  const delivered = [];
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
      "@liveagent/ui/lib/sidebar/selectors": {
        selectConversations: (state) => state.conversations,
        selectRunningConversationIds: (state) => state.running,
      },
      "@liveagent/ui/lib/sidebar/useSidebarSelector": {
        useSidebarSelector: (store, selector) => selector(store.state),
      },
      "../conversations/useBlockedConversationIds": {
        useBlockedConversationIds: (_conversations, store) => store.ids,
      },
      "../../../shims/tauriCore": {
        invoke: async (command, args) => {
          if (command === "chat_notification_deliver") delivered.push(args.conversationId);
        },
      },
      "../../../lib/notifications/completionSound": {
        completionSoundPlayer: () => ({
          play: () => plays.push(Date.now()),
          unlock: () => unlocks.push(1),
        }),
      },
    },
  });
  const { RunAttentionNotifier } = env.loadModule(
    "src/pages/chat/notifications/RunAttentionNotifier.tsx",
  );
  const noUnread = new Set();
  const unreadStore = {
    getSnapshot: () => noUnread,
    subscribe: () => () => {},
    mark: () => {},
    clear: () => {},
  };
  const blocked = { ids: new Set() };
  let focused = false;
  const originalHasFocus = document.hasFocus;
  document.hasFocus = () => focused;
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const render = (running, props) =>
    env.act(async () =>
      root.render(
        env.React.createElement(RunAttentionNotifier, {
          sidebarStore: {
            state: { conversations: [{ id: "a", title: "A" }, { id: "b", title: "B" }], running: new Set(running) },
          },
          approvalStore: blocked,
          questionStore: blocked,
          unreadStore,
          visibleConversationId: "a",
          enabled: true,
          completionSound: true,
          ...props,
        }),
      ),
    );
  try {
    await render(["a", "b"]);
    await render([]);
    assert.equal(plays.length, 1, "two runs finishing together: one chime");
    assert.deepEqual(delivered, ["a", "b"]);

    await render(["a"]);
    focused = true;
    await render([]);
    assert.equal(plays.length, 1, "a focused window gets no chime");

    focused = false;
    await render(["b"], { enabled: false });
    await render([], { enabled: false });
    assert.equal(plays.length, 2, "the chime works with banners off");
    assert.deepEqual(delivered, ["a", "b"], "and sends no banner then");

    await render(["b"], { completionSound: false });
    await render([], { completionSound: false });
    assert.equal(plays.length, 2, "off by setting");

    await render([]);
    window.dispatchEvent(new window.Event("pointerdown"));
    assert.equal(unlocks.length, 1, "an interaction unlocks audio while the sound is on");
    await render([], { completionSound: false });
    window.dispatchEvent(new window.Event("pointerdown"));
    assert.equal(unlocks.length, 1, "and the listener goes away with the setting");
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    document.hasFocus = originalHasFocus;
  }
});
