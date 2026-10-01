import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("form composition preserves control identity, label association, descriptions and refs", async () => {
  const env = await createDomTestEnv();
  const { React, act, createRoot } = env;
  const { FormField, FormFieldLabel, FormFieldDescription } = env.loadModule(
    "@liveagent/ui/components/settings/FormField.tsx",
  );
  const { Label } = env.loadModule("@liveagent/ui/components/ui/label.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const fieldRef = React.createRef();
  const labelRef = React.createRef();
  const hintRef = React.createRef();
  const h = React.createElement;
  const classSet = (node) => [...node.classList].sort();
  try {
    for (const compact of [false, true]) {
      await act(async () => root.render(h("div", null,
        h(FormField, { ref: fieldRef, density: compact ? "compact" : "default", className: "sm:col-span-2" },
          h(FormFieldLabel, { ref: labelRef, htmlFor: "field", size: compact ? "compact" : "default" }, "Name"),
          h("input", { id: "field", defaultValue: "draft", "aria-describedby": "hint" }),
          h(FormFieldDescription, { ref: hintRef, id: "hint", role: "status" }, "Required")),
        h("div", { className: `${compact ? "space-y-1.5" : "space-y-2"} sm:col-span-2` },
          h(Label, { htmlFor: "legacy", className: `${compact ? "text-xs " : ""}text-muted-foreground` }, "Name"),
          h("input", { id: "legacy" }),
          h("p", { className: "text-xs leading-5 text-muted-foreground" }, "Required")))));
      const [field, legacy] = container.firstElementChild.children;
      assert.equal(fieldRef.current, field);
      assert.equal(labelRef.current, field.children[0]);
      assert.equal(hintRef.current, field.children[2]);
      assert.equal(field.children[0].control, field.children[1]);
      assert.equal(field.children[1].getAttribute("aria-describedby"), hintRef.current.id);
      assert.equal(hintRef.current.getAttribute("role"), "status");
      for (const index of [0, 2]) assert.deepEqual(classSet(field.children[index]), classSet(legacy.children[index]));
      assert.deepEqual(classSet(field), classSet(legacy));
      assert.equal(field.hasAttribute("density"), false);
      assert.equal(labelRef.current.hasAttribute("size"), false);
    }
    const input = fieldRef.current.querySelector("input");
    input.value = "unsaved edit";
    input.focus();
    await act(async () => root.render(h("div", null,
      h(FormField, { ref: fieldRef, density: "default" },
        h(FormFieldLabel, { htmlFor: "field" }, "Name"),
        h("input", { id: "field", defaultValue: "draft", "aria-describedby": "hint" }),
        h(FormFieldDescription, { id: "hint" }, "Updated hint")), h("div"))));
    assert.equal(fieldRef.current.querySelector("input"), input);
    assert.equal(input.value, "unsaved edit");
    assert.equal(document.activeElement, input);
  } finally {
    await act(async () => root.unmount());
    env.cleanup();
  }
});
