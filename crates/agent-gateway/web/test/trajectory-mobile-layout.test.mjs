import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sharedTrajectoryRoot = new URL("../../../agent-ui/src/components/trajectory/", import.meta.url);
const trajectoryViewSource = readFileSync(new URL("TrajectoryView.tsx", sharedTrajectoryRoot), "utf8");
const toolbarSource = readFileSync(new URL("TrajectoryToolbar.tsx", sharedTrajectoryRoot), "utf8");
const timelineSource = readFileSync(new URL("TrajectoryTimeline.tsx", sharedTrajectoryRoot), "utf8");
const rowSource = readFileSync(new URL("TrajectoryRow.tsx", sharedTrajectoryRoot), "utf8");
const detailsSource = readFileSync(
  new URL("details/DetailsPanel.tsx", sharedTrajectoryRoot),
  "utf8",
);

test("mobile trajectory list is not covered by an empty details panel", () => {
  assert.match(detailsSource, /max-\[820px\]:hidden/);
  assert.match(detailsSource, /trajectory\.details\.empty/);
  assert.doesNotMatch(detailsSource, /max-md:w-\[min\(420px,92vw\)\]/);
  assert.match(trajectoryViewSource, /relative flex min-h-0 flex-1 overflow-hidden/);
});

test("selected mobile trajectory details replace the list at full width", () => {
  assert.match(detailsSource, /max-\[820px\]:absolute/);
  assert.match(detailsSource, /max-\[820px\]:inset-0/);
  assert.match(detailsSource, /max-\[820px\]:w-full/);
  assert.match(detailsSource, /max-\[820px\]:border-l-0/);
  assert.match(detailsSource, /max-\[520px\]:flex-nowrap max-\[520px\]:overflow-x-auto/);
});

test("narrow trajectory controls preserve horizontal content space", () => {
  assert.match(toolbarSource, /max-\[520px\]:flex-wrap/);
  assert.match(toolbarSource, /max-\[520px\]:order-last[\s\S]*?max-\[520px\]:w-full/);
  assert.match(timelineSource, /max-\[520px\]:gap-1 max-\[520px\]:px-2/);
  assert.match(timelineSource, /max-\[520px\]:w-8/);
  assert.match(rowSource, /max-\[520px\]:w-12 max-\[520px\]:text-\[11px\]/);
});
