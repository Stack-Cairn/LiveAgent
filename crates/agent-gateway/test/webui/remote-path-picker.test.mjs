import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

for (const home of ["/Users/Tester", "C:\\Users\\Tester", "\\\\Server\\Share\\Tester"]) {
  for (const mode of ["directory", "file"]) {
    test(`remote picker retries roots, opens and selects host ${mode}: ${home}`, async () => {
      const calls = [];
      const selected = [];
      let rootFailures = 1;
      const separator = home.startsWith("/") ? "/" : "\\";
      const project = `${home}${separator}project`;
      const env = await createWebDomTestEnv({
        mocks: {
          "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
          "@liveagent/app/shims/tauriCore": {
            invoke: async (command, args) => {
              calls.push([command, args]);
              if (command === "fs_roots") {
                if (rootFailures-- > 0) throw new Error("temporary offline");
                return { roots: [{ id: "home", path: home, kind: "home", label: "~" }] };
              }
              if (command === "fs_list_dirs") {
                if (args.path.includes("missing")) throw new Error("Not found");
                return {
                  path: args.path,
                  entries: args.path === home ? [{ path: project, name: "project" }] : [],
                  truncated: false,
                };
              }
              if (command === "fs_list")
                return {
                  entries:
                    args.workdir === project
                      ? [{ path: "sample.txt", kind: "file", hidden: false }]
                      : [{ path: "project", kind: "dir", hidden: false }],
                  hasMore: false,
                };
              throw new Error(`Unexpected command: ${command}`);
            },
          },
          "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key, locale: "zh-CN" }) },
        },
      });
      const { RemotePathPickerModal } = env.loadModule(
        "src/components/RemotePathPickerModal.tsx",
      );
      const host = document.body.appendChild(document.createElement("div"));
      const root = env.createRoot(host);
      const button = (label) =>
        [...document.querySelectorAll("button")].find((node) => node.textContent === label);
      async function enterPath(path) {
        const input = document.querySelector('input[aria-label="settings.pathPickerPathLabel"]');
        await env.act(async () => {
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
            input,
            path,
          );
          input.dispatchEvent(new window.Event("input", { bubbles: true }));
        });
        await env.act(async () => button("settings.pathPickerOpen").click());
      }
      try {
        await env.act(async () =>
          root.render(
            env.React.createElement(RemotePathPickerModal, {
              mode,
              onClose() {},
              onSelect: (path) => selected.push(path),
            }),
          ),
        );
        assert.ok(button("chat.retry"));
        await env.act(async () => button("chat.retry").click());
        assert.ok(
          calls.some(([command, args]) =>
            mode === "directory"
              ? command === "fs_list_dirs" && args.path === home
              : command === "fs_list" && args.workdir === home,
          ),
        );
        assert.equal(
          document.querySelector('input[aria-label="settings.pathPickerPathLabel"]').value,
          home,
        );
        assert.ok(document.body.textContent.includes("project"));
        await enterPath(`${home}${separator}missing`);
        assert.ok(document.body.textContent.includes("Not found"));
        assert.equal(button("settings.select").disabled, true);
        assert.deepEqual(selected, []);
        await enterPath(project);
        assert.ok(!document.body.textContent.includes("Not found"));
        if (mode === "file") {
          await env.act(async () => button("sample.txt").click());
        }
        await env.act(async () => button("settings.select").click());
        assert.deepEqual(selected, [
          mode === "file" ? `${project}${separator}sample.txt` : project,
        ]);
      } finally {
        await env.act(async () => root.unmount());
        host.remove();
        env.cleanup();
      }
    });
  }
}

test("remote path comparison respects Windows aliases and POSIX case", () => {
  const { normalizePathForCompare: key, isSameOrDescendantPath } =
    createWebModuleLoader().loadModule("src/components/remotePathPickerPaths.ts");
  assert.equal(key("C:\\Users\\Tester"), key("c:/users/tester/"));
  assert.equal(key("\\\\?\\C:\\Users\\Tester"), key("C:/Users/Tester"));
  assert.equal(key("\\\\Server\\Share\\Tester"), key("//server/share/tester"));
  assert.notEqual(key("/Users/Tester"), key("/users/tester"));
  assert.notEqual(key("/tmp/a\\b"), key("/tmp/a/b"));
  assert.ok(
    isSameOrDescendantPath("\\\\SERVER\\SHARE\\Tester\\project", "\\\\server\\share\\tester"),
  );
  assert.equal(isSameOrDescendantPath("C:\\Users\\Tester2", "C:\\Users\\Tester"), false);
});
