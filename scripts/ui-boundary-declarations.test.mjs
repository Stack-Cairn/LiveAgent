import assert from "node:assert/strict";
import test from "node:test";
import {
  findRetiredSharedDeclarations,
  rendersImportedComponent,
} from "./ui-boundary-declarations.mjs";

const retiredName = "normalizeTerminalSession";

function detectedKinds(source) {
  return findRetiredSharedDeclarations(source, "host.ts", new Set([retiredName])).map(
    ({ kind }) => kind,
  );
}

test("boundary declaration scan catches function and variable implementations", () => {
  assert.deepEqual(detectedKinds(`function ${retiredName}(value) { return value; }`), ["function"]);
  assert.deepEqual(detectedKinds(`const ${retiredName} = (value) => value;`), ["variable"]);
  assert.deepEqual(detectedKinds(`let ${retiredName} = (value) => value;`), ["variable"]);
  assert.deepEqual(detectedKinds(`var ${retiredName} = (value) => value;`), ["variable"]);
  assert.deepEqual(
    detectedKinds(`const /* host copy */ ${retiredName} = (value) => value;`),
    ["variable"],
  );
});

test("boundary declaration scan catches method and property implementations", () => {
  assert.deepEqual(detectedKinds(`const host = { ${retiredName}(value) { return value; } };`), [
    "method",
  ]);
  assert.deepEqual(
    detectedKinds(`class Host { static ${retiredName}(value) { return value; } }`),
    ["method"],
  );
  assert.deepEqual(
    detectedKinds(`const host = { ["${retiredName}"]: (value) => value };`),
    ["property"],
  );
  assert.deepEqual(
    detectedKinds(`class Host { ${retiredName} = (value) => value; }`),
    ["property"],
  );
});

test("boundary declaration scan catches later assignments", () => {
  assert.deepEqual(detectedKinds(`${retiredName} = (value) => value;`), ["assignment"]);
  assert.deepEqual(detectedKinds(`host.${retiredName} = (value) => value;`), ["assignment"]);
  assert.deepEqual(detectedKinds(`host["${retiredName}"] ||= (value) => value;`), [
    "assignment",
  ]);
});

test("boundary declaration scan ignores imports, calls, and shared references", () => {
  assert.deepEqual(
    detectedKinds(`
      import { ${retiredName} } from "@liveagent/ui/lib/terminal/normalization";
      const host = { normalizer: ${retiredName}, ${retiredName} };
      export { ${retiredName} };
      ${retiredName}(value);
    `),
    [],
  );
});

const applicationViewModule = "@liveagent/ui/application/ApplicationView";

function rendersApplicationView(source) {
  return rendersImportedComponent(
    source,
    "ApplicationViewHost.tsx",
    applicationViewModule,
    "ApplicationView",
  );
}

test("component render scan accepts runtime imports and JSX nodes", () => {
  assert.equal(
    rendersApplicationView(`
      import { ApplicationView } from "${applicationViewModule}";
      export function Host() { return <ApplicationView />; }
    `),
    true,
  );
  assert.equal(
    rendersApplicationView(`
      import { ApplicationView as SharedApplicationView } from "${applicationViewModule}";
      export function Host() {
        return <SharedApplicationView><main /></SharedApplicationView>;
      }
    `),
    true,
  );
});

test("component render scan rejects comments and strings", () => {
  assert.equal(
    rendersApplicationView(`
      // import { ApplicationView } from "${applicationViewModule}";
      // <ApplicationView />
      const examples = [
        'import { ApplicationView } from "${applicationViewModule}";',
        "<ApplicationView />",
      ];
    `),
    false,
  );
});

test("component render scan rejects type-only imports", () => {
  assert.equal(
    rendersApplicationView(`
      import type { ApplicationView } from "${applicationViewModule}";
      export function Host() { return <ApplicationView />; }
    `),
    false,
  );
  assert.equal(
    rendersApplicationView(`
      import { type ApplicationView } from "${applicationViewModule}";
      export function Host() { return <ApplicationView />; }
    `),
    false,
  );
});

test("component render scan requires both the import and JSX render", () => {
  assert.equal(
    rendersApplicationView(`
      import { ApplicationView } from "${applicationViewModule}";
      const example = "<ApplicationView />";
    `),
    false,
  );
  assert.equal(
    rendersApplicationView(`
      // import { ApplicationView } from "${applicationViewModule}";
      export function Host() { return <ApplicationView />; }
    `),
    false,
  );
});
