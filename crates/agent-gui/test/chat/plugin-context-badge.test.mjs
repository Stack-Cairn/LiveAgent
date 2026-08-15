import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
const jsxRuntime = requireFromRoot("react/jsx-runtime");
const { renderToStaticMarkup } = requireFromRoot("react-dom/server");

const loader = createTsModuleLoader({
  rootDir,
  mocks: {
    "react/jsx-runtime": jsxRuntime,
    "@liveagent/ui/components/IconSet": {
      Plug() {
        return null;
      },
      ChevronDown() {
        return null;
      },
    },
    "@liveagent/ui/components/ui/badge": {
      Badge({ children, ...props }) {
        return jsxRuntime.jsx("span", { ...props, children });
      },
    },
    // Popover 只在打开时挂载弹层，静态渲染拿不到正文；这里把它压平成直通壳，
    // 让 trigger 的 render 元素与 Popup 内容都进入同一份 HTML 供断言。
    "@base-ui/react": {
      Popover: {
        Root({ children }) {
          return jsxRuntime.jsx("div", { children });
        },
        Trigger({ render }) {
          return render;
        },
        Portal({ children }) {
          return jsxRuntime.jsx("div", { children });
        },
        Positioner({ children }) {
          return jsxRuntime.jsx("div", { children });
        },
        Popup({ children, ...props }) {
          return jsxRuntime.jsx("div", { ...props, children });
        },
      },
    },
    "@liveagent/ui/i18n/LocaleContext": {
      useLocale() {
        return {
          t(key) {
            return key === "chat.pluginContextApplied" ? "本轮已注入插件提示" : key;
          },
        };
      },
    },
  },
});

const { PluginContextBadge } = loader.loadModule(
  "@liveagent/ui/components/chat/PluginContextBadge.tsx",
);

test("plugin context badge exposes the applied immutable snapshot", () => {
  const html = renderToStaticMarkup(
    jsxRuntime.jsx(PluginContextBadge, {
      context: {
        snapshotRevision: "snapshot-009",
        promptSections: [
          {
            pluginId: "com.liveagent.conversation.commit-style",
            pluginVersion: "1.0.1",
            packageHash: "a".repeat(64),
            generation: 4,
            contributionId: "instructions",
            truncated: false,
          },
        ],
      },
    }),
  );

  assert.match(html, /data-liveagent-plugin-context="snapshot-009"/);
  assert.match(html, /本轮已注入插件提示/);
  assert.match(html, /commit-style v1\.0\.1/);
  // 快照 revision、generation、包哈希与 contribution 是"宿主确实注入过"的证据，
  // 必须在可展开的弹层里逐项可读，而不是塞进一个 title 提示串。
  assert.match(html, /snapshot-009/);
  assert.match(html, /chat\.pluginContextSnapshot/);
  assert.match(html, /chat\.pluginContextGeneration/);
  assert.match(html, />4</);
  assert.match(html, new RegExp("a".repeat(64)));
  assert.match(html, /instructions/);
});
