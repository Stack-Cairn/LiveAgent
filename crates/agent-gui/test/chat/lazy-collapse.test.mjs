import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

let mountedState = false;
let stateWrites = [];

const loader = createTsModuleLoader({
  mocks: {
    react: {
      useState() {
        return [mountedState, (value) => stateWrites.push(value)];
      },
    },
    "../../../../lib/shared/utils": {
      cn: (...parts) => parts.filter(Boolean).join(" "),
    },
  },
});

const { LazyCollapse } = loader.loadModule(
  "src/pages/chat/components/assistant-bubble/LazyCollapse.tsx",
);

function renderCollapse({ open, retainWhileClosed, mounted }) {
  mountedState = mounted;
  stateWrites = [];
  let childRenders = 0;
  const rendered = LazyCollapse({
    open,
    retainWhileClosed,
    children() {
      childRenders += 1;
      return { type: "HeavyBody", props: {} };
    },
  });
  return { childRenders, rendered, stateWrites };
}

test("collapsed-from-birth content stays unmounted even while active", () => {
  const result = renderCollapse({ open: false, retainWhileClosed: true, mounted: false });
  assert.equal(result.childRenders, 0);
});

test("active content may retain a previously mounted body while closed", () => {
  const result = renderCollapse({ open: false, retainWhileClosed: true, mounted: true });
  assert.equal(result.childRenders, 1);
});

test("settled content releases a previously mounted body when closed", () => {
  const result = renderCollapse({ open: false, retainWhileClosed: false, mounted: true });
  assert.equal(result.childRenders, 0);
  assert.equal(result.rendered.props["aria-hidden"], true);
});

test("opening mounts the body in the same render", () => {
  const result = renderCollapse({ open: true, retainWhileClosed: false, mounted: false });
  assert.equal(result.childRenders, 1);
  assert.deepEqual(result.stateWrites, [true]);
});
