import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  RELEASE_ANNOUNCEMENT_SEEN_STORAGE_KEY,
  markReleaseAnnouncementSeen,
  readSeenReleaseAnnouncementVersion,
  shouldAutoShowReleaseAnnouncement,
} = loader.loadModule("src/lib/releaseAnnouncement.ts");
const { releaseNotesBody, releaseTitle } = loader.loadModule("src/lib/releaseNotes.ts");

function memoryStorage(initialValue) {
  let value = initialValue;
  return {
    getItem(key) {
      assert.equal(key, RELEASE_ANNOUNCEMENT_SEEN_STORAGE_KEY);
      return value ?? null;
    },
    setItem(key, nextValue) {
      assert.equal(key, RELEASE_ANNOUNCEMENT_SEEN_STORAGE_KEY);
      value = nextValue;
    },
    value() {
      return value;
    },
  };
}

test("shows an announcement only when the installed version has not been acknowledged", () => {
  assert.equal(shouldAutoShowReleaseAnnouncement("1.3.6", undefined), true);
  assert.equal(shouldAutoShowReleaseAnnouncement("1.3.6", "1.3.5"), true);
  assert.equal(shouldAutoShowReleaseAnnouncement("1.3.6", "1.3.6"), false);
  assert.equal(shouldAutoShowReleaseAnnouncement(" ", undefined), false);
});

test("persists the acknowledged app version locally", () => {
  const storage = memoryStorage();
  markReleaseAnnouncementSeen(" 1.3.6-beta.1 ", storage);

  assert.equal(storage.value(), "1.3.6-beta.1");
  assert.equal(readSeenReleaseAnnouncementVersion(storage), "1.3.6-beta.1");
});

test("storage failures do not block announcement decisions", () => {
  const storage = {
    getItem() {
      throw new Error("storage disabled");
    },
    setItem() {
      throw new Error("storage disabled");
    },
  };

  assert.equal(readSeenReleaseAnnouncementVersion(storage), undefined);
  assert.doesNotThrow(() => markReleaseAnnouncementSeen("1.3.6", storage));
});

test("release notes remove a duplicated release heading but preserve Markdown", () => {
  const release = {
    releaseName: "LiveAgent v1.3.6",
    body: "<!-- generated -->\n# LiveAgent v1.3.6\n\n## Highlights\n\n- Faster startup",
  };

  assert.equal(releaseTitle(release), "LiveAgent v1.3.6");
  assert.equal(releaseNotesBody(release), "## Highlights\n\n- Faster startup");
});

test("release notes keep a non-duplicated first heading", () => {
  const release = {
    releaseTag: "v1.3.6",
    body: "# Breaking changes\n\nPlease review the migration notes.",
  };

  assert.equal(releaseNotesBody(release), release.body);
});

function createControllerHarness(result) {
  const states = [];
  const refs = [];
  const effects = [];
  const invokeCalls = [];
  let stateIndex = 0;
  let refIndex = 0;
  const react = {
    useState(initialValue) {
      const index = stateIndex++;
      if (!(index in states)) {
        states[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      return [
        states[index],
        (next) => {
          states[index] = typeof next === "function" ? next(states[index]) : next;
        },
      ];
    },
    useRef(initialValue) {
      const index = refIndex++;
      refs[index] ??= { current: initialValue };
      return refs[index];
    },
    useCallback(callback) {
      return callback;
    },
    useEffect(callback) {
      effects.push(callback);
    },
    useMemo(factory) {
      return factory();
    },
  };
  const controllerLoader = createTsModuleLoader({
    mocks: {
      react,
      "@tauri-apps/api/core": {
        async invoke(command) {
          invokeCalls.push(command);
          assert.ok(
            ["app_release_announcement", "app_release_announcement_preview"].includes(command),
          );
          return result;
        },
      },
    },
  });
  const { useReleaseAnnouncementController } = controllerLoader.loadModule(
    "src/lib/releaseAnnouncement.ts",
  );

  return {
    invokeCalls,
    render() {
      stateIndex = 0;
      refIndex = 0;
      effects.length = 0;
      return useReleaseAnnouncementController({ enabled: true, currentVersion: "1.3.6" });
    },
    runEffects() {
      for (const effect of effects) effect();
    },
  };
}

test("first launch opens once, dismiss stays session-local, and acknowledge persists", async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = memoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });

  try {
    const announcement = {
      currentVersion: "1.3.6",
      releaseTag: "v1.3.6",
      body: "## Highlights",
      channel: "stable",
      repository: "Stack-Cairn/LiveAgent",
    };
    const harness = createControllerHarness(announcement);
    let controller = harness.render();
    harness.runEffects();
    await new Promise((resolve) => setImmediate(resolve));

    controller = harness.render();
    assert.equal(controller.open, true);
    assert.deepEqual(harness.invokeCalls, ["app_release_announcement"]);

    controller.dismissForNow();
    controller = harness.render();
    harness.runEffects();
    assert.equal(controller.open, false);
    assert.equal(storage.value(), undefined);

    await controller.openAnnouncement();
    controller = harness.render();
    assert.equal(controller.open, true);
    assert.equal(harness.invokeCalls.length, 1, "manual reopen should reuse the fetched release");

    controller.acknowledge();
    controller = harness.render();
    assert.equal(controller.open, false);
    assert.equal(storage.value(), "1.3.6");
  } finally {
    if (previousStorage) {
      Object.defineProperty(globalThis, "localStorage", previousStorage);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test("debug preview opens the dialog without changing the acknowledged version", async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = memoryStorage("1.3.5");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });

  try {
    const harness = createControllerHarness({
      currentVersion: "1.3.6-beta.1",
      releaseTag: "v1.3.6-beta.1",
      body: "## Preview",
      channel: "prerelease",
      repository: "Stack-Cairn/LiveAgent",
    });
    let controller = harness.render();
    await controller.openPreviewAnnouncement();

    controller = harness.render();
    assert.equal(controller.open, true);
    assert.equal(controller.preview, true);
    assert.deepEqual(harness.invokeCalls, ["app_release_announcement_preview"]);

    controller.acknowledge();
    controller = harness.render();
    assert.equal(controller.open, false);
    assert.equal(storage.value(), "1.3.5");
  } finally {
    if (previousStorage) {
      Object.defineProperty(globalThis, "localStorage", previousStorage);
    } else {
      delete globalThis.localStorage;
    }
  }
});
