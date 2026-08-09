async (page) => {
  const targets = [
    ["GUI", "http://127.0.0.1:1431/test/browser/paste-newline-pipeline.html"],
    ["WebUI", "http://127.0.0.1:1432/test/browser/paste-newline-pipeline.html"],
  ];
  const cases = [
    ["LF no blank line", "alpha\nbeta", ""],
    ["LF one blank line", "alpha\n\nbeta", "<p>ignored rich text</p>"],
    ["CRLF one blank line", "alpha\r\n\r\nbeta", "<p>ignored rich text</p>"],
    ["CR one blank line", "alpha\r\rbeta", ""],
    ["multiple blank lines", "alpha\n\n\nbeta", ""],
    ["leading newline", "\nalpha", ""],
    ["trailing newline", "alpha\n", ""],
    ["leading and trailing", "\nalpha\n", ""],
    ["pure whitespace", " \n\n ", ""],
    ["Markdown paragraphs", "first paragraph\n\nsecond paragraph", ""],
    ["Markdown list", "- one\n- two", ""],
    ["Markdown quote", "> quote\n> continued", ""],
    ["Markdown code block", "```ts\nconst value = 1;\n```", ""],
    ["Markdown table", "| a | b |\n| - | - |\n| 1 | 2 |", ""],
    ["Markdown link", "[OpenAI](https://openai.com)\nnext", ""],
    ["HTML-like plaintext", "<tag>& value\n\nnext", "<strong>must be ignored</strong>"],
    ["Unicode and emoji", "你好🙂\n\nκαλημέρα", ""],
    ["long text", `${"x".repeat(20_000)}\n\n${"y".repeat(20_000)}`, ""],
  ];

  function expectEqual(actual, expected, label) {
    if (actual !== expected) {
      throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  async function openTarget(url) {
    await page.goto(url);
    await page.waitForFunction(() => window.pipelineReady === true);
  }

  async function typeManualText(value) {
    await page.evaluate(() => window.resetEditor());
    const normalized = value.replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]) await page.keyboard.insertText(lines[index]);
      if (index < lines.length - 1) await page.keyboard.press("Shift+Enter");
    }
    return await page.evaluate((raw) => window.snapshotManualPipeline(raw), value);
  }

  const evidence = {};
  for (const [targetName, url] of targets) {
    await openTarget(url);
    const targetEvidence = [];
    for (const [caseName, input, html] of cases) {
      const expected = input.replace(/\r\n?/g, "\n");
      const sendable = expected.trim().length > 0;
      const result = await page.evaluate(
        ([plain, rich]) => window.runPastePipeline(plain, rich),
        [input, html],
      );
      expectEqual(JSON.parse(result.composer), expected, `${targetName}/${caseName}/composer`);
      expectEqual(JSON.parse(result.outbound), expected, `${targetName}/${caseName}/outbound`);
      expectEqual(result.sendable, sendable, `${targetName}/${caseName}/sendable`);
      expectEqual(result.whiteSpace, "pre-wrap", `${targetName}/${caseName}/white-space`);
      if (sendable) {
        expectEqual(JSON.parse(result.history), expected, `${targetName}/${caseName}/history`);
        expectEqual(JSON.parse(result.bubbleText), expected, `${targetName}/${caseName}/bubble`);
      } else {
        expectEqual(result.history, null, `${targetName}/${caseName}/history`);
        expectEqual(JSON.parse(result.bubbleText), "", `${targetName}/${caseName}/bubble`);
      }
      if (caseName === "LF one blank line") {
        expectEqual(result.htmlPresent, true, `${targetName}/${caseName}/rich clipboard`);
        expectEqual(result.visualLineCount, 3, `${targetName}/${caseName}/visual lines`);

        const manual = await typeManualText(input);
        expectEqual(manual.composer, result.composer, `${targetName}/${caseName}/manual composer`);
        expectEqual(manual.outbound, result.outbound, `${targetName}/${caseName}/manual outbound`);
        expectEqual(manual.bubbleText, result.bubbleText, `${targetName}/${caseName}/manual bubble`);

        await page.evaluate(([plain, rich]) => window.runPastePipeline(plain, rich), [input, html]);
        expectEqual(await page.evaluate(() => document.execCommand("undo")), true, `${targetName}/undo`);
        expectEqual(await page.locator("#editor").textContent(), "", `${targetName}/undo editor`);
        expectEqual(await page.evaluate(() => document.execCommand("redo")), true, `${targetName}/redo`);
        const redo = await page.evaluate((raw) => window.snapshotManualPipeline(raw), input);
        expectEqual(JSON.parse(redo.composer), expected, `${targetName}/redo composer`);
      }
      if (caseName === "trailing newline") {
        expectEqual(result.visualLineCount, 2, `${targetName}/${caseName}/visual lines`);
      }
      if (caseName === "leading and trailing") {
        expectEqual(result.visualLineCount, 3, `${targetName}/${caseName}/visual lines`);
      }
      targetEvidence.push(
        caseName === "long text"
          ? {
              caseName,
              composerLength: JSON.parse(result.composer).length,
              outboundLength: JSON.parse(result.outbound).length,
              bubbleLength: JSON.parse(result.bubbleText).length,
              newlineCounts: result.newlineCounts,
              whiteSpace: result.whiteSpace,
            }
          : { caseName, ...result },
      );
    }

    const replayText = "reload\n\nreconnect";
    const beforeReload = await page.evaluate((text) => window.runPastePipeline(text), replayText);
    await page.reload();
    await page.waitForFunction(() => window.pipelineReady === true);
    const afterReload = await page.evaluate(
      (content) => window.renderReplay(content),
      JSON.parse(beforeReload.history),
    );
    expectEqual(afterReload.text, replayText, `${targetName}/reload replay`);
    const afterReconnect = await page.evaluate(
      (content) => window.renderReplay(content),
      JSON.parse(beforeReload.history),
    );
    expectEqual(afterReconnect.text, replayText, `${targetName}/reconnect replay`);
    evidence[targetName] = targetEvidence;
  }

  const crossText = "desktop to web\n\nweb to desktop";
  await openTarget(targets[0][1]);
  const guiMessage = await page.evaluate((text) => window.runPastePipeline(text), crossText);
  await openTarget(targets[1][1]);
  const webReplay = await page.evaluate(
    (content) => window.renderReplay(content),
    JSON.parse(guiMessage.history),
  );
  expectEqual(webReplay.text, crossText, "GUI -> WebUI replay");

  const webMessage = await page.evaluate((text) => window.runPastePipeline(text), crossText);
  await openTarget(targets[0][1]);
  const guiReplay = await page.evaluate(
    (content) => window.renderReplay(content),
    JSON.parse(webMessage.history),
  );
  expectEqual(guiReplay.text, crossText, "WebUI -> GUI replay");

  return evidence;
}
