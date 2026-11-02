import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const enumSpec = (key, values) => ({ key, label: key, type: "string", required: false, enum: values });
const target = (parameters) => ({
  id: "t", name: "Provider · model", enabled: true, parameters,
  capabilities: { operations: ["generate"], maxCount: 1, maxInputs: 0 },
});
const openai = target([enumSpec("size", ["1024x1024", "1536x1024", "1024x1536"]), enumSpec("quality", ["low", "high"])]);
const google = target([enumSpec("aspectRatio", ["1:1", "16:9", "9:16"]), enumSpec("imageSize", ["1K", "2K"])]);

async function picker(props) {
  const env = await createDomTestEnv({ mocks: { "../../components/IconSet": new Proxy({}, { get: () => () => null }) } });
  const { ImageSizePicker, describeImageSize } = env.loadModule("@liveagent/ui/features/image-studio/ImageSizePicker");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const changes = [];
  await env.act(async () => root.render(env.React.createElement(ImageSizePicker, { onFramingChange: () => {}, ...props, onChange: (v) => changes.push(v) })));
  return { env, host, changes, describeImageSize, trigger: host.querySelector("button") };
}

test("footer summary follows the declared size contract", async () => {
  const { describeImageSize } = await picker({ target: openai, values: {} });
  assert.equal(describeImageSize(openai, { size: "1536x1024" }), "当前尺寸 1536x1024");
  assert.equal(describeImageSize(google, { aspectRatio: "16:9", imageSize: "2K" }), "比例 16:9 · 分辨率 2K");
  assert.equal(describeImageSize(target([]), {}), "尺寸由模型自动决定");
});

test("models without size parameters frame through the prompt with a generic ratio/resolution choice", async () => {
  const framings = [];
  const { env, trigger, describeImageSize } = await picker({
    target: target([]), values: {}, framing: { ratio: "16:9" }, onFramingChange: (f) => framings.push(f),
  });
  assert.equal(trigger.disabled, false);
  assert.match(trigger.textContent, /16:9/);
  await env.act(async () => trigger.click());
  const ratios = document.querySelector('[role="radiogroup"][aria-label="画面比例"]');
  assert.deepEqual([...ratios.querySelectorAll("label")].map((l) => l.textContent.trim()),
    ["自动", "21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"]);
  const tiers = document.querySelector('[role="radiogroup"][aria-label="分辨率"]');
  await env.act(async () => [...tiers.querySelectorAll("label")].find((l) => l.textContent.trim() === "2K").querySelector("input").click());
  assert.deepEqual(framings.at(-1), { ratio: "16:9", tier: "2K" });
  assert.match(document.body.textContent, /附加在提示词末尾/);
  assert.equal(describeImageSize(target([]), {}, { ratio: "16:9", tier: "2K" }), "比例 16:9 · 分辨率 2K · 约 2048x1152 · 写入提示词");
});

test("WxH sizes become wide-to-tall ratios; picking writes the exact size and auto clears it", async () => {
  const { env, trigger, changes } = await picker({ target: openai, values: { size: "1536x1024", quality: "high" } });
  assert.match(trigger.textContent, /3:2/);
  assert.match(trigger.textContent, /1\.5K/);
  await env.act(async () => trigger.click());
  const group = document.querySelector('[role="radiogroup"][aria-label="画面比例"]');
  assert.ok(group, "ratio grid renders when opened");
  assert.deepEqual([...group.querySelectorAll("label")].map((l) => l.textContent.trim()), ["自动", "3:2", "1:1", "2:3"]);
  const pick = async (label) => {
    const input = [...group.querySelectorAll("label")].find((l) => l.textContent.trim() === label).querySelector("input");
    await env.act(async () => input.click());
  };
  await pick("2:3");
  assert.deepEqual(changes.at(-1), { size: "1024x1536", quality: "high" });
  await pick("自动");
  assert.deepEqual(changes.at(-1), { quality: "high" }, "auto removes only the size key");
  assert.match(document.body.textContent, /更多参数/, "remaining parameters stay reachable");
});

test("auto and duplicate-ratio sizes stay in parameter mode with distinct choices", async () => {
  const sized = target([enumSpec("size", ["auto", "256x256", "1024x1024", "1536x1024"])]);
  const { env, trigger, changes, describeImageSize } = await picker({ target: sized, values: { size: "auto" } });
  assert.match(trigger.textContent, /自动比例/);
  assert.equal(describeImageSize(sized, { size: "auto" }), "尺寸由模型自动决定");
  await env.act(async () => trigger.click());
  const group = document.querySelector('[role="radiogroup"][aria-label="画面比例"]');
  const labels = [...group.querySelectorAll("label")].map((l) => l.textContent.trim());
  assert.deepEqual(labels, ["自动", "3:2", "1:1 256×256", "1:1 1024×1024"]);
  assert.doesNotMatch(document.body.textContent, /附加在提示词末尾/, "an auto size is still a size parameter");
  const pick = async (label) => {
    const input = [...group.querySelectorAll("label")].find((l) => l.textContent.trim() === label).querySelector("input");
    await env.act(async () => input.click());
  };
  await pick("1:1 256×256");
  assert.deepEqual(changes.at(-1), { size: "256x256" });
  const sizedPicker = await picker({ target: sized, values: { size: "1024x1024" } });
  await sizedPicker.env.act(async () => sizedPicker.trigger.click());
  const autoInput = [...document.querySelectorAll('[role="radiogroup"][aria-label="画面比例"]')].at(-1)
    .querySelector("label input");
  await sizedPicker.env.act(async () => autoInput.click());
  assert.deepEqual(sizedPicker.changes.at(-1), { size: "auto" }, "a declared auto is sent, not dropped");
});
