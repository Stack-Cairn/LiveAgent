import assert from "node:assert/strict";
import test from "node:test";
import { renderComposerQueue } from "../helpers/composer-queue-render.mjs";

const FLATTEN_AFTER_GOAL = "[&>[data-composer-goal-bar]+*]:rounded-t-none";

// 目标栏（border-b-0、底边直角）与队列面板同宽且上下紧贴：只有真正渲染出的目标栏
// 才让下方队列去掉上圆角，否则拼接处两侧各凹进一个圆角缺口。实际几何由
// composer-queue-panel-narrow-pane.test.mjs 在无头 Edge 里量。
test("queue panel under a rendered goal bar loses its top corners through the stack", async () => {
  const { panelClasses, goalClasses, containerClasses, goalIsPreviousSiblingOfPanel } =
    await renderComposerQueue({ withGoal: true });
  assert.ok(panelClasses && goalClasses, "goal bar and queue panel must both render");
  assert.ok(goalIsPreviousSiblingOfPanel, "goal bar sits directly above the queue panel");
  const width = (classes) => classes.find((cls) => cls.startsWith("w-"));
  assert.equal(width(panelClasses), width(goalClasses), "precondition: same width");
  assert.ok(goalClasses.includes("border-b-0"), "precondition: goal bar has no bottom edge");
  assert.ok(containerClasses.includes(FLATTEN_AFTER_GOAL), containerClasses.join(" "));
});

// 生产里 goalBar 总是一个宿主元素，没有目标时渲染为空；这时队列面板必须保留上圆角。
test("an empty goal-bar host leaves the queue panel's top corners rounded", async () => {
  const { panelClasses, goalClasses, panelHasPreviousSibling } = await renderComposerQueue();
  assert.equal(goalClasses, null, "no goal bar renders");
  assert.equal(panelHasPreviousSibling, false, "nothing sits above the queue panel");
  assert.ok(panelClasses.includes("rounded-t-lg"), panelClasses.join(" "));
  assert.ok(!panelClasses.includes("rounded-t-none"), panelClasses.join(" "));
});

// 目标栏的操作顺序与排队指令一致：编辑、执行（暂停/继续）、删除。
test("goal bar actions follow the queued-turn order: edit, run, delete", async () => {
  const running = await renderComposerQueue({ withGoal: true });
  const { label } = running;
  assert.deepEqual(
    running.queueItemButtonLabels.filter((name) => name !== label("chat.queue.moveUp")),
    [label("chat.queue.edit"), label("chat.queue.runNow"), label("chat.queue.delete")],
    "precondition: queued-turn action order",
  );
  assert.deepEqual(running.goalButtonLabels, [
    label("chat.goalBar.edit"),
    label("chat.goalBar.pause"),
    label("chat.goalBar.clear"),
  ]);
  const paused = await renderComposerQueue({
    withGoal: true,
    goalState: { goal: "Ship the queue panel fix", status: "paused", round: 2, maxRounds: 10 },
  });
  assert.deepEqual(paused.goalButtonLabels, [
    label("chat.goalBar.edit"),
    label("chat.goalBar.resume"),
    label("chat.goalBar.clear"),
  ]);
});
