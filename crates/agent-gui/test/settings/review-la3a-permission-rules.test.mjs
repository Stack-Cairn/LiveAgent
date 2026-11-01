import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// LA-3a adversarial review. The fake K-brain below keeps rules per project the way
// K-brain does (one file per project root, random rule ids) and answers a DELETE for an
// id that is not in the named project's file with 404 {"error":"permission rule not found"}
// (internal/backend/permission_rules.go, permissions.RemoveRule). Assertions compare
// strings, numbers and booleans only: never pass a DOM node to assert.

const uiPath = (relative) =>
  fileURLToPath(new URL(`../../../agent-ui/src/${relative}`, import.meta.url));

const LIVEAGENT = "D:\\work\\LiveAgent";
const KBRAIN = "D:\\work\\K-brain";

const settings = {
  system: {
    workspaceProjects: [
      { id: "a", name: "LiveAgent", path: LIVEAGENT },
      { id: "b", name: "K-brain", path: KBRAIN },
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
    },
  };
  const calls = [];
  const gates = { list: null, add: null };
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
// old project's rules under the new project's header.
test("switching project while an add is in flight shows the new project's rules", async () => {
  await fixture(async ({ fake, settle, click, button, rowsOf, projectHeaderPath, type, pickProject }) => {
    assert.deepEqual(rowsOf("project"), ["Bash(rm:*)"]);
    const pending = gate();
    fake.gates.add = () => pending.promise;
    await type("Bash(curl:*)");
    await click(button("添加"));
    await pickProject(KBRAIN);
    assert.equal(projectHeaderPath(), KBRAIN, "the header follows the chosen project");
    pending.release();
    await settle();
    assert.equal(projectHeaderPath(), KBRAIN);
    assert.deepEqual(
      rowsOf("project"),
      ["Bash(go test:*)"],
      `the "${KBRAIN}" header lists another project's rules; list calls: ${fake.calls.filter((c) => c.startsWith('["list"')).join(" ")}`,
    );
  });
});

// Follow-on of the case above, end to end against the per-project fake: the row shown
// belongs to LiveAgent but the delete names the chosen project, so K-brain answers 404 and
// the rule the user meant to delete stays.
test("after switching project mid-add, deleting a shown project rule removes that rule", async () => {
  await fixture(async ({ host, fake, settle, click, button, rowsOf, alerts, type, pickProject }) => {
    const pending = gate();
    fake.gates.add = () => pending.promise;
    await type("Bash(curl:*)");
    await click(button("添加"));
    await pickProject(KBRAIN);
    pending.release();
    await settle();
    const shown = rowsOf("project");
    const target = shown[0];
    const row = [...host.querySelectorAll('[data-permission-rules="project"] [data-permission-rule]')].find(
      (node) => node.getAttribute("data-permission-rule") === target,
    );
    await click(row.querySelector("button[data-delete-rule]"));
    const deletes = fake.calls.filter((c) => c.startsWith('["delete"'));
    assert.equal(alerts().includes("permission rule not found"), false, `delete of "${target}" failed: ${deletes.join(" ")}`);
    const remaining = [...fake.store.project[LIVEAGENT], ...fake.store.project[KBRAIN]].map((rule) => rule.rule);
    assert.equal(remaining.includes(target), false, `"${target}" is still stored after deleting it: ${deletes.join(" ")}`);
  });
});

// Risk 1: while the new project's list is loading, the old list stays on screen under
// the new header with its delete buttons enabled (only `busy` disables them); a delete
// then names the new project.
test("a project rule deleted while the next project's list is loading names its own project", async () => {
  await fixture(async ({ host, fake, settle, click, rowsOf, alerts, pickProject }) => {
    const pending = gate();
    fake.gates.list = (query) => (query.workspace === KBRAIN ? pending.promise : Promise.resolve());
    await pickProject(KBRAIN);
    const row = host.querySelector('[data-permission-rules="project"] [data-permission-rule="Bash(rm:*)"]');
    const deletable = Boolean(row) && row.querySelector("button[data-delete-rule]")?.disabled === false;
    if (deletable) {
      await click(row.querySelector("button[data-delete-rule]"));
      const deletes = fake.calls.filter((c) => c.startsWith('["delete"'));
      assert.equal(
        deletes.at(-1),
        JSON.stringify(["delete", { id: "r_la0001", scope: "project", workspace: LIVEAGENT }]),
        `LiveAgent's rule was deleted under another project; alerts: ${alerts()}`,
      );
    }
    pending.release();
    await settle();
  });
});

// Risk 6: WebKit (Tauri on macOS = WKWebView, Safari) fires compositionend before the
// committing keydown, which arrives as Enter with keyCode 229 and isComposing=false. The
// rule field only checks isComposing; ToolApprovalBar and MentionComposer use
// isImeKeyboardEvent (MentionComposerInputUtils.ts), which also treats keyCode 229 as IME.
test("committing an IME candidate with Enter in the rule field does not add the rule (WebKit order)", async () => {
  await fixture(async ({ env, host, fake }) => {
    const input = host.querySelector("input[data-permission-rule-input]");
    await env.act(async () => {
      input.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "Edit(文档");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      input.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "文档" }));
      const enter = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      Object.defineProperty(enter, "keyCode", { value: 229 });
      Object.defineProperty(enter, "which", { value: 229 });
      input.dispatchEvent(enter);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    const adds = fake.calls.filter((c) => c.startsWith('["add"'));
    assert.deepEqual(adds, [], `the IME commit Enter added a half-typed rule: ${adds.join(" ")}`);
  });
});
