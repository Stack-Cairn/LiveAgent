import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const { createUuid } = loader.loadModule("@liveagent/ui/lib/shared/id.ts");
const { createEmptyRequestDraft } = loader.loadModule("@liveagent/ui/pages/settings/httpRequestEditor.tsx");
const { normalizeAgentPromptTemplate, normalizeCustomProvider, normalizeSshSettings } =
  loader.loadModule("@/lib/settings/index.ts");

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function withCrypto(value, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  if (value === undefined) {
    delete globalThis.crypto;
  } else {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value,
    });
  }
  try {
    return run();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "crypto", descriptor);
    } else {
      delete globalThis.crypto;
    }
  }
}

test("createUuid uses crypto.randomUUID when available", () => {
  withCrypto({ randomUUID: () => "native-uuid" }, () => {
    assert.equal(createUuid(), "native-uuid");
  });
});

test("createUuid falls back to an RFC 4122 v4 UUID without randomUUID", () => {
  withCrypto({}, () => {
    assert.match(createUuid(), UUID_V4_PATTERN);
  });
});

test("createUuid works when global crypto is unavailable", () => {
  withCrypto(undefined, () => {
    assert.match(createUuid(), UUID_V4_PATTERN);
  });
});

test("createUuid falls back when browser crypto methods throw", () => {
  withCrypto(
    {
      randomUUID() {
        throw new Error("randomUUID unavailable");
      },
      getRandomValues() {
        throw new Error("getRandomValues unavailable");
      },
    },
    () => {
      assert.match(createUuid(), UUID_V4_PATTERN);
    },
  );
});

test("createUuid fallback remains unique when time and randomness repeat", () => {
  const originalNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => 123;
  Math.random = () => 0;
  try {
    withCrypto({}, () => {
      assert.notEqual(createUuid(), createUuid());
    });
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }
});

test("settings normalize generated IDs without crypto.randomUUID", () => {
  withCrypto({}, () => {
    const provider = normalizeCustomProvider({ name: "Provider", type: "codex" });
    const agent = normalizeAgentPromptTemplate({ name: "Agent" });
    const ssh = normalizeSshSettings({
      hosts: [
        { id: "duplicate", host: "first.example" },
        { id: "duplicate", host: "second.example" },
        { host: "third.example" },
      ],
    });

    assert.match(provider.id, UUID_V4_PATTERN);
    assert.match(agent.id, UUID_V4_PATTERN);
    assert.equal(new Set(ssh.hosts.map((host) => host.id)).size, 3);
  });
});

test("Hook/Cron HTTP request drafts work without crypto.randomUUID", () => {
  withCrypto({}, () => {
    assert.match(createEmptyRequestDraft().id, UUID_V4_PATTERN);
  });
});
