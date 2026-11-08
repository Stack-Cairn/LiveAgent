// Tool rows and collapsed tool-batch headers name their target in a short form:
// a command's first line, a file's name, a search pattern. The cut is measured in
// display columns (CJK counts two) and the full text stays in `full` for the
// tooltip and the expanded body.
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  CONCISE_TARGET_MAX_COLUMNS,
  conciseCommand,
  conciseUrl,
  displayColumns,
  truncateColumns,
  truncatePathStart,
} = loader.loadModule("../agent-ui/src/lib/chat/conciseText.ts");
const { getConciseToolTarget } = loader.loadModule(
  "../agent-ui/src/components/chat/assistant-bubble/conciseToolTarget.ts",
);

const tool = (name, args, extra = {}) => ({
  toolCall: { type: "toolCall", id: `${name}-1`, name, arguments: args },
  ...extra,
});

test("short targets pass through untouched", () => {
  assert.equal(truncateColumns("pnpm test"), "pnpm test");
  assert.equal(conciseCommand("pnpm test"), "pnpm test");
  assert.equal(truncatePathStart("src/App.tsx"), "src/App.tsx");
});

test("a long command keeps its head within the column budget and ends in an ellipsis", () => {
  const command = "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo $i; sleep 1; done";
  const concise = conciseCommand(command);
  assert.equal(concise, "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo $i…");
  assert.ok(displayColumns(concise) <= CONCISE_TARGET_MAX_COLUMNS);
});

test("a multi-line command shows its first line and marks that more follow", () => {
  assert.equal(conciseCommand("pnpm install\npnpm test\npnpm lint"), "pnpm install …");
  // Blank leading lines and a trailing line continuation are not the command.
  assert.equal(conciseCommand("\n\n  cargo test \\\n  --workspace"), "cargo test …");
});

test("a leading cd is context, the program after it is the target", () => {
  assert.equal(conciseCommand("cd /repo/crates/agent-gui && pnpm test"), "pnpm test");
  assert.equal(conciseCommand('cd "/path with spaces"; make'), "make");
  // A bare cd is the whole command and stays.
  assert.equal(conciseCommand("cd /repo"), "cd /repo");
});

test("CJK text is cut at the same visual width as Latin text", () => {
  const chinese = "echo 这是一个非常长的中文命令参数用于测试标题截断是否按照显示宽度计算";
  const concise = conciseCommand(chinese);
  assert.ok(concise.endsWith("…"));
  assert.ok(displayColumns(concise) <= CONCISE_TARGET_MAX_COLUMNS, concise);
  // Wide characters count as two columns, so fewer of them fit than Latin ones.
  assert.ok(Array.from(concise).length < CONCISE_TARGET_MAX_COLUMNS);
  assert.equal(displayColumns("中文"), 4);
  assert.equal(truncateColumns("中文中文中文", 7), "中文中…");
});

test("a long path keeps its tail, starting at a whole segment", () => {
  const path = "crates/agent-ui/src/components/chat/assistant-bubble/ToolTraceGroup.tsx";
  const concise = truncatePathStart(path);
  assert.ok(concise.startsWith("…/"), concise);
  assert.ok(concise.endsWith("/assistant-bubble/ToolTraceGroup.tsx"), concise);
  assert.ok(displayColumns(concise) <= CONCISE_TARGET_MAX_COLUMNS);
});

test("URLs drop their scheme and www prefix", () => {
  assert.equal(conciseUrl("https://www.example.com/docs/"), "example.com/docs");
  assert.ok(conciseUrl(`https://example.com/${"a".repeat(80)}`).endsWith("…"));
});

test("file tools name the file; the path stays in the tooltip", () => {
  const target = getConciseToolTarget(
    tool("Read", { path: "notes/very/deeply/nested/folder/structure/README-planning-notes.md" }),
  );
  assert.equal(target.text, "README-planning-notes.md");
  assert.equal(target.full, "notes/very/deeply/nested/folder/structure/README-planning-notes.md");
  assert.equal(target.lossy, false);
});

test("commands name their first line and flag what the short form leaves out", () => {
  const multiLine = getConciseToolTarget(
    tool("Bash", { command: "cd notes && wc -l README.md\necho done" }),
  );
  assert.equal(multiLine.text, "wc -l README.md …");
  assert.equal(multiLine.full, "cd notes && wc -l README.md\necho done");
  assert.equal(multiLine.lossy, true);

  const simple = getConciseToolTarget(tool("Bash", { command: "pnpm test" }));
  assert.deepEqual(simple, { text: "pnpm test", full: "pnpm test", lossy: false });
});

test("searches name the pattern, not key=value pairs", () => {
  const target = getConciseToolTarget(
    tool("Grep", { pattern: "TODO\\(release\\)|FIXME\\(release\\)|XXX\\(release\\)", path: "." }),
  );
  assert.equal(target.text, "TODO\\(release\\)|FIXME\\(release\\)|XXX\\(release\\)");
  assert.doesNotMatch(target.text, /pattern=|path=/);
  // The search path only lives in the full form, so the row shows it when expanded.
  assert.match(target.full, /path=\./);
  assert.equal(target.lossy, true);
});

test("host bridge tools name the terminal or the tunnel target, not key=value pairs", () => {
  assert.deepEqual(getConciseToolTarget(tool("ReadTerminal", { terminal_id: "term-2", max_bytes: 4096 })), {
    text: "term-2",
    full: "term-2",
    lossy: false,
  });
  // No terminal picked: the verb ("Read terminal") is the whole title.
  assert.equal(getConciseToolTarget(tool("ReadTerminal", { max_bytes: 4096 })).text, "");
  const created = getConciseToolTarget(
    tool("TunnelManager", { action: "create", targetUrl: "https://localhost:5173/app?x=1", ttlSeconds: 900 }),
  );
  assert.equal(created.text, "localhost:5173/app?x=1");
  assert.doesNotMatch(created.text, /action=|ttlSeconds/);
  assert.equal(getConciseToolTarget(tool("TunnelManager", { action: "close", id: "tun-1" })).text, "tun-1");
  assert.equal(getConciseToolTarget(tool("TunnelManager", { action: "list" })).text, "");
});
