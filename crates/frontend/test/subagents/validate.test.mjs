import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import { createAgentToolCall, createSubagentHarness } from "./harness.mjs";

const loader = createTsModuleLoader();
const validate = loader.loadModule("src/lib/subagents/validate.ts");

const TEMPLATES = [
  {
    id: "reviewer",
    name: "Reviewer",
    description: "Review code paths",
    prompt: "Focus on concrete defects.",
  },
];

function identityFor(agentId, overrides = {}) {
  return {
    parentConversationId: "conversation-1",
    agentId,
    name: overrides.name ?? "Existing Expert",
    role: overrides.role ?? "Research",
    identityPrompt: overrides.identityPrompt ?? "Stay in persona.",
    templateId: overrides.templateId,
    lastMode: overrides.lastMode ?? "readonly",
    createdAt: 1,
    updatedAt: 2,
  };
}

function parse(args, options = {}) {
  return validate.parseSubagentBatch(args, {
    identities: options.identities ?? new Map(),
    templates: options.templates ?? TEMPLATES,
  });
}

function issueCodes(result) {
  assert.equal(result.ok, false);
  return result.issues.map((item) => item.code);
}

test("minimal valid agent gets mechanical defaults", () => {
  const result = parse({ agents: [{ id: "expert-a", prompt: "Inspect the code." }] });
  assert.equal(result.ok, true);
  assert.equal(result.batch.agents.length, 1);
  const { spec } = result.batch.agents[0];
  assert.equal(spec.id, "expert-a");
  assert.equal(spec.prompt, "Inspect the code.");
  assert.equal(spec.mode, "readonly");
  assert.equal(spec.applyPolicy, "none");
  assert.deepEqual(spec.allowedOutputPaths, []);
  assert.equal(spec.resume, true);
  assert.equal(spec.retainWorktree, false);
  assert.equal(result.batch.concurrency, 1);
});

test("unknown top-level parameter rejects the whole call", () => {
  const result = parse({
    agents: [{ id: "a", prompt: "ok" }],
    task_intent: "communication",
  });
  assert.deepEqual(issueCodes(result), ["invalid_arguments"]);
  assert.match(result.issues[0].message, /Unknown Agent parameter "task_intent"/);
});

test("agents must be a non-empty array", () => {
  for (const args of [{}, { agents: [] }, { agents: "not-an-array" }]) {
    const result = parse(args);
    assert.equal(result.ok, false);
    assert.match(result.issues.at(-1).message, /agents must be a non-empty array/);
  }
});

test("more than MAX_AGENTS entries is rejected", () => {
  const agents = Array.from({ length: 9 }, (_, index) => ({
    id: `agent-${index}`,
    prompt: "go",
  }));
  const result = parse({ agents });
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /at most 8 entries per call; got 9/);
});

test("unknown agent field is rejected with the allowed field list", () => {
  const result = parse({
    agents: [{ id: "a", prompt: "ok", persona: "wizard" }],
  });
  assert.deepEqual(issueCodes(result), ["invalid_arguments"]);
  assert.match(result.issues[0].message, /Unknown agent field "persona"/);
  assert.match(result.issues[0].message, /Allowed fields: id, prompt, name, role/);
  assert.equal(result.issues[0].agentId, "a");
});

test("id must match the stable id pattern", () => {
  for (const id of ["", "-leading-dash", ".dot", "has space", "a".repeat(65)]) {
    const result = parse({ agents: [{ id, prompt: "ok" }] });
    assert.equal(result.ok, false, `id ${JSON.stringify(id)} should be rejected`);
    assert.match(result.issues[0].message, /id is required and must match/);
  }
  const ok = parse({ agents: [{ id: "A1._-x", prompt: "ok" }] });
  assert.equal(ok.ok, true);
});

test("prompt is required and must be non-empty", () => {
  const result = parse({ agents: [{ id: "a", prompt: "   " }] });
  assert.deepEqual(issueCodes(result), ["invalid_arguments"]);
  assert.match(result.issues[0].message, /prompt is required/);
});

test("duplicate agent ids are rejected case-insensitively", () => {
  const result = parse({
    agents: [
      { id: "Expert-A", prompt: "first" },
      { id: "expert-a", prompt: "second" },
    ],
  });
  assert.deepEqual(issueCodes(result), ["duplicate_agent_id"]);
  assert.match(result.issues[0].message, /Duplicate agent id "expert-a"/);
});

test("unknown template is rejected; enabled templates resolve by id or name case-insensitively", () => {
  const bad = parse({ agents: [{ id: "a", prompt: "ok", template: "ghost" }] });
  assert.deepEqual(issueCodes(bad), ["unknown_template"]);
  assert.match(bad.issues[0].message, /Unknown template "ghost"/);

  const byId = parse({ agents: [{ id: "a", prompt: "ok", template: "REVIEWER" }] });
  assert.equal(byId.ok, true);
  assert.equal(byId.batch.agents[0].template.id, "reviewer");
  assert.equal(byId.batch.agents[0].spec.templateId, "reviewer");

  const byName = parse({ agents: [{ id: "a", prompt: "ok", template: "reviewer" }] });
  assert.equal(byName.ok, true);
  assert.equal(byName.batch.agents[0].template.name, "Reviewer");
});

test("creation fields differing from the stored identity are an identity conflict", () => {
  const identities = new Map([["existing", identityFor("existing")]]);
  const conflicting = parse(
    {
      agents: [
        {
          id: "existing",
          prompt: "continue",
          name: "Different Name",
          role: "Different Role",
          identity: "different persona",
        },
      ],
    },
    { identities },
  );
  assert.deepEqual(issueCodes(conflicting), ["identity_conflict"]);
  assert.match(conflicting.issues[0].message, /conflicting field\(s\): name, role, identity/);

  const matching = parse(
    {
      agents: [
        {
          id: "existing",
          prompt: "continue",
          name: "Existing Expert",
          role: "Research",
          identity: "Stay in persona.",
        },
      ],
    },
    { identities },
  );
  assert.equal(matching.ok, true);
  assert.equal(matching.batch.agents[0].existingIdentity.agentId, "existing");
});

test("mode defaults to the existing identity's last mode and explicit mode overrides it", () => {
  const identities = new Map([
    ["existing", identityFor("existing", { lastMode: "worktree" })],
  ]);
  const inherited = parse({ agents: [{ id: "existing", prompt: "go" }] }, { identities });
  assert.equal(inherited.ok, true);
  assert.equal(inherited.batch.agents[0].spec.mode, "worktree");

  const overridden = parse(
    { agents: [{ id: "existing", prompt: "go", mode: "readonly" }] },
    { identities },
  );
  assert.equal(overridden.ok, true);
  assert.equal(overridden.batch.agents[0].spec.mode, "readonly");

  const invalid = parse({ agents: [{ id: "a", prompt: "go", mode: "yolo" }] });
  assert.equal(invalid.ok, false);
  assert.match(invalid.issues[0].message, /mode must be "readonly" or "worktree"/);
});

test("apply_policy requires worktree mode and validates its value", () => {
  const readonlyPolicy = parse({
    agents: [{ id: "a", prompt: "go", apply_policy: "auto" }],
  });
  assert.deepEqual(issueCodes(readonlyPolicy), ["invalid_arguments"]);
  assert.match(readonlyPolicy.issues[0].message, /only valid with mode=worktree/);

  const invalidPolicy = parse({
    agents: [{ id: "a", prompt: "go", mode: "worktree", apply_policy: "always" }],
  });
  assert.equal(invalidPolicy.ok, false);
  assert.match(invalidPolicy.issues[0].message, /apply_policy must be "none", "explicit", or "auto"/);

  const ok = parse({
    agents: [{ id: "a", prompt: "go", mode: "worktree", apply_policy: "auto" }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.batch.agents[0].spec.applyPolicy, "auto");
});

test("explicit apply policy and allowed_output_paths require each other", () => {
  const explicitWithoutPaths = parse({
    agents: [{ id: "a", prompt: "go", mode: "worktree", apply_policy: "explicit" }],
  });
  assert.equal(explicitWithoutPaths.ok, false);
  assert.match(
    explicitWithoutPaths.issues[0].message,
    /apply_policy=explicit requires at least one allowed_output_paths entry/,
  );

  const pathsWithoutExplicit = parse({
    agents: [
      { id: "a", prompt: "go", mode: "worktree", apply_policy: "auto", allowed_output_paths: ["docs"] },
    ],
  });
  assert.equal(pathsWithoutExplicit.ok, false);
  assert.match(
    pathsWithoutExplicit.issues[0].message,
    /allowed_output_paths requires apply_policy=explicit/,
  );

  const ok = parse({
    agents: [
      {
        id: "a",
        prompt: "go",
        mode: "worktree",
        apply_policy: "explicit",
        allowed_output_paths: ["docs/report.md", "docs/report.md", " src/** "],
      },
    ],
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.batch.agents[0].spec.allowedOutputPaths, ["docs/report.md", "src/**"]);
});

test("allowed_output_paths entries must be non-empty strings inside an array", () => {
  const notArray = parse({
    agents: [
      { id: "a", prompt: "go", mode: "worktree", apply_policy: "explicit", allowed_output_paths: "docs" },
    ],
  });
  assert.equal(notArray.ok, false);
  assert.match(notArray.issues[0].message, /must be an array of workspace-relative path strings/);

  const emptyEntry = parse({
    agents: [
      {
        id: "a",
        prompt: "go",
        mode: "worktree",
        apply_policy: "explicit",
        allowed_output_paths: ["  ", 42],
      },
    ],
  });
  assert.equal(emptyEntry.ok, false);
  assert.ok(
    emptyEntry.issues.filter((item) => /entries must be non-empty strings/.test(item.message))
      .length >= 2,
  );
});

test("resume and retain_worktree must be booleans; resume defaults true", () => {
  const bad = parse({
    agents: [{ id: "a", prompt: "go", resume: "yes", retain_worktree: 1 }],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.issues[0].message, /resume must be a boolean/);
  assert.match(bad.issues[1].message, /retain_worktree must be a boolean/);

  const ok = parse({
    agents: [{ id: "a", prompt: "go", resume: false, retain_worktree: true, mode: "worktree" }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.batch.agents[0].spec.resume, false);
  assert.equal(ok.batch.agents[0].spec.retainWorktree, true);
});

test("batch validation is atomic: one bad agent rejects every agent", () => {
  const result = parse({
    agents: [
      { id: "good-agent", prompt: "fine" },
      { id: "bad agent id", prompt: "fine" },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].agentId, "bad agent id");
});

test("concurrency clamps to [1, MAX_AGENTS] and never exceeds the agent count", () => {
  const capped = parse({
    agents: [
      { id: "a", prompt: "x" },
      { id: "b", prompt: "x" },
    ],
    concurrency: 99,
  });
  assert.equal(capped.ok, true);
  assert.equal(capped.batch.concurrency, 2);

  const floored = parse({
    agents: [
      { id: "a", prompt: "x" },
      { id: "b", prompt: "x" },
    ],
    concurrency: 0,
  });
  assert.equal(floored.ok, true);
  assert.equal(floored.batch.concurrency, 1);

  const defaulted = parse({
    agents: [
      { id: "a", prompt: "x" },
      { id: "b", prompt: "x" },
      { id: "c", prompt: "x" },
    ],
  });
  assert.equal(defaulted.ok, true);
  assert.equal(defaulted.batch.concurrency, 3);
});

test("rejected Agent call returns the structured rejection payload and starts no agents", async () => {
  const harness = await createSubagentHarness();
  await harness.storeIpc.upsertIdentity({
    parentConversationId: "conversation-1",
    agentId: "veteran",
    name: "Veteran",
    role: "History",
    identityPrompt: "",
    lastMode: "readonly",
  });
  harness.store.invalidate();
  await harness.store.ready();

  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [
        { id: "dup", prompt: "one" },
        { id: "DUP", prompt: "two" },
        { id: "third", prompt: "", template: "ghost" },
      ],
    }),
  );

  assert.equal(result.isError, true);
  assert.equal(result.details.kind, "subagent_batch");
  assert.equal(result.details.status, "rejected");
  assert.equal(result.details.agentCount, 0);
  assert.deepEqual(result.details.agents, []);
  assert.deepEqual(
    result.details.issues.map((item) => item.code).sort(),
    ["duplicate_agent_id", "invalid_arguments", "unknown_template"],
  );
  assert.deepEqual(
    result.details.roster.map((entry) => entry.id),
    ["veteran"],
  );
  assert.deepEqual(
    result.details.templates.map((entry) => entry.id),
    ["reviewer"],
  );

  const text = result.content[0].text;
  assert.match(text, /Agent rejected this call\. No subagents were started\./);
  assert.match(text, /\[duplicate_agent_id\]/);
  assert.match(text, /\[unknown_template\]/);
  assert.match(text, /prompt is required/);
  assert.match(text, /id=veteran name=Veteran role=History mode=readonly/);
  assert.match(text, /reviewer \(Reviewer\) - Review code paths/);

  // Atomicity: no runner call, no persistence, no worktree activity.
  assert.equal(harness.runnerCalls.length, 0);
  assert.equal(harness.storeIpc.issuedSaves.length, 0);
  assert.equal(harness.worktreeIpc.creates.length, 0);
});

test("allowed_output_paths escaping the workspace reject the batch before any run starts", async () => {
  const harness = await createSubagentHarness();
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [
        {
          id: "writer",
          prompt: "produce a doc",
          mode: "worktree",
          apply_policy: "explicit",
          allowed_output_paths: ["../outside.md"],
        },
      ],
    }),
  );
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "rejected");
  assert.equal(result.details.issues[0].code, "output_path_outside_workspace");
  assert.equal(harness.runnerCalls.length, 0);
  assert.equal(harness.worktreeIpc.creates.length, 0);
});
