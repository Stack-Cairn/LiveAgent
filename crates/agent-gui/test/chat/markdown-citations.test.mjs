import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as streamdown from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  mocks: {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    streamdown,
    "@streamdown/cjk": { cjk },
    "@streamdown/math": { math },
    "../lib/markdownCodeHighlight": { throttledCodePlugin: code },
    "@liveagent/ui/components/IconSet": {},
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    "./markdown/MarkdownMermaidBlock": { MarkdownMermaidBlock: () => null },
    "./ui/button": { Button: "button" },
    "./ui/checkbox": { Checkbox: "input" },
    "./ui/copy-button": { CopyButton: () => null },
    "./ui/dialog": {},
  },
});
const { Markdown } = loader.loadModule("@liveagent/ui/components/Markdown.tsx");
const { stripMarkdownCitationMarkers } = loader.loadModule("@liveagent/ui/lib/markdownCitations.ts");
const { advanceBoundary, createSplitState } = loader.loadModule("@liveagent/ui/lib/chat/streamingSplit.ts");
const { StreamingSplitMarkdown } = loader.loadModule("@liveagent/ui/components/chat/StreamingSplitMarkdown.tsx");

const citation = "\uE200cite\uE202turn442022search6\uE201";
const multiCitation = "\uE200cite\uE202turn0search0\uE202turn1view2\uE201";

function render(content, renderMode = "static") {
  return renderToStaticMarkup(
    React.createElement(Markdown, {
      content,
      renderMode,
      showCaret: renderMode === "streaming",
      componentOverrides: {
        a: ({ href, children }) => React.createElement("a", { href }, children),
        pre: ({ children }) => React.createElement("pre", null, children),
      },
    }),
  ).replace(/ class="[^"]*"/g, "");
}

for (const mode of ["static", "streaming"]) {
  test(`${mode} chat hides raw provider citations while retaining the surrounding answer`, () => {
    const html = render(`这句不是乱传的。${citation} 这是后续正文。${multiCitation}`, mode);
    assert.doesNotMatch(html, /[\uE200-\uE202]|turn442022search6|turn0search0|turn1view2/);
    assert.match(html, /这句不是乱传的。 这是后续正文。/);
  });

  test(`${mode} chat hides every unfinished citation prefix`, () => {
    for (let length = 1; length <= citation.length; length += 1) {
      const html = render(`正文。${citation.slice(0, length)}`, mode);
      assert.doesNotMatch(html, /[\uE200-\uE202]|cite|turn442022search6/, `prefix ${length}`);
      assert.match(html, /正文。/);
    }
    assert.match(render(`正文。${citation}后续文字。`, mode), /正文。后续文字。/);
  });

  test(`${mode} chat matches citations across formatting, line breaks and streaming blocks`, () => {
    for (const separator of ["\n", "\n\n", "**", "<em></em>"]) {
      const html = render(`before \uE200cite\uE202turn0search0${separator}turn1search1\uE201 after`, mode);
      assert.doesNotMatch(html, /[\uE200-\uE202]|turn0search0|turn1search1/);
      assert.match(html, /before /);
      assert.match(html, / after/);
    }
    for (const content of ["before \uE200**other**\uE201 after", "before \uE200\n\nother after"]) {
      assert.match(render(content, mode), /\uE200/);
      assert.match(render(content, mode), /other/);
    }
  });

  test(`${mode} chat preserves code next to incomplete citation-like text`, () => {
    for (const content of [
      "before \uE200ci`code`",
      "before \uE200cite\uE202id`code`tail\uE201 after",
      "before \uE200ci![image](https://example.com/image.png)",
      "before \uE200ci[](https://example.com/\uE201)\n\nother",
    ]) {
      assert.match(render(content, mode), /\uE200/);
    }
    const html = render("before \uE200 `code` after", mode);
    assert.match(html, /before \uE200 /);
    assert.match(html, />code<\/code>/);
    assert.match(html, / after/);
  });

  test(`${mode} chat preserves citation examples in code and ordinary source links`, () => {
    const html = render(
      `正文${citation}\n\n行内 \`${citation}\`\n\n\`\`\`text\n${citation}\n\`\`\`\n\n<code>${citation}</code>\n\n[来源](https://example.com/source)`,
      mode,
    );
    assert.equal(html.split(citation).length - 1, 3, html);
    assert.match(html, /<a href="https:\/\/example.com\/source">来源<\/a>/);
  });
}

test("citation filtering preserves English, Unicode, unrelated private-use characters and Markdown", () => {
  const html = render("v cite turn123search0 — 中文 café Ω 😀 \uE000 \uE200other\uE201 **bold**");
  assert.match(html, /v cite turn123search0 — 中文 café Ω 😀 \uE000 \uE200other\uE201/);
  assert.match(html, /data-streamdown="strong">bold<\/span>/);
});

test("code, HTML attributes and link targets remain unchanged without shielding later citations", () => {
  for (const sample of [
    `    ${citation}\n`,
    `\`\`\`html\n<code>\n${citation}\n\`\`\`\n`,
    `<pre>${citation}</pre>`,
    `<span title="${citation}">label</span>`,
    `[source](https://example.com/${citation})`,
  ]) {
    assert.equal(stripMarkdownCitationMarkers(`${sample}\n\nanswer${citation}`), `${sample}\n\nanswer`);
  }
  assert.equal(stripMarkdownCitationMarkers(`<p>answer${citation}</p>`), "<p>answer</p>");
  assert.equal(stripMarkdownCitationMarkers("before \uE200ci", false), "before \uE200ci");
});

test("long streaming messages never freeze a boundary inside a citation", () => {
  const prefix = "paragraph text ".repeat(560);
  const content = `${prefix}\uE200cite\uE202turn0search0\n\nturn1search1\uE201 after ${"tail ".repeat(500)}`;
  const state = createSplitState();
  advanceBoundary(state, content);
  for (const segment of state.segments) {
    assert.ok(!segment.includes("\uE200") || segment.includes("\uE201"));
  }
  const html = renderToStaticMarkup(React.createElement(StreamingSplitMarkdown, { content }));
  assert.doesNotMatch(html, /[\uE200-\uE202]|turn0search0|turn1search1/);
  assert.match(html, / after /);
});

test("protected unfinished markers do not consume later prose citations or prevent freezing", () => {
  const prefix = "\uE200cite\uE202";
  for (const sample of [`\`${prefix}\``, `<span title="${prefix}">label</span>`, `[source](https://example.com/${prefix})`]) {
    assert.equal(stripMarkdownCitationMarkers(`${sample} answer${citation}`), `${sample} answer`);
  }
  const content = `\`${prefix}\`\n\n${"ordinary paragraph text.\n\n".repeat(5000)}`;
  const state = createSplitState();
  advanceBoundary(state, content);
  assert.ok(state.boundary > 0);
  assert.ok(content.length - state.boundary < 16000);
});

for (const mode of ["static", "streaming"]) {
  test(`${mode} chat filters citations in HTML tables and normalized HTML indentation`, () => {
    for (const content of [`<table><tr><td>answer${citation}</td></tr></table>`, `    <p>answer${citation}</p>`]) {
      const html = render(content, mode);
      assert.doesNotMatch(html, /[\uE200-\uE202]/);
      assert.match(html, /answer/);
    }
    const table = `| a | b |\n| - | - |\n| \`x | ${citation} |\n| y\` | z |`;
    assert.doesNotMatch(render(table, mode), /[\uE200-\uE202]/);
  });
}

test("escaped HTML stays prose and cannot protect later citations", () => {
  const content = `\\<code>example ${citation}\n\nanswer${citation}`;
  for (const mode of ["static", "streaming"]) {
    assert.doesNotMatch(render(content, mode), /[\uE200-\uE202]/);
  }
});

test("streaming incomplete inline code retains literal citation examples", () => {
  const html = render(`inline: \`${citation}`, "streaming");
  assert.match(html, /<code[^>]*>\uE200cite\uE202turn442022search6\uE201<\/code>/);
});

test("citation filtering preserves source-position-based file link rewriting", () => {
  const html = renderToStaticMarkup(
    React.createElement(Markdown, {
      content: `正文${citation} [文件](C:/path with spaces/a.ts)`,
      onOpenFileLink: () => {},
    }),
  );
  assert.doesNotMatch(html, /[\uE200-\uE202]|turn442022search6/);
  assert.match(html, /data-liveagent-file-link="true"/);
  assert.match(html, />文件<\/button>/);
});
