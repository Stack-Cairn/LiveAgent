import { assertJsxDimensions } from "../helpers/style-dimensions.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const roundContentSource = fs.readFileSync(
  new URL(
    "../../../agent-ui/src/components/chat/assistant-bubble/RoundContent.tsx",
    import.meta.url,
  ),
  "utf8",
);
const hostedSearchSource = fs.readFileSync(
  new URL("../../../agent-ui/src/components/chat/HostedSearchGroupView.tsx", import.meta.url),
  "utf8",
);
const workTraceSource = fs.readFileSync(
  new URL("../../../agent-ui/src/components/chat/AssistantWorkTrace.tsx", import.meta.url),
  "utf8",
);
const toolTraceSource = fs.readFileSync(
  new URL(
    "../../../agent-ui/src/components/chat/assistant-bubble/ToolTraceGroup.tsx",
    import.meta.url,
  ),
  "utf8",
);
const toolCallSource = fs.readFileSync(
  new URL(
    "../../../agent-ui/src/components/chat/assistant-bubble/ToolCallItem.tsx",
    import.meta.url,
  ),
  "utf8",
);
const markdownSource = fs.readFileSync(
  new URL("../../../agent-ui/src/components/Markdown.tsx", import.meta.url),
  "utf8",
);
const markdownStylesSource = fs.readFileSync(
  new URL("../../../agent-ui/src/components/markdown/markdownStyles.ts", import.meta.url),
  "utf8",
);

test("tool and operation blocks share the same compact rhythm as prose", () => {
  assert.match(roundContentSource, /const isOperationBlock = block\.kind !== "text";/);
  // 行距已收归工作轨迹容器（AssistantWorkTrace 的 space-y-2）：此前由
  // RoundContent 的 my-1 加上各行自带的 pb-1 拼出，四种行类型凑出的间隙
  // 并不相等。包装层现在不再贡献任何外边距。
  assert.doesNotMatch(roundContentSource, /my-1/);
  assert.doesNotMatch(roundContentSource, /standalone/);
  assert.match(roundContentSource, /data-assistant-operation=\{isOperationBlock \? "" : undefined\}/);
});

test("operation components defer outer spacing to the shared block wrapper", () => {
  assert.doesNotMatch(hostedSearchSource, /className="[^"]*\bmy-/);
});

test("chat typography keeps body copy substantial and emphasis at weight 500", () => {
  assert.match(markdownStylesSource, /font-\[450\]/);
  assert.match(markdownStylesSource, /\[&_p\]:font-\[450\]/);
  assert.match(markdownStylesSource, /\[&_strong\]:font-medium/);
  assert.match(markdownSource, /CHAT_MARKDOWN_CLASS/);
});

test("inline code uses the higher-contrast transcript treatment", () => {
  assert.match(markdownStylesSource, /bg-foreground\/\[0\.085\]/);
  assert.match(markdownStylesSource, /rounded-xs/);
});

test("operation rows use compact icons and reveal disclosure chevrons on intent", () => {
  assertJsxDimensions(hostedSearchSource, "Globe", { width: "3", height: "3" });
  assertJsxDimensions(toolTraceSource, "BatchIcon", { width: "3", height: "3" });
  assertJsxDimensions(toolCallSource, "ToolIcon", { width: "3", height: "3" });

  assert.match(workTraceSource, /opacity-0[^"\n]*group-hover\/work-trace:opacity-100/);
  assert.match(hostedSearchSource, /opacity-0[^"\n]*group-hover\/search-trace:opacity-100/);
  assert.match(toolTraceSource, /opacity-0[^"\n]*group-hover\/tool-trace:opacity-100/);
  assert.match(toolCallSource, /opacity-0[^"\n]*group-hover\/tool:opacity-100/);
});
