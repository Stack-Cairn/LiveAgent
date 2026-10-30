import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// DOM behavior only: jsdom cannot verify CSS layout, viewport behavior or image decode.
// Page, Composer, Gallery, AssetImage, useImageStudio and controller are real modules.
const target = (id = "model-edit", operations = ["generate", "edit"]) => ({
  id, name: id === "model-edit" ? "Studio Model" : id, enabled: true, parameters: [],
  capabilities: { operations, maxCount: 4, maxInputs: 3, supportsCancel: true },
});
const project = (id) => ({ id, title: id, revision: 1 });
const job = (id, overrides = {}) => ({
  id, projectId: "archive", revision: 1, lastEventSeq: 0, status: "succeeded",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  request: { projectId: "archive", targetId: "model-edit", prompt: `Prompt ${id}`,
    operation: "generate", count: 1, parameters: {}, inputs: [] },
  targetSnapshot: target(), assetIds: [], items: [], usage: null, ...overrides,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

async function mounted(run, options = {}) {
  const env = await createDomTestEnv({ mocks: {
    // The source loader's unplugin icon factory returns plain objects, not React elements.
    "../../components/IconSet": new Proxy({}, { get: () => () => null }),
    "../../components/AppErrorBoundary": { AppErrorBoundary: ({ children }) => children },
    // The Base UI listbox portal cannot be driven through jsdom; a native select keeps the
    // composer's selection contract (value, placeholder, disabled targets) observable.
    // The real viewer is lazy-loaded chat UI; a marker records what the preview hands it.
    "./AssetLightbox": { AssetLightbox: ({ open, assetIds, index, onClose }) => open
      ? env.React.createElement("div", { "aria-label": "大图查看器", "data-ids": assetIds.join(","), "data-index": String(index) },
        env.React.createElement("button", { type: "button", onClick: onClose }, "关闭大图"))
      : null },
    "./ImageModelPicker": { ImageModelPicker: ({ id, targets, value, onChange }) => {
      const h = env.React.createElement;
      return h("select", { id, value, onChange: (event) => onChange(event.target.value) },
        h("option", { value: "" }, targets.length ? "选择图像模型" : "暂无可用图像模型"),
        ...targets.map((item) => h("option", { key: item.id, value: item.id, disabled: !item.enabled }, item.name)));
    } },
  } });
  const calls = { creates: [], uploads: [], reads: [], cancels: [], exports: [], projects: [], lists: [] };
  const jobs = options.jobs ?? [];
  const client = {
    capabilities: async () => ({ supported: true }),
    listTargets: async () => options.targets ?? [target()],
    listProjects: async () => ({ items: options.projects ?? [project("archive")] }),
    createProject: async (title) => { calls.projects.push(title); return project("archive"); },
    listJobs: async (id, cursor) => { calls.lists.push({ id, cursor }); return { items: jobs.filter(j => j.projectId === id) }; },
    getJob: async (id) => jobs.find(j => j.id === id),
    subscribe: async () => {},
    readAsset: async (id, variant, signal) => {
      calls.reads.push({ id, variant, signal });
      return new Blob(["synthetic image"], { type: "image/png" });
    },
    upload: async (file, name, signal) => {
      calls.uploads.push({ file, name, signal });
      return { id: `ia_upload_${calls.uploads.length}`, available: true };
    },
    createJob: async (request, key) => {
      calls.creates.push({ request: structuredClone(request), key });
      return job(`new-${calls.creates.length}`, { request, status: "running" });
    },
    cancelJob: async (id) => {
      calls.cancels.push(id);
      return { ...jobs.find(j => j.id === id), status: "cancelled", revision: 2 };
    },
    exportAsset: async (id, destination) => { calls.exports.push({ id, destination }); return { saved: true }; },
  };
  Object.assign(client, options.client?.(calls, client));
  const { ImageStudioPage } = env.loadModule("@liveagent/ui/features/image-studio/ImageStudioPage");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const byLabel = (label, scope = host) => {
    const element = [...scope.querySelectorAll("[aria-label]")].find(e => e.getAttribute("aria-label") === label)
      ?? [...scope.querySelectorAll("label")].find(e => e.textContent.trim() === label)?.control;
    assert.ok(element, `Missing control: ${label}`);
    return element;
  };
  const button = (text, scope = host) => {
    const element = [...scope.querySelectorAll("button")].find(e => e.textContent.trim() === text);
    assert.ok(element, `Missing button: ${text}`);
    return element;
  };
  // The primary action reads 生成 in text mode and 编辑 in image mode.
  const submit = () => {
    const element = host.querySelector('form[aria-label="图像创作"] button[type="submit"]');
    assert.ok(element, "Missing submit button");
    return element;
  };
  const click = async (element) => {
    assert.ok(!element.matches(":disabled"), `Disabled: ${element.textContent || element.getAttribute("aria-label")}`);
    await env.act(async () => element.click());
  };
  const change = async (element, value) => {
    const prototype = element.tagName === "TEXTAREA" ? env.dom.window.HTMLTextAreaElement.prototype
      : element.tagName === "SELECT" ? env.dom.window.HTMLSelectElement.prototype : env.dom.window.HTMLInputElement.prototype;
    await env.act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
  };
  const importFile = async (kind, file) => {
    const form = byLabel("图像创作");
    const event = new Event(kind === "upload" ? "change" : kind, { bubbles: true, cancelable: true });
    if (kind === "upload") {
      const input = byLabel("选择输入图片");
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      await env.act(async () => input.dispatchEvent(event));
    } else {
      Object.defineProperty(event, kind === "drop" ? "dataTransfer" : "clipboardData", { value: kind === "drop"
        ? { files: [file] } : { items: [{ kind: "string", type: "text/plain" }, { kind: "file", type: file.type, getAsFile: () => file }] } });
      await env.act(async () => form.dispatchEvent(event));
    }
    return event;
  };
  const storageData = new Map();
  const storage = { getItem: key => storageData.get(key) ?? null, setItem: (key, value) => storageData.set(key, value), removeItem: key => storageData.delete(key) };
  try {
    await env.act(async () => root.render(env.React.createElement(ImageStudioPage, {
      client, ownerId: "owner", backendId: "backend", storage, exportDestinations: ["download"],
      onOpenSettings: options.onOpenSettings,
    })));
    await run({ env, host, client, calls, byLabel, button, submit, click, change, importFile, storageData });
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
}

test("upload button opens the file chooser and imports a reference through the real control", async () => {
  await mounted(async ({ env, calls, byLabel, button, click, importFile, submit }) => {
    const input = byLabel("选择输入图片");
    let chooserOpened = 0;
    input.addEventListener("click", () => { chooserOpened++; });
    await click(byLabel("上传参考图片"));
    assert.equal(chooserOpened, 1);
    await importFile("upload", new env.dom.window.File(["image"], "reference.png", { type: "image/png" }));
    assert.equal(calls.uploads.length, 1);
    assert.equal(button("图生图").getAttribute("aria-pressed"), "true");
    await click(button("文生图"));
    await click(button("图生图"));
    assert.equal(button("图生图").getAttribute("aria-pressed"), "true");
  });
});

test("prompt validation retains its status slot when editing and export feedback does not replace preview", async () => {
  await mounted(async ({ host, byLabel, button, click, change, submit }) => {
    const prompt = byLabel("提示词");
    const validation = byLabel("图像创作").querySelector('[aria-live="polite"]');
    const preview = byLabel("图片预览");
    assert.match(validation.textContent, /请输入提示词/);
    await change(prompt, "A prompt");
    assert.equal(byLabel("图像创作").querySelector('[aria-live="polite"]'), validation);
    assert.equal(validation.textContent.trim(), "");
    await change(prompt, "");
    assert.equal(byLabel("图像创作").querySelector('[aria-live="polite"]'), validation);
    await click(button("下载图片"));
    assert.match(host.textContent, /图片已保存/);
    assert.equal(byLabel("图片预览"), preview);
  }, { jobs: [job("preview", { assetIds: ["ia_preview"] })] });
});

test("workbench exposes preview, composer and history without project, version, target-settings or video controls", async () => {
  await mounted(async ({ host, calls, byLabel, button, click, submit }) => {
    assert.equal(host.querySelector("h1").textContent, "视觉创作");
    for (const label of ["图片预览", "图像创作", "历史记录", "搜索历史记录", "筛选历史记录"]) byLabel(label);
    assert.match(byLabel("图片预览").textContent, /图 1 会显示在这里/);
    assert.doesNotMatch(host.textContent, /新建项目|新项目名称|管理当前项目|重命名|删除项目|版本树|版本对比|目标设置|视频/);
    assert.equal(host.querySelectorAll('input[placeholder="新项目名称"]').length, 0);
    assert.equal(byLabel("图像模型").value, "model-edit");
    assert.equal(submit().disabled, true);
    assert.match(host.textContent, /请输入提示词/);
    assert.deepEqual(calls.projects, ["图像工作台"], "empty backend initializes its archive automatically");
    const toggle = button("历史记录");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    await click(toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    // This checks toggle state only; hidden/lg:flex CSS needs a real browser.
  }, { projects: [] });
});

test("history searches prompt/model, filters status and changes original preview independently of composer", async () => {
  const older = job("older", { assetIds: ["ia_old"], targetSnapshot: { ...target(), name: "Watercolor" } });
  const newer = job("newer", { createdAt: "2026-02-01T00:00:00Z", assetIds: ["ia_new", "ia_new"] });
  const active = job("active", { status: "running" });
  // parseImageError rebuilds message from the code, so the UI shows the localized code text.
  const failed = job("failed", { status: "failed", error: { code: "IMAGE_INVALID_INPUT", message: "Invalid image input" } });
  await mounted(async ({ host, calls, byLabel, button, click, change, submit }) => {
    const gallery = byLabel("图像结果画廊");
    assert.deepEqual([...gallery.querySelectorAll("article")].map(e => e.getAttribute("aria-label")), ["任务 newer", "任务 older", "任务 active", "任务 failed"]);
    assert.equal(byLabel("图片预览").querySelector("img").alt, "Prompt newer");
    assert.ok(calls.reads.some(r => r.id === "ia_new" && r.variant === "original"));
    assert.equal(byLabel("图片预览").querySelectorAll('button[aria-label^="选择结果"]').length, 0, "deduplicated single result needs no strip");
    assert.equal(byLabel("查看任务：Prompt newer").getAttribute("aria-pressed"), "true", "newest result is the default preview");
    await change(byLabel("提示词"), "Unsaved prompt");
    await change(byLabel("搜索历史记录"), "  WATERCOLOR  ");
    assert.equal(gallery.querySelectorAll("article").length, 1);
    await click(button("历史记录"));
    await click(byLabel("查看任务：Prompt older"));
    assert.equal(button("历史记录").getAttribute("aria-expanded"), "false");
    assert.equal(byLabel("图片预览").querySelector("img").alt, "Prompt older");
    assert.ok(calls.reads.some(r => r.id === "ia_old" && r.variant === "original"));
    assert.equal(byLabel("提示词").value, "Unsaved prompt");
    assert.equal(byLabel("查看任务：Prompt older").getAttribute("aria-pressed"), "true");
    await click(button("下载图片"));
    assert.deepEqual(calls.exports, [{ id: "ia_old", destination: "download" }]);
    await change(byLabel("搜索历史记录"), "Prompt active");
    assert.equal(gallery.querySelector("article").getAttribute("aria-label"), "任务 active");
    await change(byLabel("搜索历史记录"), "");
    for (const [label, ids] of [["进行中", ["任务 active"]], ["有结果", ["任务 newer", "任务 older"]], ["需关注", ["任务 failed"]]]) {
      await click(button(label, byLabel("筛选历史记录")));
      assert.equal(button(label, byLabel("筛选历史记录")).getAttribute("aria-pressed"), "true");
      assert.deepEqual([...gallery.querySelectorAll("article")].map(e => e.getAttribute("aria-label")), ids);
    }
    await change(byLabel("搜索历史记录"), "no such prompt");
    assert.match(gallery.textContent, /没有匹配的历史记录/);
    await change(byLabel("搜索历史记录"), "");
    await click(button("全部", byLabel("筛选历史记录")));
    assert.equal(gallery.querySelectorAll("article").length, 4);
    await click(byLabel("查看任务：Prompt failed"));
    assert.equal(byLabel("图片预览").querySelector("img"), null, "a failed job never falls back to another job's image");
    assert.match(byLabel("图片预览").textContent, /这次没有生成图片/);
    assert.equal(byLabel("图片预览").textContent.split("图像输入无效").length - 1, 1);
  }, { jobs: [older, newer, active, failed] });
});

test("history restores prompt, model, operation, count and verified inputs across archives through real controls", async () => {
  const historical = job("historical", { projectId: "old-archive", assetIds: ["ia_result"], request: {
    projectId: "old-archive", targetId: "reference-model", prompt: "Historical portrait", operation: "reference",
    count: 2, parameters: {}, inputs: [{ assetId: "ia_source", role: "reference" }],
  } });
  await mounted(async ({ calls, byLabel, button, click, change, submit }) => {
    await change(byLabel("搜索历史记录"), "Historical");
    await click(button("恢复输入", byLabel("任务 historical")));
    assert.equal(byLabel("提示词").value, "Historical portrait");
    assert.equal(byLabel("图像模型").value, "reference-model");
    assert.equal(byLabel("生成数量").value, "2");
    assert.equal(button("图生图").getAttribute("aria-pressed"), "true");
    assert.equal(byLabel("输入图片").querySelector("img").alt, "参考图片 1");
    assert.ok(calls.reads.some(r => r.id === "ia_source" && r.variant === "thumbnail"));
    await click(submit());
    assert.deepEqual(calls.creates[0].request, historical.request);
  }, { projects: [project("archive"), project("old-archive")], jobs: [historical], targets: [target(), target("reference-model", ["generate", "reference"])] });
});

for (const kind of ["upload", "drop", "paste"]) {
  test(`${kind} imports the actual File, switches to image mode and submits its source asset`, async () => {
    await mounted(async ({ env, host, calls, byLabel, button, click, change, importFile, submit }) => {
      const file = new env.dom.window.File(["PNG fixture bytes"], `${kind}.png`, { type: "image/png" });
      await change(byLabel("提示词"), `Process ${kind}`);
      const event = await importFile(kind, file);
      assert.equal(calls.uploads.length, 1);
      assert.equal(calls.uploads[0].file, file);
      assert.equal(calls.uploads[0].name, `${kind}.png`);
      assert.equal(calls.uploads[0].signal.aborted, false);
      if (kind !== "upload") assert.equal(event.defaultPrevented, true);
      else assert.equal(byLabel("选择输入图片").value, "");
      assert.equal(button("图生图").getAttribute("aria-pressed"), "true");
      assert.match(byLabel("输入图片").textContent, /原图/);
      assert.equal(submit().textContent.trim(), "编辑", "image mode labels the action as an edit");
      await click(submit());
      assert.equal(calls.creates[0].request.prompt, `Process ${kind}`);
      assert.equal(calls.creates[0].request.operation, "edit");
      assert.deepEqual(calls.creates[0].request.inputs, [{ assetId: "ia_upload_1", role: "source" }]);
      await click(byLabel("移除图片 1"));
      assert.equal(host.querySelector('[aria-label="输入图片"]'), null);
      await click(button("文生图"));
      assert.equal(button("文生图").getAttribute("aria-pressed"), "true");
      assert.equal(byLabel("提示词").value, `Process ${kind}`);
    });
  });
}

for (const kind of ["upload", "drop", "paste"]) {
  test(`${kind} preserves a restored reference operation on a model supporting both edit and reference`, async () => {
    const dualModel = target("dual-model", ["generate", "edit", "reference"]);
    const historical = job("reference-history", {
      targetSnapshot: dualModel,
      assetIds: ["ia_reference_result"],
      request: {
        projectId: "archive", targetId: dualModel.id, prompt: "Restored reference portrait",
        operation: "reference", count: 2, parameters: {},
        inputs: [{ assetId: "ia_existing_reference", role: "reference" }],
      },
    });
    await mounted(async ({ env, calls, byLabel, button, click, importFile, submit }) => {
      await click(button("恢复输入", byLabel("任务 reference-history")));
      assert.equal(byLabel("图像模型").value, dualModel.id);
      assert.equal(button("图生图").getAttribute("aria-pressed"), "true");
      assert.equal(byLabel("输入图片").querySelectorAll("img").length, 1);
      const file = new env.dom.window.File(["reference fixture"], `${kind}-reference.png`, { type: "image/png" });
      const event = await importFile(kind, file);
      assert.equal(calls.uploads.length, 1);
      assert.equal(calls.uploads[0].file, file);
      assert.equal(calls.uploads[0].name, file.name);
      if (kind !== "upload") assert.equal(event.defaultPrevented, true);
      assert.equal(byLabel("提示词").value, historical.request.prompt);
      assert.equal(byLabel("生成数量").value, "2");
      assert.equal(byLabel("输入图片").querySelectorAll("img").length, 2, "import retains the restored reference input");
      assert.equal(calls.creates.length, 0, "restoring and importing never submit automatically");
      await click(submit());
      assert.equal(calls.creates.length, 1);
      assert.deepEqual(calls.creates[0].request, {
        ...historical.request,
        inputs: [
          { assetId: "ia_existing_reference", role: "reference" },
          { assetId: "ia_upload_1", role: "reference" },
        ],
      }, "the current reference operation and both reference roles survive import instead of becoming edit/source");
    }, { targets: [dualModel], jobs: [historical] });
  });
}

test("mode switching, reference-only targets, generation count and unsupported imports respect capabilities", async () => {
  await mounted(async ({ env, calls, byLabel, button, click, change, importFile, submit }) => {
    await change(byLabel("提示词"), "Keep my prompt");
    await click(button("图生图"));
    assert.equal(submit().disabled, true);
    await change(byLabel("图像模型"), "reference-only");
    await importFile("paste", new env.dom.window.File(["ref"], "ref.webp", { type: "image/webp" }));
    await change(byLabel("生成数量"), "0");
    assert.equal(submit().disabled, true);
    await change(byLabel("生成数量"), "5");
    assert.equal(submit().disabled, true);
    await change(byLabel("生成数量"), "2");
    await click(submit());
    assert.equal(calls.creates[0].request.operation, "reference");
    assert.equal(calls.creates[0].request.count, 2);
    assert.deepEqual(calls.creates[0].request.inputs, [{ assetId: "ia_upload_1", role: "reference" }]);
    await change(byLabel("图像模型"), "generate-only");
    assert.equal(button("图生图").disabled, true);
    assert.equal(byLabel("上传参考图片").disabled, true);
    const event = await importFile("drop", new env.dom.window.File(["ignored"], "ignored.png", { type: "image/png" }));
    assert.equal(event.defaultPrevented, false);
    assert.equal(calls.uploads.length, 1);
    assert.equal(byLabel("提示词").value, "Keep my prompt");
  }, { targets: [target(), target("reference-only", ["generate", "reference"]), target("generate-only", ["generate"])] });
});

test("upload rejects invalid files, reports transport failure and cancels in-flight upload without late draft mutation", async () => {
  const pending = deferred();
  await mounted(async ({ env, host, calls, byLabel, button, click, change, importFile, submit }) => {
    await change(byLabel("提示词"), "Preserved draft");
    await importFile("drop", new env.dom.window.File(["text"], "bad.txt", { type: "text/plain" }));
    assert.equal(calls.uploads.length, 0);
    assert.match(host.textContent, /无法识别图片格式/);
    await importFile("upload", new env.dom.window.File(["broken"], "failed.png", { type: "image/png" }));
    assert.match(host.textContent, /图片上传失败/);
    await importFile("paste", new env.dom.window.File(["pending"], "pending.png", { type: "image/png" }));
    assert.match(host.textContent, /上传中/);
    assert.equal(submit().disabled, true);
    await importFile("drop", new env.dom.window.File(["duplicate"], "duplicate.png", { type: "image/png" }));
    assert.equal(calls.uploads.length, 2, "ignores imports during upload");
    await click(button("取消上传"));
    assert.equal(calls.uploads[1].signal.aborted, true);
    await env.act(async () => pending.resolve({ id: "ia_late", available: true }));
    assert.equal(host.querySelector('[aria-label="输入图片"]'), null);
    assert.equal(byLabel("提示词").value, "Preserved draft");
    assert.match(host.textContent, /上传已取消/);
  }, { client: calls => ({ upload: async (file, name, signal) => {
    calls.uploads.push({ file, name, signal });
    if (calls.uploads.length === 1) throw new Error("upload unavailable");
    return pending.promise;
  } }) });
});

test("pending submit ignores duplicate DOM submissions; after acceptance the button sends the edited draft as a new job", async () => {
  const pending = deferred();
  await mounted(async ({ env, host, calls, byLabel, button, click, change, submit }) => {
    await change(byLabel("提示词"), "First prompt");
    await click(submit());
    assert.equal(button("正在提交…").disabled, true);
    await env.act(async () => {
      byLabel("图像创作").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      byLabel("图像创作").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.equal(calls.creates.length, 1);
    await change(byLabel("提示词"), "Next prompt");
    await env.act(async () => pending.resolve(job("accepted", { status: "running" })));
    assert.equal([...byLabel("图像创作").querySelectorAll("button")].some(e => /再次生成|确认重新生成/.test(e.textContent)), false);
    await click(submit());
    assert.equal(calls.creates.length, 2);
    assert.notEqual(calls.creates[0].key, calls.creates[1].key);
    assert.equal(calls.creates[0].request.prompt, "First prompt");
    assert.equal(calls.creates[1].request.prompt, "Next prompt");
  }, { client: calls => ({ createJob: async (request, key) => {
    calls.creates.push({ request: structuredClone(request), key });
    return calls.creates.length === 1 ? pending.promise : job("regenerated", { request, status: "running" });
  } }) });
});

test("a lost receipt or a rejection keeps the draft editable and the next click sends the corrected draft as a new request", async () => {
  for (const rejected of [false, true]) {
    await mounted(async ({ host, calls, byLabel, button, click, change, submit }) => {
      await change(byLabel("提示词"), "Original draft");
      await click(submit());
      assert.match(host.textContent, rejected ? /请求已被拒绝/ : /提交结果未确认/);
      assert.equal(byLabel("提示词").value, "Original draft");
      await change(byLabel("提示词"), "Corrected draft");
      await click(submit());
      assert.equal(calls.creates.length, 2);
      assert.equal(calls.creates[1].request.prompt, "Corrected draft");
      assert.notEqual(calls.creates[0].key, calls.creates[1].key);
    }, { client: calls => ({ createJob: async (request, key) => {
      calls.creates.push({ request: structuredClone(request), key });
      if (calls.creates.length === 1) throw rejected ? { status: 422, code: "IMAGE_INVALID_INPUT" } : new Error("lost response");
      return job("accepted", { request, status: "running" });
    } }) });
  }
});

test("pending request entry recovers archive A without a job after restoring B; the next click sends A's current draft", async () => {
  const historicalB = job("history-B", {
    projectId: "archive-B", assetIds: ["ia_history_b"],
    request: {
      projectId: "archive-B", targetId: "model-edit", prompt: "Historical B prompt",
      operation: "generate", count: 2, parameters: {}, inputs: [],
    },
  });
  await mounted(async ({ host, calls, byLabel, button, click, change, submit }) => {
    assert.equal(host.querySelector('[aria-label="待核对请求"]'), null);
    await change(byLabel("提示词"), "Unknown A prompt");
    await click(submit());
    assert.equal(calls.creates.length, 1);
    const { key: K1, request: originalA } = calls.creates[0];
    assert.ok(K1);
    assert.equal(originalA.projectId, "archive-A");
    assert.equal(originalA.prompt, "Unknown A prompt");
    assert.match(host.textContent, /提交结果未确认/);
    assert.equal(host.querySelectorAll('[aria-label="图像结果画廊"] article').length, 1, "A has no job card or result to select");
    assert.equal(byLabel("图像结果画廊").querySelector("article").getAttribute("aria-label"), "任务 history-B");
    button("查看待核对请求：Unknown A prompt", byLabel("待核对请求"));
    await change(byLabel("提示词"), "Edited A draft after lost receipt");
    await click(button("恢复输入", byLabel("任务 history-B")));
    assert.equal(byLabel("提示词").value, "Historical B prompt");
    assert.equal(byLabel("生成数量").value, "2");
    assert.equal(submit().disabled, false);
    assert.equal([...byLabel("图像创作").querySelectorAll("button")].some(e => e.textContent.trim() === "核对原请求"), false, "B does not inherit A's submission");
    assert.equal(calls.creates.length, 1, "restoring B never submits");
    await click(button("查看待核对请求：Unknown A prompt", byLabel("待核对请求")));
    assert.equal(byLabel("提示词").value, "Edited A draft after lost receipt");
    assert.equal(byLabel("生成数量").value, "1");
    assert.equal(calls.creates.length, 1, "returning to pending A only restores its scope");
    await click(submit());
    assert.equal(calls.creates.length, 2);
    assert.notEqual(calls.creates[1].key, K1);
    assert.equal(calls.creates[1].request.prompt, "Edited A draft after lost receipt");
    assert.equal(calls.creates[1].request.projectId, originalA.projectId);
    assert.equal(host.querySelector('[aria-label="待核对请求"]'), null, "confirmed A is removed from pending entries");
    byLabel("任务 recovered-A");
    byLabel("任务 history-B");
    assert.equal(byLabel("提示词").value, "Edited A draft after lost receipt");
  }, {
    projects: [project("archive-A"), project("archive-B")], jobs: [historicalB],
    client: calls => ({ createJob: async (request, key) => {
      calls.creates.push({ request: structuredClone(request), key });
      if (calls.creates.length === 1) throw new Error("A receipt lost without a known job id");
      return job("recovered-A", { projectId: request.projectId, request, status: "running" });
    } }),
  });
});

test("history shows errors and cancellation semantics, disables pending cancellation and refreshes unknown results", async () => {
  const running = job("running", { status: "running" });
  const local = job("local", { status: "running", targetSnapshot: { ...target(), capabilities: { ...target().capabilities, supportsCancel: false } } });
  const cancelling = job("cancelling", { status: "cancel_requested" });
  const unknown = job("unknown", { status: "result_unknown", error: { code: "IMAGE_RESULT_UNKNOWN", message: "Image execution result is unknown" } });
  await mounted(async ({ host, calls, byLabel, button, click, submit }) => {
    assert.match(byLabel("任务 unknown").textContent, /图像任务的执行结果未知/);
    assert.match(byLabel("任务 unknown").textContent, /重新生成可能再次计费/);
    assert.equal(button("正在取消…", byLabel("任务 cancelling")).disabled, true);
    await click(button("取消任务", byLabel("任务 running")));
    assert.match(byLabel("任务 running").textContent, /已取消/);
    assert.equal([...byLabel("任务 running").querySelectorAll("button")].some(b => b.textContent === "取消任务"), false);
    await click(button("停止本地处理", byLabel("任务 local")));
    assert.match(byLabel("任务 local").textContent, /上游可能仍在执行或计费/);
    assert.deepEqual(calls.cancels, ["running", "local"]);
    await click(button("刷新状态", byLabel("任务 unknown")));
    assert.match(byLabel("任务 unknown").textContent, /已完成/);
    assert.match(host.textContent, /晚到图片会保留/);
  }, { jobs: [running, local, cancelling, unknown], client: calls => ({
    cancelJob: async id => { calls.cancels.push(id); return { ...(id === "local" ? local : running), revision: 2, status: "cancelled", ...(id === "local" ? { cancelEffect: "local_only" } : {}) }; },
    getJob: async () => ({ ...unknown, revision: 2, status: "succeeded", error: null, assetIds: ["ia_recovered"] }),
  }) });
});

test("empty models links to provider settings and disabled models cannot create jobs", async () => {
  let settingsOpened = 0;
  await mounted(async ({ calls, byLabel, button, click, change, submit }) => {
    await click(button("供应商设置"));
    assert.equal(settingsOpened, 1);
    assert.match(byLabel("图像模型").textContent, /暂无可用图像模型/);
    await change(byLabel("提示词"), "Draft without models");
    assert.equal(submit().disabled, true);
    assert.equal(calls.creates.length, 0);
  }, { targets: [], onOpenSettings: () => { settingsOpened++; } });
  await mounted(async ({ host, calls, byLabel, button, change, submit }) => {
    await change(byLabel("提示词"), "Draft on disabled model");
    assert.match(host.textContent, /Fixture disabled/);
    assert.equal(submit().disabled, true);
    assert.equal(calls.creates.length, 0);
  }, { targets: [{ ...target(), enabled: false, disabledReason: "Fixture disabled" }] });
});

test("a multi-image job gets a result strip, and a second edit upload rides along as a reference", async () => {
  const multi = job("multi", { assetIds: ["ia_one", "ia_two"] });
  await mounted(async ({ env, calls, byLabel, button, click, change, importFile, submit }) => {
    await click(byLabel("查看任务：Prompt multi"));
    assert.equal(byLabel("图片预览").querySelectorAll('button[aria-label^="选择结果"]').length, 2);
    assert.match(byLabel("图片预览").textContent, /第 1 \/ 2 张/);
    await click(byLabel("选择结果 2，Studio Model"));
    assert.equal(byLabel("选择结果 2，Studio Model").getAttribute("aria-pressed"), "true");
    assert.ok(calls.reads.some(r => r.id === "ia_two" && r.variant === "original"));
    await click(button("下载图片"));
    assert.deepEqual(calls.exports, [{ id: "ia_two", destination: "download" }]);
    await change(byLabel("提示词"), "Blend these");
    const png = (name) => new env.dom.window.File(["PNG fixture bytes"], name, { type: "image/png" });
    await importFile("upload", png("first.png"));
    await importFile("upload", png("second.png"));
    await click(submit());
    assert.equal(calls.creates[0].request.operation, "edit");
    assert.deepEqual(calls.creates[0].request.inputs, [
      { assetId: "ia_upload_1", role: "source" },
      { assetId: "ia_upload_2", role: "reference" },
    ]);
  }, { jobs: [multi] });
});

test("clicking the preview opens the large-image viewer at the selected result of the job", async () => {
  const multi = job("multi", { assetIds: ["ia_one", "ia_two"] });
  await mounted(async ({ host, byLabel, click }) => {
    assert.equal(host.querySelector('[aria-label="大图查看器"]'), null);
    await click(byLabel("选择结果 2，Studio Model"));
    await click(byLabel("查看大图"));
    const viewer = byLabel("大图查看器");
    assert.equal(viewer.dataset.ids, "ia_one,ia_two");
    assert.equal(viewer.dataset.index, "1", "starts at the image shown in the preview");
    await click([...viewer.querySelectorAll("button")].find((b) => b.textContent === "关闭大图"));
    assert.equal(host.querySelector('[aria-label="大图查看器"]'), null);
  }, { jobs: [multi] });
});
