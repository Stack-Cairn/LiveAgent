import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sharedTrajectoryRoot = new URL("../../../agent-ui/src/components/trajectory/", import.meta.url);
const trajectoryViewSource = readFileSync(new URL("TrajectoryView.tsx", sharedTrajectoryRoot), "utf8");
const toolbarSource = readFileSync(new URL("TrajectoryToolbar.tsx", sharedTrajectoryRoot), "utf8");
const timelineSource = readFileSync(new URL("TrajectoryTimeline.tsx", sharedTrajectoryRoot), "utf8");
const rowSource = readFileSync(new URL("TrajectoryRow.tsx", sharedTrajectoryRoot), "utf8");
const tableSource = readFileSync(new URL("TrajectoryTable.tsx", sharedTrajectoryRoot), "utf8");
const detailsSource = readFileSync(
  new URL("details/DetailsPanel.tsx", sharedTrajectoryRoot),
  "utf8",
);
const resizeHandleSource = readFileSync(
  new URL("details/DetailsResizeHandle.tsx", sharedTrajectoryRoot),
  "utf8",
);

test("narrow trajectory container keeps empty details beside the list", () => {
  assert.match(trajectoryViewSource, /className="@container flex h-full min-h-0 flex-1 flex-col"/);
  assert.match(detailsSource, /min-w-\[160px\] max-w-\[calc\(100%-140px\)\]/);
  assert.match(detailsSource, /trajectory\.details\.empty/);
  assert.match(tableSource, /min-h-0 min-w-0 flex-1 overflow-y-auto/);
  assert.doesNotMatch(detailsSource, /@max-\[820px\]:hidden/);
  assert.match(trajectoryViewSource, /relative flex min-h-0 flex-1 overflow-hidden/);
});

test("trajectory details keep a bounded vertical scroll owner in the WebUI host", () => {
  assert.match(trajectoryViewSource, /@container flex h-full min-h-0 flex-1 flex-col/);
  assert.match(detailsSource, /min-h-0 flex-1 overflow-y-auto/);
});

test("selected narrow-container details remain in a two-column layout", () => {
  assert.equal(
    detailsSource.match(/min-w-\[160px\] max-w-\[calc\(100%-140px\)\]/g)?.length,
    2,
  );
  assert.doesNotMatch(detailsSource, /@max-\[820px\]:absolute/);
  assert.doesNotMatch(detailsSource, /@max-\[820px\]:inset-0/);
  assert.doesNotMatch(detailsSource, /@max-\[820px\]:w-full/);
  assert.match(detailsSource, /@max-\[520px\]:flex-nowrap @max-\[520px\]:overflow-x-auto/);
});

test("narrow trajectory controls preserve horizontal content space", () => {
  assert.match(toolbarSource, /@max-\[520px\]:flex-wrap/);
  assert.match(toolbarSource, /@max-\[520px\]:order-last[\s\S]*?@max-\[520px\]:w-full/);
  assert.match(timelineSource, /@max-\[520px\]:gap-1 @max-\[520px\]:px-2/);
  assert.match(timelineSource, /@max-\[520px\]:w-8/);
  assert.match(rowSource, /@max-\[520px\]:w-12 @max-\[520px\]:text-\[11px\]/);
});

test("trajectory details resizing remains available in narrow containers", () => {
  assert.match(detailsSource, /w-\[var\(--trajectory-details-width\)\]/);
  assert.match(resizeHandleSource, /role="separator"/);
  assert.match(resizeHandleSource, /aria-orientation="vertical"/);
  assert.match(resizeHandleSource, /z-30 flex w-3 touch-none cursor-col-resize/);
  assert.doesNotMatch(resizeHandleSource, /@min-\[821px\]:flex|hidden w-3/);
  assert.match(resizeHandleSource, /setPointerCapture/);
  assert.match(resizeHandleSource, /onKeyDown=\{handleKeyDown\}/);
});
