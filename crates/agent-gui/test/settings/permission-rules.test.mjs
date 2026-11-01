import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// LA-3a: Settings → 权限 lists the rules "allow and remember" stored (all projects and the
// chosen project), deletes them, and adds rules by hand. Assertions compare strings and
// booleans only: a failing assert on a DOM node would print the whole jsdom tree.

const uiPath = (relative) =>
  fileURLToPath(new URL(`../../../agent-ui/src/${relative}`, import.meta.url));

const projects = [
  { id: "a", name: "LiveAgent", path: "D:\\work\\LiveAgent" },
  { id: "b", name: "K-brain", path: "D:\\work\\K-brain" },
  { id: "c", name: "Hidden", path: "D:\\work\\Hidden" },
];

function settingsWith(list = projects) {
  return {
    system: {
      workspaceProjects: list,
      hiddenWorkspaceProjectPaths: ["D:\\work\\Hidden"],
      archivedWorkspaceProjectPaths: [],
    },
  };
}

const userRule = { id: "u1", rule: "Bash(npm test:*)", effect: "allow", scope: "user", createdAt: "2026-11-01T08:00:00Z", sourceSession: "cd5cf421aa" };
const projectRule = { id: "p1", rule: "Bash(rm:*)", effect: "deny", scope: "project", createdAt: "2026-11-01T09:00:00Z" };

async function fixture(task, options = {}) {
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
    "@liveagent/ui/components/ui/button": { Button: ({ children, size, variant, ...props }) => env.React.createElement("button", props, children) },
    "@liveagent/ui/components/settings/SettingsToggleGroup": {
      SettingsToggleGroup: ({ children, value, onValueChange, disabled, ...props }) => env.React.createElement("div", props,
        env.React.Children.map(children, (child) => env.React.cloneElement(child, { disabled: disabled || child.props.disabled, pressed: value.includes(child.props.value), onSelect: () => onValueChange([child.props.value]) }))),
      SettingsToggleGroupItem: ({ children, value, pressed, onSelect, disabled, ...props }) => env.React.createElement("button", { ...props, disabled, "data-toggle": value, "aria-pressed": pressed, onClick: onSelect }, children),
    },
    [uiPath("components/ui/select.tsx")]: {
      Select: ({ value, onValueChange, disabled, children }) => env.React.createElement("select", { value, disabled, "data-project-select": "", onChange: (event) => onValueChange(event.target.value) }, children),
      SelectItem: ({ value, children }) => env.React.createElement("option", { value }, children),
      SelectValue: () => null,
    },
    [uiPath("components/settings/SettingsSelect.tsx")]: {
      SettingsSelectTrigger: () => null,
      SettingsSelectContent: ({ children }) => env.React.createElement(env.React.Fragment, null, children),
    },
    [uiPath("components/ui/confirm-action-popover.tsx")]: {
      ConfirmDeletePopover: ({ children, onConfirm }) => children(onConfirm),
    },
  } });
  const { PermissionRulesSection } = env.loadModule("@liveagent/ui/pages/settings/PermissionRulesSection.tsx");
  const calls = [];
  let rules = { user: [userRule], project: { "D:\\work\\LiveAgent": [projectRule] } };
  let list = async ({ workspace }) => ({
    ...(workspace ? { projectRoot: workspace } : {}),
    rules: [...rules.user, ...(workspace ? rules.project[workspace] ?? [] : [])],
  });
  let add = async (input) => ({ id: `n${calls.length}`, rule: input.rule, effect: input.effect, scope: input.scope });
  const kbrain = {
    getConnection: () => ({ baseUrl: "http://fixture", token: "t" }),
    ...(options.capabilities ? { getCapabilities: async () => options.capabilities } : {}),
    listPermissionRules: (query) => { calls.push(["list", query]); return list(query); },
    addPermissionRule: (input) => { calls.push(["add", input]); return add(input); },
    deletePermissionRule: async (ref) => { calls.push(["delete", ref]); },
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const settle = () => env.act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
  const click = async (element) => { await env.act(async () => { element.click(); }); await settle(); };
  const button = (text) => [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  const rowsOf = (scope) => [...host.querySelectorAll(`[data-permission-rules="${scope}"] [data-permission-rule]`)].map((row) => row.getAttribute("data-permission-rule"));
  const type = (value) => env.act(async () => {
    const input = host.querySelector("input[data-permission-rule-input]");
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  const pickProject = async (path) => {
    await env.act(async () => {
      const select = host.querySelector("select[data-project-select]");
      select.value = path;
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await settle();
  };
  try {
    await env.act(async () => root.render(env.React.createElement(PermissionRulesSection, { kbrain, settings: options.settings ?? settingsWith() })));
    await settle();
    await task({ env, host, calls, button, click, rowsOf, type, pickProject, settle,
      setRules: (next) => { rules = next; }, setList: (next) => { list = next; }, setAdd: (next) => { add = next; } });
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
}

test("lists all-project rules and the first visible project's rules; switching project reloads", async () => {
  await fixture(async ({ host, calls, rowsOf, pickProject }) => {
    assert.deepEqual(calls[0], ["list", { workspace: "D:\\work\\LiveAgent" }]);
    assert.deepEqual(rowsOf("user"), ["Bash(npm test:*)"]);
    assert.deepEqual(rowsOf("project"), ["Bash(rm:*)"]);
    const options = [...host.querySelectorAll("select[data-project-select] option")].map((o) => o.value);
    assert.deepEqual(options, ["D:\\work\\LiveAgent", "D:\\work\\K-brain"], "hidden projects are not offered");
    assert.match(host.textContent, /允许/);
    assert.match(host.textContent, /拒绝/);
    assert.match(host.textContent, /cd5cf421/, "the source session is shown");
    await pickProject("D:\\work\\K-brain");
    assert.deepEqual(calls.at(-1), ["list", { workspace: "D:\\work\\K-brain" }]);
    assert.deepEqual(rowsOf("project"), []);
    assert.match(host.querySelector('[data-permission-rules="project"]').textContent, /还没有规则/);
  });
});

test("deleting a rule names its scope (and project) and reloads", async () => {
  await fixture(async ({ host, calls, click, rowsOf, setRules }) => {
    setRules({ user: [userRule], project: {} });
    await click(host.querySelector('[data-permission-rule="Bash(rm:*)"] button[data-delete-rule]'));
    assert.deepEqual(calls.find((call) => call[0] === "delete"), ["delete", { id: "p1", scope: "project", workspace: "D:\\work\\LiveAgent" }]);
    assert.deepEqual(rowsOf("project"), [], "the list is reloaded after deleting");
    await click(host.querySelector('[data-permission-rule="Bash(npm test:*)"] button[data-delete-rule]'));
    assert.deepEqual(calls.filter((call) => call[0] === "delete").at(-1), ["delete", { id: "u1", scope: "user" }]);
  });
});

test("adds a deny rule for all projects by default, or for the chosen project", async () => {
  await fixture(async ({ host, calls, button, click, type }) => {
    assert.equal(button("添加").disabled, true, "nothing to add yet");
    await type("Bash(curl:*)");
    await click(button("添加"));
    assert.deepEqual(calls.find((call) => call[0] === "add"), ["add", { rule: "Bash(curl:*)", effect: "deny", scope: "user" }]);
    assert.equal(host.querySelector("input[data-permission-rule-input]").value, "", "the field clears after adding");
    await type("Edit(src/**)");
    await click(host.querySelector('[data-toggle="allow"]'));
    await click(host.querySelector('[data-toggle="project"]'));
    await click(button("添加"));
    assert.deepEqual(calls.filter((call) => call[0] === "add").at(-1), ["add", { rule: "Edit(src/**)", effect: "allow", scope: "project", workspace: "D:\\work\\LiveAgent" }]);
  });
});

test("a rule K-brain refuses keeps the text and shows the reason", async () => {
  await fixture(async ({ host, button, click, type, setAdd }) => {
    setAdd(async () => { throw new Error('permission rule "Bash(": missing closing parenthesis'); });
    await type("Bash(");
    await click(button("添加"));
    assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /missing closing parenthesis/);
    assert.equal(host.querySelector("input[data-permission-rule-input]").value, "Bash(");
  });
});

test("a backend without permission_rules shows an upgrade note and lists nothing", async () => {
  await fixture(async ({ host, calls }) => {
    assert.equal(calls.length, 0);
    assert.match(host.textContent, /不支持权限规则/);
  }, { capabilities: { memory_switch: 1 } });
});

test("only the latest project's answer is shown when answers arrive out of order", async () => {
  await fixture(async ({ calls, rowsOf, pickProject, setList, settle }) => {
    let releaseSlow;
    setList(async ({ workspace }) => {
      if (workspace === "D:\\work\\K-brain") {
        await new Promise((resolve) => { releaseSlow = resolve; });
        return { rules: [{ ...projectRule, id: "slow", rule: "Bash(slow:*)" }] };
      }
      return { rules: [{ ...projectRule, id: "fast", rule: "Bash(fast:*)" }] };
    });
    await pickProject("D:\\work\\K-brain");
    await pickProject("D:\\work\\LiveAgent");
    releaseSlow();
    await settle();
    assert.deepEqual(rowsOf("project"), ["Bash(fast:*)"]);
    assert.equal(calls.filter((call) => call[0] === "list").length >= 3, true);
  });
});

test("without projects the project list says so and project scope cannot be chosen", async () => {
  await fixture(async ({ host, calls }) => {
    assert.deepEqual(calls[0], ["list", {}]);
    assert.match(host.querySelector('[data-permission-rules="project"]').textContent, /没有可选的项目/);
    assert.equal(host.querySelector('[data-toggle="project"]').disabled, true);
  }, { settings: settingsWith([]) });
});

// The desktop adapter talks to K-brain directly.
test("the desktop adapter calls the rules endpoints and reports K-brain's error message", async () => {
  const loader = createTsModuleLoader();
  const { setKBrainRuntimeConnection, clearKBrainRuntimeConnection } = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  const { kbrainSettingsAdapter } = loader.loadModule("src/agent-ui-adapters/kbrainSettings.ts");
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push([init.method ?? "GET", String(url), init.body ?? null]);
    const path = new URL(String(url)).pathname;
    if (init.method === "POST" && JSON.parse(init.body).rule === "Bash(") {
      return new Response(JSON.stringify({ error: 'permission rule "Bash(": missing closing parenthesis' }), { status: 400 });
    }
    if (init.method === "POST") return new Response(JSON.stringify({ id: "r9", rule: "Bash(curl:*)", effect: "deny", scope: "user", created_at: "2026-11-01T00:00:00Z" }), { status: 201 });
    if (init.method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (path === "/v1/permissions/rules") return new Response(JSON.stringify({ project_root: "D:\\w", rules: [{ id: "a", rule: "Bash(ls:*)", effect: "allow", scope: "project", created_at: "2026-11-01T00:00:00Z", source_session: "s1" }] }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  setKBrainRuntimeConnection({ baseUrl: "http://kb", token: "tok", protocolVersion: "kbrain.agent.v1" });
  try {
    const listed = await kbrainSettingsAdapter.listPermissionRules({ workspace: "D:\\w" });
    assert.deepEqual(listed, { projectRoot: "D:\\w", rules: [{ id: "a", rule: "Bash(ls:*)", effect: "allow", scope: "project", createdAt: "2026-11-01T00:00:00Z", sourceSession: "s1" }] });
    assert.deepEqual(requests.at(-1), ["GET", "http://kb/v1/permissions/rules?workspace=D%3A%5Cw", null]);
    const added = await kbrainSettingsAdapter.addPermissionRule({ rule: "Bash(curl:*)", effect: "deny", scope: "user" });
    assert.equal(added.id, "r9");
    assert.deepEqual(JSON.parse(requests.at(-1)[2]), { rule: "Bash(curl:*)", effect: "deny", scope: "user" });
    await kbrainSettingsAdapter.deletePermissionRule({ id: "a b", scope: "project", workspace: "D:\\w" });
    assert.deepEqual(requests.at(-1).slice(0, 2), ["DELETE", "http://kb/v1/permissions/rules/a%20b?scope=project&workspace=D%3A%5Cw"]);
    await assert.rejects(
      kbrainSettingsAdapter.addPermissionRule({ rule: "Bash(", effect: "deny", scope: "user" }),
      (error) => error.message === 'permission rule "Bash(": missing closing parenthesis',
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearKBrainRuntimeConnection();
  }
});
