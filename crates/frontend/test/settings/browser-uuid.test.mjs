import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createUuid } = loader.loadModule("src/lib/shared/id.ts");
const { createHookRunScope } = loader.loadModule("src/lib/automation/hookRunner.ts");
const { createEmptyRequestDraft } = loader.loadModule("src/pages/settings/httpRequestEditor.tsx");
const { normalizeAgentPromptTemplate, normalizeCustomProvider, normalizeSshSettings } =
  loader.loadModule("src/lib/settings/index.ts");

let capturedCronOps = [];
const cronLoader = createTsModuleLoader({
  mocks: {
    "../automation": {
      async applyCronOps(ops) {
        capturedCronOps = ops;
        return {
          tasks: [
            {
              id: "task-id",
              name: "HTTP task",
              type: "http",
              cron: "0 * * * *",
              enabled: true,
              requests: ops[0].item.requests,
            },
          ],
        };
      },
      getAutomationState() {
        return { cron: { tasks: [] } };
      },
      async initAutomation() {},
      async listCronRuns() {
        return [];
      },
      async refreshAutomationSnapshot() {},
    },
  },
});
const { createCronTools } = cronLoader.loadModule("src/lib/tools/cronTools.ts");

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

async function withCryptoAsync(value, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value,
  });
  try {
    return await run();
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

test("hook scopes and Hook/Cron HTTP request drafts work without crypto.randomUUID", () => {
  withCrypto({}, () => {
    const scope = createHookRunScope({ hooks: [], conversationId: "conversation-id" });
    const request = createEmptyRequestDraft();

    scope.close();
    assert.match(request.id, UUID_V4_PATTERN);
  });
});

test("CronTaskManager generates request IDs without crypto.randomUUID", async () => {
  capturedCronOps = [];
  await withCryptoAsync({}, async () => {
    const cronTools = createCronTools({});
    const result = await cronTools.executeToolCall({
      id: "tool-call-id",
      name: "CronTaskManager",
      arguments: {
        action: "create",
        name: "HTTP task",
        type: "http",
        cron: "0 * * * *",
        requests: [{ method: "GET", url: "https://example.com" }],
      },
    });

    assert.equal(result.isError, false);
    assert.match(capturedCronOps[0].item.requests[0].id, UUID_V4_PATTERN);
  });
});
