import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const guard = loader.loadModule("src/lib/tools/cuaSelfGuard.ts");

const {
  refuseSelfTargetedCall,
  refuseSelfRegionCall,
  usesDesktopScreenCoordinates,
  stripSelfFromJsonText,
  resetCuaSelfGuardCaches,
} = guard;

const SELF_PID = 4242;
const OTHER_PID = 99;

test.beforeEach(() => resetCuaSelfGuardCaches());

test("宿主 pid 的调用被拒绝，其他 pid 放行", () => {
  assert.ok(refuseSelfTargetedCall({ pid: SELF_PID }, SELF_PID));
  assert.equal(refuseSelfTargetedCall({ pid: OTHER_PID }, SELF_PID), null);
  assert.equal(refuseSelfTargetedCall({}, SELF_PID), null);
  assert.equal(refuseSelfTargetedCall(undefined, SELF_PID), null);
});

test("拿不到宿主 pid 时不拦截——宁可不拦，也不误伤正常目标", () => {
  assert.equal(refuseSelfTargetedCall({ pid: SELF_PID }, null), null);
});

test("窗口枚举结果剔除宿主记录", () => {
  const payload = JSON.stringify({
    windows: [
      { window_id: 1, pid: SELF_PID, app_name: "LiveAgent" },
      { window_id: 2, pid: OTHER_PID, app_name: "Safari" },
    ],
  });
  const stripped = JSON.parse(stripSelfFromJsonText(payload, SELF_PID));
  assert.deepEqual(
    stripped.windows.map((w) => w.pid),
    [OTHER_PID],
  );
});

test("过滤时学到的 window_id 让后续按 window_id 的调用也被拦下", () => {
  // 过滤之前拦不住：window_id 与 pid 的对应关系只有 cua-driver 知道。
  assert.equal(refuseSelfTargetedCall({ window_id: 1 }, SELF_PID), null);

  stripSelfFromJsonText(
    JSON.stringify([{ window_id: 1, pid: SELF_PID }, { window_id: 2, pid: OTHER_PID }]),
    SELF_PID,
  );

  assert.ok(refuseSelfTargetedCall({ window_id: 1 }, SELF_PID));
  assert.equal(refuseSelfTargetedCall({ window_id: 2 }, SELF_PID), null);
});

test("嵌套结构里的宿主记录同样被剔除", () => {
  const payload = JSON.stringify({
    desktop: { apps: [{ pid: SELF_PID }, { pid: OTHER_PID }] },
  });
  const stripped = JSON.parse(stripSelfFromJsonText(payload, SELF_PID));
  assert.deepEqual(stripped.desktop.apps, [{ pid: OTHER_PID }]);
});

test("非 JSON 载荷与无宿主记录的载荷原样返回", () => {
  const plain = "Screenshot captured: 1920x1080";
  assert.equal(stripSelfFromJsonText(plain, SELF_PID), plain);

  const malformed = "{not json";
  assert.equal(stripSelfFromJsonText(malformed, SELF_PID), malformed);

  // 没有命中就不该重新序列化——避免无谓地改写模型看到的原文格式。
  const clean = JSON.stringify({ windows: [{ window_id: 2, pid: OTHER_PID }] });
  assert.equal(stripSelfFromJsonText(clean, SELF_PID), clean);
});

test("拿不到宿主 pid 时不过滤", () => {
  const payload = JSON.stringify([{ pid: SELF_PID }]);
  assert.equal(stripSelfFromJsonText(payload, null), payload);
});

test("包在 target 里的宿主 pid / window_id 同样被拦下", () => {
  // 上游现约把目标写进 target 对象。只看顶层字段的话，官方写法直接放行。
  assert.ok(
    refuseSelfTargetedCall({ target: { kind: "window", pid: SELF_PID }, x: 10, y: 10 }, SELF_PID),
  );
  assert.equal(
    refuseSelfTargetedCall({ target: { kind: "window", pid: OTHER_PID }, x: 10, y: 10 }, SELF_PID),
    null,
  );

  stripSelfFromJsonText(JSON.stringify([{ window_id: 7, pid: SELF_PID }]), SELF_PID);
  assert.ok(refuseSelfTargetedCall({ target: { kind: "window", window_id: 7 } }, SELF_PID));
  assert.equal(refuseSelfTargetedCall({ target: { kind: "window", window_id: 8 } }, SELF_PID), null);
});

test("camelCase 与 owner_pid 之类的别名一并覆盖", () => {
  assert.ok(refuseSelfTargetedCall({ target: { processId: SELF_PID } }, SELF_PID));
  assert.ok(refuseSelfTargetedCall({ target: { owner_pid: SELF_PID } }, SELF_PID));

  stripSelfFromJsonText(JSON.stringify([{ windowId: 11, pid: SELF_PID }]), SELF_PID);
  assert.ok(refuseSelfTargetedCall({ windowId: 11 }, SELF_PID));
});

test("桌面坐标判定：显式窗口目标不算，桌面目标与扁平坐标都算", () => {
  assert.equal(
    usesDesktopScreenCoordinates({ target: { kind: "window", window_id: 9 }, x: 10, y: 10 }),
    false,
  );
  assert.ok(usesDesktopScreenCoordinates({ target: { kind: "desktop" }, x: 800, y: 400 }));
  // 没有 target 的扁平写法按屏幕绝对坐标处理。
  assert.ok(usesDesktopScreenCoordinates({ x: 800, y: 400 }));
  // 不带坐标的调用与本条无关。
  assert.equal(usesDesktopScreenCoordinates({ target: { kind: "desktop" } }), false);
  assert.equal(usesDesktopScreenCoordinates(undefined), false);
});

test("落在宿主窗口矩形内的桌面坐标被拒绝，外面的放行", () => {
  const rects = [{ x: 100, y: 100, width: 400, height: 300 }];

  assert.ok(refuseSelfRegionCall({ target: { kind: "desktop" }, x: 200, y: 200 }, rects));
  // 边界算在内：窗口边框上的点击一样会落到宿主窗口。
  assert.ok(refuseSelfRegionCall({ x: 100, y: 100 }, rects));
  assert.ok(refuseSelfRegionCall({ x: 500, y: 400 }, rects));

  assert.equal(refuseSelfRegionCall({ x: 900, y: 200 }, rects), null);
  assert.equal(refuseSelfRegionCall({ x: 200, y: 900 }, rects), null);

  // 拖拽这类多点参数，任一端落在宿主窗口里就拒绝。
  assert.ok(refuseSelfRegionCall({ start: { x: 900, y: 900 }, end: { x: 200, y: 200 } }, rects));

  // 矩形拿不到（宿主窗口全部不可见 / 查询失败）时不拦，宁可不拦也不误伤。
  assert.equal(refuseSelfRegionCall({ x: 200, y: 200 }, []), null);
});

test("带摘要前缀的 MCP 文本也会被过滤，前后文原样保留", () => {
  const payload = `✅ Windows listed\n${JSON.stringify({
    windows: [
      { window_id: 1, pid: SELF_PID, app_name: "LiveAgent" },
      { window_id: 2, pid: OTHER_PID, app_name: "Safari" },
    ],
  })}\n(2 windows)`;

  const stripped = stripSelfFromJsonText(payload, SELF_PID);
  assert.ok(stripped.startsWith("✅ Windows listed\n"));
  assert.ok(stripped.endsWith("\n(2 windows)"));
  assert.equal(stripped.includes("LiveAgent"), false);

  // 顺带学到了宿主的 window_id。
  assert.ok(refuseSelfTargetedCall({ window_id: 1 }, SELF_PID));
});

test("一条文本里的多段 JSON 全部过滤，不只是第一段", () => {
  const payload = [
    "✅ Windows listed",
    JSON.stringify({ windows: [{ window_id: 1, pid: SELF_PID, app_name: "LiveAgent" }] }),
    "and apps:",
    JSON.stringify({ apps: [{ pid: SELF_PID, name: "LiveAgent" }, { pid: OTHER_PID }] }),
  ].join("\n");

  const stripped = stripSelfFromJsonText(payload, SELF_PID);
  assert.equal(stripped.includes("LiveAgent"), false);
  assert.ok(stripped.includes("and apps:"));
  assert.ok(stripped.includes(String(OTHER_PID)));
});

test("嵌套过深的入参被拒绝，而不是扫不完就放行", () => {
  // 扫不完就放行等于给出一条现成的绕过方式：把目标埋到深处即可。
  let deep = { pid: SELF_PID };
  for (let i = 0; i < 20; i++) deep = { nested: deep };
  assert.ok(refuseSelfTargetedCall(deep, SELF_PID));

  // 深但没有可疑字段的也一样拒绝——扫不完就是没能确认。
  let benign = { note: "x" };
  for (let i = 0; i < 20; i++) benign = { nested: benign };
  assert.ok(refuseSelfTargetedCall(benign, SELF_PID));

  // 正常深度不受影响。
  assert.equal(
    refuseSelfTargetedCall({ target: { kind: "window", window_id: 42 } }, SELF_PID),
    null,
  );
});

test("JSON 片段的括号配对认字符串字面量", () => {
  const payload = `Result:\n${JSON.stringify({
    windows: [{ window_id: 3, pid: SELF_PID, title: 'a } b " c' }],
  })}`;
  const stripped = stripSelfFromJsonText(payload, SELF_PID);
  assert.equal(stripped.includes("window_id"), false);
  assert.ok(stripped.startsWith("Result:\n"));
});
