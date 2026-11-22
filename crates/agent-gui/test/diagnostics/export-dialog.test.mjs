// The export dialog previews the redacted bundle before saving. Host adapter,
// clipboard and dialog chrome are fakes; nothing reaches a real clipboard,
// file system or backend.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const HOME = "/Users/fixture-user";

test("preview lists files and redactions, copy uses the injected clipboard, save goes to the host", async () => {
  let env;
  const Box = ({ children, ...rest }) =>
    env.React.createElement("div", { "data-testid": rest["data-testid"] }, children);
  const icons = new Proxy({}, { get: (_target, name) => (name === "__esModule" ? false : () => null) });
  const saved = [];
  let collectCalls = 0;
  env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": icons,
      "@liveagent/ui/components/ui/dialog": Object.fromEntries(
        "Dialog DialogBody DialogContent DialogDescription DialogFooter DialogHeader DialogTitle"
          .split(" ")
          .map((name) => [name, Box]),
      ),
      "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en", t: (key) => key }) },
      "@liveagent/adapters/diagnostics": {
        DIAGNOSTICS_SAVE_LABEL_KEY: "diagnostics.save",
        collectHostDiagnostics: async () => {
          collectCalls += 1;
          return {
            host: "desktop",
            app: { version: "1.0.0", os: "macos", arch: "aarch64" },
            kbrain: { health: null, healthError: "offline", connection: { state: "unreachable" } },
            sessionCount: 0,
            logFiles: [
              {
                name: "k-brain.log",
                content: `start ${HOME}/x api_key=sk-fixture-provider-key-0123456789\n`,
                truncated: false,
                originalBytes: 60,
              },
            ],
            homeDirs: [HOME],
          };
        },
        saveDiagnosticsBundle: async (bundle) => {
          saved.push(bundle);
          return { status: "saved", location: "~/Downloads/x.zip" };
        },
      },
    },
  });
  const { React, act, createRoot } = env;
  const { normalizeSettings } = env.loadModule("@liveagent/ui/lib/settings/index.ts");
  const { DiagnosticsExportDialog } = env.loadModule(
    "@liveagent/ui/components/diagnostics/DiagnosticsExportDialog.tsx",
  );
  const writes = [];
  const clipboard = { writeText: async (text) => void writes.push(text) };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        React.createElement(DiagnosticsExportDialog, {
          open: true,
          onOpenChange: () => {},
          settings: normalizeSettings({}),
          clipboard,
          now: undefined,
        }),
      ),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(collectCalls, 1);
    const files = [...host.querySelectorAll("[data-testid=diagnostics-file-list] li")].map(
      (item) => item.textContent,
    );
    assert.ok(files.some((text) => text.includes("summary.txt")));
    assert.ok(files.some((text) => text.includes("logs/k-brain.log")));
    const redactions = host.querySelector("[data-testid=diagnostics-redactions]").textContent;
    assert.match(redactions, /diagnostics\.redaction\.homePath/);
    assert.match(redactions, /diagnostics\.redaction\.secretAssignment/);

    await act(async () => host.querySelector("[data-testid=diagnostics-copy-summary]").click());
    assert.equal(writes.length, 1);
    assert.match(writes[0], /LiveAgent diagnostics summary/);
    assert.ok(!writes[0].includes("fixture-user"));
    assert.match(host.textContent, /diagnostics\.summaryCopied/);

    await act(async () => host.querySelector("[data-testid=diagnostics-save]").click());
    assert.equal(saved.length, 1);
    const log = saved[0].files.find((file) => file.path === "logs/k-brain.log").content;
    assert.ok(!log.includes("sk-fixture-provider-key"), log);
    assert.ok(!log.includes("fixture-user"), log);
    assert.match(host.textContent, /~\/Downloads\/x\.zip/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
});
