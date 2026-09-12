import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("SFTP paths preserve breadcrumbs, keyboard selection and ignore closed requests", async () => {
  const icon = () => null;
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": { AlertTriangle: icon, ChevronRight: icon, FolderTree: icon, Loader2: icon },
    "@liveagent/ui/components/chat/fileTypeIcons": { getFileTypeIcon: () => icon },
  }});
  const { React, act } = env;
  env.dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const { SftpPathNavigator } = env.loadModule("@liveagent/ui/components/workspace-editor/SftpPathNavigator.tsx");
  const host = document.createElement("div");
  document.body.append(host);
  const root = env.createRoot(host);
  const requests = [], navigations = [];
  const client = { list: args => new Promise(resolve => requests.push({ args, resolve })) };
  const props = { side: "remote", path: "/home/dev", loading: false, client,
    sessionId: "session", projectPathKey: "project", workdir: "/work", rootLabel: "Project",
    onNavigate: path => navigations.push(path), t: key => key };
  const render = async patch => act(async () => root.render(React.createElement(SftpPathNavigator, { ...props, ...patch })));
  const edit = async () => act(async () => host.querySelector('[aria-label="workspaceSftp.pathEdit"]').click());
  const key = async key => act(async () => host.querySelector("input").dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  const wait = async () => act(async () => new Promise(resolve => setTimeout(resolve, 210)));
  const entries = [
    { name: "zeta", path: "/home/dev/zeta", kind: "directory" },
    { name: "file", path: "/home/dev/file", kind: "file" },
    { name: "alpha", path: "/home/dev/alpha", kind: "directory" },
  ];
  try {
    await render({});
    assert.deepEqual([...host.querySelectorAll("button[title]")].map(n => n.textContent), ["/", "home", "dev"]);
    await act(async () => host.querySelector('button[title="/home"]').click());
    assert.deepEqual(navigations, ["/home"]);
    await edit();
    assert.equal(document.activeElement, host.querySelector("input"));
    await wait();
    assert.deepEqual(requests[0].args, { sessionId: "session", projectPathKey: "project", workdir: "/work", side: "remote", path: "/home/dev" });
    await act(async () => requests[0].resolve({ entries }));
    assert.deepEqual([...host.querySelectorAll('[role="option"]')].map(n => n.title), ["/home/dev/alpha", "/home/dev/zeta"]);
    await key("ArrowDown");
    assert.equal(host.querySelector('[aria-selected="true"]').title, "/home/dev/alpha");
    assert.equal(host.querySelector("input").getAttribute("aria-activedescendant"), host.querySelector('[aria-selected="true"]').id);
    await key("Enter");
    assert.deepEqual(navigations, ["/home", "/home/dev/alpha"]);
    assert.equal(host.querySelector("input"), null);
    await edit();
    await wait();
    await key("Escape");
    await edit();
    await wait();
    await act(async () => requests[2].resolve({ entries: [] }));
    assert.match(host.textContent, /workspaceSftp.pathNoMatches/);
    await act(async () => requests[1].resolve({ entries }));
    assert.equal(host.querySelectorAll('[role="option"]').length, 0);
    await key("Escape");
    assert.equal(navigations.length, 2);
    await render({ side: "local", path: "src/components" });
    assert.deepEqual([...host.querySelectorAll("button[title]")].map(n => n.textContent), ["Project", "src", "components"]);
    await act(async () => host.querySelector('button[title="Project"]').click());
    assert.equal(navigations.at(-1), "");
    await render({ path: "." });
    assert.equal(host.querySelector("button[title]").textContent, "~");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
});
