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
  isDesktopKeyboardCall,
  refuseDesktopKeyboardCall,
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

test("无明确目标的 desktop 键盘调用在宿主处于前台时被拒绝", () => {
  // v0.22.0 契约:press_key 只要求 key、hotkey 只要求 keys、type_text 只要求
  // text,pid / window_id / 坐标均非必填,输入投递给前台应用。按 pid 与按
  // 坐标的两道闸对这类调用完全不参与——不查前台就是一条现成的绕过。
  const cases = [
    ["press_key", { scope: "desktop", key: "return" }],
    ["press_key", { target: { kind: "desktop", display_id: "primary" }, key: "return" }],
    ["hotkey", { scope: "desktop", keys: ["cmd", "q"] }],
    ["type_text", { scope: "desktop", text: "allow" }],
    // 扁平写法:连 scope 都没有,投递语义同样是前台。
    ["press_key", { key: "return" }],
  ];
  for (const [tool, args] of cases) {
    assert.ok(isDesktopKeyboardCall(tool, args), `${tool} 应被识别为焦点投递调用`);
    assert.ok(
      refuseDesktopKeyboardCall(tool, args, SELF_PID, SELF_PID),
      `${tool} 在宿主前台时应被拒绝`,
    );
  }
});

test("前台是其他应用时键盘调用放行", () => {
  assert.equal(
    refuseDesktopKeyboardCall("press_key", { scope: "desktop", key: "return" }, SELF_PID, OTHER_PID),
    null,
  );
  assert.equal(
    refuseDesktopKeyboardCall("type_text", { scope: "desktop", text: "hi" }, SELF_PID, OTHER_PID),
    null,
  );
});

test("前台查不到时 fail-closed 拒绝,而不是放行", () => {
  // 窗口矩形取不到可以放行(误伤的是矩形下方的真实目标);前台查不到不行——
  // 键盘输入没有那种二义性,放行的代价是模型可以对宿主敲任意按键。
  assert.ok(refuseDesktopKeyboardCall("press_key", { scope: "desktop", key: "return" }, SELF_PID, null));
});

test("带明确非宿主身份的键盘调用不过前台检查", () => {
  // 契约里带 pid / window_id 的调用(含 desktop scope + pid 的后台投递写法)
  // 投递给那个窗口,不跟焦点走;宿主自己的身份在这之前已被 pid 闸拒掉。
  assert.equal(
    isDesktopKeyboardCall("press_key", { target: { kind: "window", pid: OTHER_PID }, key: "return" }),
    false,
  );
  assert.equal(
    isDesktopKeyboardCall("type_text", { scope: "desktop", pid: OTHER_PID, text: "hi" }),
    false,
  );
  assert.equal(
    refuseDesktopKeyboardCall(
      "press_key",
      { target: { kind: "window", pid: OTHER_PID }, key: "return" },
      SELF_PID,
      SELF_PID,
    ),
    null,
  );
});

test("非键盘工具不受前台检查影响", () => {
  assert.equal(isDesktopKeyboardCall("click", { scope: "desktop", x: 1, y: 2 }), false);
  assert.equal(isDesktopKeyboardCall("get_desktop_state", {}), false);
  assert.equal(
    refuseDesktopKeyboardCall("click", { scope: "desktop", x: 1, y: 2 }, SELF_PID, SELF_PID),
    null,
  );
});

test("参数形态兜底:不认识的工具名带 key / keys 也按键盘调用处理", () => {
  // 上游改名或新增 hold_key 之类的工具时,靠载荷特征仍能认出来。
  assert.ok(isDesktopKeyboardCall("hold_key", { scope: "desktop", key: "shift" }));
  assert.ok(isDesktopKeyboardCall("send_keys", { keys: ["cmd", "w"] }));
  // text 字段刻意不参与形态兜底:clipboard_write / 查找类工具也带 text,
  // 投递语义与焦点无关;type_text 本身已由工具名覆盖。
  assert.equal(isDesktopKeyboardCall("clipboard_write", { text: "hello" }), false);
  assert.equal(isDesktopKeyboardCall("find_element", { scope: "desktop", text: "OK" }), false);
});

test("JSON 片段的括号配对认字符串字面量", () => {
  const payload = `Result:\n${JSON.stringify({
    windows: [{ window_id: 3, pid: SELF_PID, title: 'a } b " c' }],
  })}`;
  const stripped = stripSelfFromJsonText(payload, SELF_PID);
  assert.equal(stripped.includes("window_id"), false);
  assert.ok(stripped.startsWith("Result:\n"));
});
