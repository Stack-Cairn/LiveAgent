import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const i18nPath = fileURLToPath(new URL("../../src/i18n/index.ts", import.meta.url));
const iconsPath = fileURLToPath(new URL("../../src/components/icons/index.ts", import.meta.url));
const utilsPath = fileURLToPath(new URL("../../src/lib/shared/utils.ts", import.meta.url));

const { ASK_USER_QUESTION_TIMEOUT_MS } = createTsModuleLoader().loadModule(
  "src/lib/chat/askUserQuestion.ts",
);

const questions = [
  {
    id: "choice",
    header: "Choice",
    prompt: "Choose one option",
    options: [
      { label: "First", description: "The first option" },
      { label: "Second", description: "The second option", recommended: true },
    ],
  },
];

function createHookHarness(initialState = {}) {
  const states = [];
  const setters = [];
  let stateIndex = 0;
  const stateOverrides = new Map([
    [2, initialState.draftSelections ?? {}],
    [3, initialState.customSelected ?? {}],
    [4, initialState.customTexts ?? {}],
    [5, initialState.submitting ?? false],
  ]);
  // useAnswerCountdown 的 remainingMs（挂载后由 interval tick 驱动）；
  // 测试用它模拟“采信的截止时间随后归零”。
  if (initialState.remainingMs !== undefined) {
    stateOverrides.set(8, initialState.remainingMs);
  }

  const react = {
    useState(initialValue) {
      const index = stateIndex++;
      if (!(index in states)) {
        states[index] = stateOverrides.has(index)
          ? stateOverrides.get(index)
          : typeof initialValue === "function"
            ? initialValue()
            : initialValue;
      }
      const setState = (next) => {
        setters.push(index);
        states[index] = typeof next === "function" ? next(states[index]) : next;
      };
      return [states[index], setState];
    },
    useMemo(factory) {
      return factory();
    },
    useEffect() {},
  };

  return {
    react,
    setters,
    render(run) {
      stateIndex = 0;
      return run();
    },
  };
}

function createCardHarness(initialState = {}) {
  const hooks = createHookHarness(initialState);
  const loader = createTsModuleLoader({
    mocks: {
      react: hooks.react,
      [i18nPath]: {
        useLocale() {
          return { t: (key) => key };
        },
      },
      [iconsPath]: {
        Check: (props) => ({ type: "Check", props }),
        Sparkles: (props) => ({ type: "Sparkles", props }),
      },
      [utilsPath]: {
        cn(...values) {
          return values.filter(Boolean).join(" ");
        },
      },
    },
  });
  const { AskUserQuestionCard } = loader.loadModule(
    "src/components/chat/AskUserQuestionCard.tsx",
  );
  return {
    hooks,
    render(props) {
      return hooks.render(() =>
        AskUserQuestionCard({
          questions,
          interactive: true,
          ...props,
        }),
      );
    },
  };
}

function findAll(node, predicate, matches = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, matches);
    return matches;
  }
  if (!node || typeof node !== "object") return matches;
  if (predicate(node)) matches.push(node);
  findAll(node.props?.children, predicate, matches);
  return matches;
}

function findSubmitButton(tree) {
  return findAll(
    tree,
    (node) =>
      node.type === "button" &&
      ["chat.askUser.submit", "chat.askUser.submitting"].includes(node.props?.children),
  )[0];
}

function treeText(node) {
  if (Array.isArray(node)) return node.map(treeText).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return treeText(node.props?.children);
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushPromises() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test("expired countdown disables options, custom input, and submit before tool_result arrives", async () => {
  let submitCalls = 0;
  const card = createCardHarness({
    customSelected: { choice: true },
    customTexts: { choice: "My answer" },
    // 采信的截止时间（挂载时仍在窗口内）随 interval tick 归零。
    remainingMs: 0,
  });
  const tree = card.render({
    deadlineAt: Date.now() + 60_000,
    onSubmit: async () => {
      submitCalls += 1;
      return { ok: true };
    },
  });

  const optionButtons = findAll(
    tree,
    (node) => node.type === "button" && node.props?.role === "radio",
  );
  assert.equal(optionButtons.length, 2);
  assert.equal(optionButtons.every((button) => button.props.disabled === true), true);
  assert.equal(optionButtons.every((button) => button.props.className.includes("opacity-55")), true);

  const customOption = findAll(
    tree,
    (node) => node.type === "div" && node.props?.role === "radio",
  )[0];
  assert.equal(customOption.props["aria-disabled"], true);
  assert.equal(customOption.props.tabIndex, -1);

  const customInput = findAll(tree, (node) => node.type === "input")[0];
  assert.ok(customInput);
  assert.equal(customInput.props.disabled, true);

  const submitButton = findSubmitButton(tree);
  assert.ok(submitButton);
  assert.equal(submitButton.props.disabled, true);
  const setterCountBeforeBlockedActions = card.hooks.setters.length;
  optionButtons[0].props.onClick();
  customOption.props.onClick();
  submitButton.props.onClick();
  customInput.props.onKeyDown({
    key: "Enter",
    stopPropagation() {},
    preventDefault() {},
  });
  await flushPromises();
  assert.equal(card.hooks.setters.length, setterCountBeforeBlockedActions);
  assert.equal(submitCalls, 0);
});

// 截止时间由桌面时钟盖章、倒计时读本机时钟：偏移超界时必须回退挂载近似，
// 不能把仍在挂起的提问卡一挂载就锁死（过期提交由桌面挂起表权威拒绝）。
test("a deadline already past at mount is distrusted and the pending card stays answerable", async () => {
  const submitted = [];
  const card = createCardHarness({ draftSelections: { choice: "Second" } });
  const tree = card.render({
    // 本机时钟快于桌面盖章时钟：卡片挂载时截止时间看似早已过去。
    deadlineAt: Date.now() - 5 * 60 * 1000,
    onSubmit: async (answers) => {
      submitted.push(answers);
      return { ok: true };
    },
  });

  const optionButtons = findAll(
    tree,
    (node) => node.type === "button" && node.props?.role === "radio",
  );
  assert.equal(optionButtons.length, 2);
  assert.equal(optionButtons.every((button) => button.props.disabled === false), true);
  const customOption = findAll(
    tree,
    (node) => node.type === "div" && node.props?.role === "radio",
  )[0];
  assert.equal(customOption.props["aria-disabled"], false);

  const submitButton = findSubmitButton(tree);
  assert.equal(submitButton.props.disabled, false);
  submitButton.props.onClick();
  await flushPromises();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0][0].selectedLabel, "Second");
});

test("a deadline beyond the full answer window is distrusted and clamps the countdown", () => {
  const card = createCardHarness();
  const tree = card.render({
    // 本机时钟慢于桌面盖章时钟：截止时间看似远超完整应答窗口。
    deadlineAt: Date.now() + ASK_USER_QUESTION_TIMEOUT_MS + 5 * 60 * 1000,
    onSubmit: async () => ({ ok: true }),
  });

  const optionButtons = findAll(
    tree,
    (node) => node.type === "button" && node.props?.role === "radio",
  );
  assert.equal(optionButtons.every((button) => button.props.disabled === false), true);
  // 倒计时按挂载近似显示完整窗口，而不是把偏移量当剩余时间。
  assert.match(treeText(tree), /(?:3:00|2:59) chat\.askUser\.timeoutHint/);
});

test("a complete answer before the deadline submits the selected non-first option", async () => {
  const submitted = [];
  const card = createCardHarness({ draftSelections: { choice: "Second" } });
  const tree = card.render({
    deadlineAt: Date.now() + 60_000,
    onSubmit: async (answers) => {
      submitted.push(answers);
      return { ok: true };
    },
  });

  const optionButtons = findAll(
    tree,
    (node) => node.type === "button" && node.props?.role === "radio",
  );
  assert.equal(optionButtons.every((button) => button.props.disabled === false), true);
  const submitButton = findSubmitButton(tree);
  assert.equal(submitButton.props.disabled, false);
  submitButton.props.onClick();
  await flushPromises();

  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0], [
    {
      questionId: "choice",
      prompt: "Choose one option",
      selectedLabel: "Second",
    },
  ]);
});

test("multi-question selection auto-advances and preserves a mixed custom payload", async () => {
  const multiQuestions = [
    {
      id: "q1",
      header: "One",
      prompt: "Question one",
      options: [{ label: "A1" }, { label: "A2" }],
    },
    {
      id: "q2",
      header: "Two",
      prompt: "Question two",
      options: [{ label: "B1" }, { label: "B2" }],
    },
    {
      id: "q3",
      header: "Three",
      prompt: "Question three",
      options: [{ label: "C1" }, { label: "C2" }],
    },
  ];
  const submitted = [];
  const card = createCardHarness();
  const props = {
    questions: multiQuestions,
    deadlineAt: Date.now() + 60_000,
    onSubmit: async (answers) => {
      submitted.push(answers);
      return { ok: true };
    },
  };

  let tree = card.render(props);
  assert.equal(
    findAll(
      tree,
      (node) =>
        node.type === "button" && ["One", "Two", "Three"].includes(treeText(node)),
    ).length,
    3,
  );
  findAll(tree, (node) => node.type === "button" && node.props?.role === "radio")[1].props.onClick();

  tree = card.render(props);
  assert.match(treeText(tree), /Question two/);
  findAll(tree, (node) => node.type === "button" && node.props?.role === "radio")[0].props.onClick();

  tree = card.render(props);
  assert.match(treeText(tree), /Question three/);
  findAll(tree, (node) => node.type === "div" && node.props?.role === "radio")[0].props.onClick();

  tree = card.render(props);
  const customInput = findAll(tree, (node) => node.type === "input")[0];
  assert.ok(customInput);
  customInput.props.onChange({ currentTarget: { value: "Typed third answer" } });

  tree = card.render(props);
  const submitButton = findSubmitButton(tree);
  assert.equal(submitButton.props.disabled, false);
  submitButton.props.onClick();
  await flushPromises();

  assert.deepEqual(submitted, [
    [
      { questionId: "q1", prompt: "Question one", selectedLabel: "A2" },
      { questionId: "q2", prompt: "Question two", selectedLabel: "B1" },
      {
        questionId: "q3",
        prompt: "Question three",
        selectedLabel: "Typed third answer",
        custom: true,
      },
    ],
  ]);
});

test("submitting state blocks a second click until the first request settles", async () => {
  const gate = deferred();
  let submitCalls = 0;
  const card = createCardHarness({ draftSelections: { choice: "Second" } });
  const props = {
    deadlineAt: Date.now() + 60_000,
    onSubmit: async () => {
      submitCalls += 1;
      await gate.promise;
      return { ok: true };
    },
  };

  findSubmitButton(card.render(props)).props.onClick();
  await Promise.resolve();
  const submittingButton = findSubmitButton(card.render(props));
  assert.equal(submittingButton.props.disabled, true);
  assert.equal(submittingButton.props.children, "chat.askUser.submitting");
  submittingButton.props.onClick();
  assert.equal(submitCalls, 1);

  gate.resolve();
  await flushPromises();
  assert.equal(findSubmitButton(card.render(props)).props.disabled, false);
});

test("settled and cancelled cards remain read-only", () => {
  const settledCard = createCardHarness();
  const settled = settledCard.render({
    deadlineAt: Date.now() + 60_000,
    answers: [
      {
        questionId: "choice",
        prompt: "Choose one option",
        selectedLabel: "Second",
      },
    ],
  });
  assert.equal(
    findAll(settled, (node) => node.type === "button" && node.props?.role === "radio").every(
      (button) => button.props.disabled === true,
    ),
    true,
  );
  assert.equal(findSubmitButton(settled), undefined);

  const cancelledCard = createCardHarness();
  const cancelled = cancelledCard.render({
    deadlineAt: Date.now() + 60_000,
    cancelled: true,
  });
  assert.equal(
    findAll(cancelled, (node) => node.type === "button" && node.props?.role === "radio").every(
      (button) => button.props.disabled === true,
    ),
    true,
  );
  assert.equal(findSubmitButton(cancelled), undefined);
});
