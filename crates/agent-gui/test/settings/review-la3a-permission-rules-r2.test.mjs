import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// LA-3a adversarial review, round 2 (after binding the list to its project, reload(target)
// and isImeKeyboardEvent). The fake K-brain below keeps rules per project the way
// K-brain does (one file per project root, random rule ids) and answers a DELETE for an
// id that is not in the named project's file with 404 {"error":"permission rule not found"}
// (internal/backend/permission_rules.go, permissions.RemoveRule). Assertions compare
// strings, numbers and booleans only: never pass a DOM node to assert.

const uiPath = (relative) =>
  fileURLToPath(new URL(`../../../agent-ui/src/${relative}`, import.meta.url));

const LIVEAGENT = "D:\\work\\LiveAgent";
const KBRAIN = "D:\\work\\K-brain";
const DOCS = "D:\\work\\Docs";

const settings = {
  system: {
    workspaceProjects: [
      { id: "a", name: "LiveAgent", path: LIVEAGENT },
      { id: "b", name: "K-brain", path: KBRAIN },
      { id: "c", name: "Docs", path: DOCS },
    ],
    hiddenWorkspaceProjectPaths: [],
    archivedWorkspaceProjectPaths: [],
  },
};

function fakeKBrain() {
  const store = {
    user: [{ id: "r_user01", rule: "Bash(npm test:*)", effect: "allow", scope: "user" }],
    project: {
      [LIVEAGENT]: [{ id: "r_la0001", rule: "Bash(rm:*)", effect: "deny", scope: "project" }],
      [KBRAIN]: [{ id: "r_kb0001", rule: "Bash(go test:*)", effect: "allow", scope: "project" }],
      [DOCS]: [{ id: "r_dc0001", rule: "Edit(docs/**)", effect: "allow", scope: "project" }],
    },
  };
  const calls = [];
  const gates = { list: null, add: null, delete: null };
  const wait = (name, arg) => (gates[name] ? gates[name](arg) : Promise.resolve());
  const kbrain = {
    isKbrain: true,
    getConnection: () => ({ baseUrl: "http://fixture", token: "t" }),
    listPermissionRules: async (query) => {
      calls.push(JSON.stringify(["list", query.workspace ?? ""]));
      await wait("list", query);
      return {
        ...(query.workspace ? { projectRoot: query.workspace } : {}),
        rules: [...store.user, ...(query.workspace ? (store.project[query.workspace] ?? []) : [])],
      };
    },
    addPermissionRule: async (input) => {
      calls.push(JSON.stringify(["add", input]));
      await wait("add", input);
      const rule = { id: `r_new${calls.length}`, rule: input.rule, effect: input.effect, scope: input.scope };
      if (input.scope === "user") store.user.push(rule);
      else (store.project[input.workspace] ??= []).push(rule);
      return rule;
    },
    deletePermissionRule: async (ref) => {
      calls.push(JSON.stringify(["delete", ref]));
      await wait("delete", ref);
      const file = ref.scope === "user" ? store.user : (store.project[ref.workspace] ?? []);
      const index = file.findIndex((rule) => rule.id === ref.id);
      if (index < 0) throw new Error("permission rule not found");
      file.splice(index, 1);
    },
  };
  return { kbrain, store, calls, gates };
}

async function fixture(task) {
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
      "@liveagent/ui/components/ui/button": {
        Button: ({ children, size, variant, ...props }) => env.React.createElement("button", props, children),
      },
      "@liveagent/ui/components/settings/SettingsToggleGroup": {
        SettingsToggleGroup: ({ children, value, onValueChange, disabled, ...props }) =>
          env.React.createElement(
            "div",
            props,
            env.React.Children.map(children, (child) =>
              env.React.cloneElement(child, {
                disabled: disabled || child.props.disabled,
                pressed: value.includes(child.props.value),
                onSelect: () => onValueChange([child.props.value]),
              }),
            ),
          ),
        SettingsToggleGroupItem: ({ children, value, pressed, onSelect, disabled, ...props }) =>
          env.React.createElement("button", { ...props, disabled, "data-toggle": value, "aria-pressed": pressed, onClick: onSelect }, children),
      },
      [uiPath("components/ui/select.tsx")]: {
        Select: ({ value, onValueChange, disabled, children }) =>
          env.React.createElement("select", { value, disabled, "data-project-select": "", onChange: (event) => onValueChange(event.target.value) }, children),
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
    },
  });
  const { PermissionRulesSection } = env.loadModule("@liveagent/ui/pages/settings/PermissionRulesSection.tsx");
  const fake = fakeKBrain();
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const settle = () => env.act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
  const click = async (element) => { await env.act(async () => { element.click(); }); await settle(); };
  const button = (text) => [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  const rowsOf = (scope) =>
    [...host.querySelectorAll(`[data-permission-rules="${scope}"] [data-permission-rule]`)].map((row) => row.getAttribute("data-permission-rule"));
  const projectHeaderPath = () =>
    [...host.querySelectorAll('[data-permission-rules="project"] p')].map((p) => p.textContent).find((text) => text.startsWith("D:\\")) ?? "";
  const alerts = () => [...host.querySelectorAll('[role="alert"]')].map((node) => node.textContent).join(" | ");
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
    await env.act(async () => root.render(env.React.createElement(PermissionRulesSection, { kbrain: fake.kbrain, settings })));
    await settle();
    await task({ env, host, fake, settle, click, button, rowsOf, projectHeaderPath, alerts, type, pickProject });
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
}

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

// Risk 1/2: run() awaits the action and then calls the reload captured when the click
// happened. If the project changes while the action is in flight, that stale reload
// (old workspace) takes a newer ticket, drops the new project's answer and leaves the

const deleteButtons = (host, scope) =>
  [...host.querySelectorAll(`[data-permission-rules="${scope}"] button[data-delete-rule]`)].length;
const rowButton = (host, rule) =>
  host.querySelector(`[data-permission-rule="${rule}"] button[data-delete-rule]`);
const stored = (fake, path) => (fake.store.project[path] ?? []).map((rule) => rule.rule);

// R2-1: while the chosen project loads, its section shows no other project's rows (and no
// delete buttons); all-project rules stay; the answer then shows the chosen project.
test("r2: switching to a slow project hides the previous project's rows until it answers", async () => {
  await fixture(async ({ host, fake, settle, rowsOf, projectHeaderPath, pickProject }) => {
    const pending = gate();
    fake.gates.list = (query) => (query.workspace === KBRAIN ? pending.promise : Promise.resolve());
    await pickProject(KBRAIN);
    assert.deepEqual(rowsOf("project"), [], "no LiveAgent rows under K-brain while it loads");
    assert.equal(deleteButtons(host, "project"), 0);
    assert.deepEqual(rowsOf("user"), ["Bash(npm test:*)"], "all-project rules stay");
    pending.release();
    await settle();
    assert.equal(projectHeaderPath(), KBRAIN);
    assert.deepEqual(rowsOf("project"), ["Bash(go test:*)"]);
  });
});

// R2-2: A -> B (slow) -> A: A's list is shown again and a delete names A.
test("r2: switching away and back before the slow answer deletes in the shown project", async () => {
  await fixture(async ({ host, fake, settle, click, rowsOf, alerts, pickProject }) => {
    const pending = gate();
    fake.gates.list = (query) => (query.workspace === KBRAIN ? pending.promise : Promise.resolve());
    await pickProject(KBRAIN);
    await pickProject(LIVEAGENT);
    assert.deepEqual(rowsOf("project"), ["Bash(rm:*)"]);
    await click(rowButton(host, "Bash(rm:*)"));
    pending.release();
    await settle();
    assert.equal(alerts(), "");
    assert.deepEqual(stored(fake, LIVEAGENT), [], "LiveAgent's rule is deleted");
    assert.deepEqual(rowsOf("project"), [], `slow K-brain answer must not replace LiveAgent: ${rowsOf("project").join(",")}`);
  });
});

// R2-3: a delete in flight while the user switches project names the rule's project and
// the reload afterwards shows the project chosen now.
test("r2: switching project while a delete is in flight deletes in the rule's project", async () => {
  await fixture(async ({ host, fake, settle, click, rowsOf, projectHeaderPath, alerts, pickProject }) => {
    const pending = gate();
    fake.gates.delete = () => pending.promise;
    await click(rowButton(host, "Bash(rm:*)"));
    await pickProject(KBRAIN);
    pending.release();
    await settle();
    const deletes = fake.calls.filter((c) => c.startsWith('["delete"'));
    assert.equal(deletes.at(-1), JSON.stringify(["delete", { id: "r_la0001", scope: "project", workspace: LIVEAGENT }]));
    assert.equal(alerts(), "");
    assert.deepEqual(stored(fake, LIVEAGENT), []);
    assert.equal(projectHeaderPath(), KBRAIN);
    assert.deepEqual(rowsOf("project"), ["Bash(go test:*)"]);
  });
});

// R2-4: a switch during the reload that follows an add wins over that reload.
test("r2: switching project during the post-add reload shows the last chosen project", async () => {
  await fixture(async ({ fake, settle, click, button, rowsOf, projectHeaderPath, type, pickProject }) => {
    const pendingAdd = gate();
    const pendingReload = gate();
    let adds = 0;
    fake.gates.add = () => { adds++; return pendingAdd.promise; };
    fake.gates.list = (query) => (adds > 0 && query.workspace === KBRAIN ? pendingReload.promise : Promise.resolve());
    await type("Bash(curl:*)");
    await click(button("添加"));
    await pickProject(KBRAIN);
    pendingAdd.release();
    await settle();
    await pickProject(DOCS);
    pendingReload.release();
    await settle();
    assert.equal(projectHeaderPath(), DOCS);
    assert.deepEqual(rowsOf("project"), ["Edit(docs/**)"]);
    assert.deepEqual(rowsOf("user"), ["Bash(npm test:*)", "Bash(curl:*)"]);
  });
});

// R2-5: a project-scope add stores the rule in the project chosen when Add was pressed,
// even if the user switches while it runs.
test("r2: a project-scope add keeps the project chosen at the click", async () => {
  await fixture(async ({ host, fake, settle, click, button, rowsOf, type, pickProject }) => {
    const pending = gate();
    fake.gates.add = () => pending.promise;
    await type("Bash(make:*)");
    await click(host.querySelector('[data-toggle="project"]'));
    await click(button("添加"));
    await pickProject(KBRAIN);
    pending.release();
    await settle();
    assert.deepEqual(stored(fake, LIVEAGENT), ["Bash(rm:*)", "Bash(make:*)"]);
    assert.deepEqual(stored(fake, KBRAIN), ["Bash(go test:*)"]);
    assert.deepEqual(rowsOf("project"), ["Bash(go test:*)"]);
  });
});

// R2-6: a failed load for the chosen project shows no rows and no delete buttons; picking
// a project that loads recovers.
test("r2: a failed project load shows the error and no stale rows; another project recovers", async () => {
  await fixture(async ({ host, fake, rowsOf, alerts, pickProject }) => {
    fake.gates.list = (query) => (query.workspace === KBRAIN ? Promise.reject(new Error("project root must be absolute")) : Promise.resolve());
    await pickProject(KBRAIN);
    assert.match(alerts(), /project root must be absolute/);
    assert.deepEqual(rowsOf("project"), []);
    assert.equal(deleteButtons(host, "project") + deleteButtons(host, "user"), 0);
    await pickProject(DOCS);
    assert.equal(alerts(), "");
    assert.deepEqual(rowsOf("project"), ["Edit(docs/**)"]);
  });
});

// R2-7: positive guard for the IME fix: isImeKeyboardEvent must not swallow a real Enter
// (keyCode 13). The keyCode 229 commit case is round 1's IME test.
test("r2: a plain Enter (keyCode 13) in the rule field still adds", async () => {
  await fixture(async ({ env, host, fake, settle, type }) => {
    const press = (init, keyCode) => env.act(async () => {
      const input = host.querySelector("input[data-permission-rule-input]");
      const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(event, "keyCode", { value: keyCode });
      Object.defineProperty(event, "which", { value: keyCode });
      input.dispatchEvent(event);
    });
    await type("Bash(curl:*)");
    await press({ key: "Enter" }, 13);
    await settle();
    assert.deepEqual(fake.calls.filter((c) => c.startsWith('["add"')), [JSON.stringify(["add", { rule: "Bash(curl:*)", effect: "deny", scope: "user" }])]);
  });
});
