import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const packs = loader.loadModule("@liveagent/ui/lib/skills/packs.ts");

const skill = (name, pack, extra = {}) => ({
  name,
  description: `${name} description`,
  baseDir: pack ? `${pack}/skills/${name}` : name,
  skillFile: pack ? `${pack}/skills/${name}/SKILL.md` : `${name}/SKILL.md`,
  ...(pack === undefined ? {} : { pack }),
  ...extra,
});

const LIST = [
  skill("local-notes", ""),
  skill("radare2", "reverse-skill"),
  skill("js-reverse", "reverse-skill"),
  skill("ida", "reverse-skill"),
  skill("radare2", "other-pack", { shadowed: true, shadowedBy: "reverse-skill/skills/radare2" }),
];

test("skill packs are detected only when the backend sends the pack field", () => {
  assert.equal(packs.skillPacksSupported(LIST), true);
  assert.equal(packs.skillPacksSupported([{ name: "a" }, { name: "b" }]), false);
  assert.equal(packs.skillPackName({ name: "a", pack: "" }), "");
  assert.equal(packs.skillPackName({ name: "a" }), "");
  assert.equal(packs.skillPackName({ name: "a", pack: "p" }), "p");
});

test("pack switches decide for every skill of a listed pack, names decide otherwise", () => {
  const byName = packs.effectiveSelectedSkillNames(LIST, {
    selected: ["local-notes", "radare2", "builtin-only"],
  });
  assert.deepEqual([...byName].sort(), ["builtin-only", "local-notes", "radare2"]);

  const packOn = packs.effectiveSelectedSkillNames(LIST, {
    selected: ["local-notes"],
    packs: { "reverse-skill": true },
  });
  assert.deepEqual([...packOn].sort(), ["ida", "js-reverse", "local-notes", "radare2"]);

  const packOff = packs.effectiveSelectedSkillNames(LIST, {
    selected: ["local-notes", "radare2"],
    packs: { "reverse-skill": false },
  });
  assert.deepEqual([...packOff], ["local-notes"], "a pack switched off wins over names");

  assert.equal(
    packs.isSkillEffectivelySelected(LIST[4], new Set(["radare2"]), { "other-pack": true }),
    false,
    "shadowed copies are never active",
  );
});

test("pack header state follows the switch, or the names of its skills", () => {
  const members = LIST.filter((item) => item.pack === "reverse-skill");
  assert.equal(packs.skillPackToggleState("reverse-skill", members, { selected: [] }), "off");
  assert.equal(
    packs.skillPackToggleState("reverse-skill", members, { selected: ["ida"] }),
    "mixed",
  );
  assert.equal(
    packs.skillPackToggleState("reverse-skill", members, {
      selected: ["ida", "radare2", "js-reverse"],
    }),
    "on",
  );
  assert.equal(
    packs.skillPackToggleState("reverse-skill", members, {
      selected: ["ida"],
      packs: { "reverse-skill": true },
    }),
    "on",
  );
  const grouped = packs.groupSkillsByPack(LIST);
  assert.deepEqual([...grouped.keys()], ["reverse-skill"], "shadowed-only packs have no members");
  assert.deepEqual(
    grouped.get("reverse-skill").map((item) => item.name),
    ["radare2", "js-reverse", "ida"],
  );
});

test("the pack switch replaces the names of its skills", () => {
  const members = LIST.filter((item) => item.pack === "reverse-skill");
  assert.deepEqual(
    packs.setSkillPackEnabled(
      { selected: ["local-notes", "ida"], packs: { keep: false } },
      "reverse-skill",
      members,
      true,
    ),
    { selected: ["local-notes"], packs: { keep: false, "reverse-skill": true } },
  );
  assert.deepEqual(
    packs.setSkillPackEnabled({ selected: ["ida"] }, "reverse-skill", members, false),
    { selected: [], packs: { "reverse-skill": false } },
  );
});

test("turning one pack skill off keeps its siblings on", () => {
  const next = packs.applySkillSelectionChanges(
    { selected: ["local-notes"], packs: { "reverse-skill": true, other: false } },
    LIST,
    new Map([["ida", false]]),
  );
  assert.deepEqual(next.packs, { other: false });
  assert.deepEqual([...next.selected].sort(), ["js-reverse", "local-notes", "radare2"]);

  const offPack = packs.applySkillSelectionChanges(
    { selected: ["radare2"], packs: { "reverse-skill": false } },
    LIST,
    new Map([["ida", true]]),
  );
  assert.deepEqual(offPack, { selected: ["ida"], packs: {} });

  const plain = packs.applySkillSelectionChanges(
    { selected: [] },
    LIST,
    new Map([["local-notes", true]]),
  );
  assert.deepEqual(plain, { selected: ["local-notes"] }, "no packs field when none was set");
});

test("deleting a pack drops its switch and the names of its skills", () => {
  const members = LIST.filter((item) => item.pack === "reverse-skill");
  assert.deepEqual(
    packs.removeSkillPackFromSelection(
      { selected: ["local-notes", "ida"], packs: { "reverse-skill": true } },
      "reverse-skill",
      members,
    ),
    { selected: ["local-notes"], packs: {} },
  );
  assert.deepEqual(
    packs.removeSkillPackFromSelection({ selected: ["ida"] }, "reverse-skill", members),
    { selected: [] },
  );
});

test("skills settings keep boolean pack switches only", () => {
  const settings = loader.loadModule("src/lib/settings/index.ts");
  const normalized = settings.normalizeSkillsSettings({
    enabled: true,
    selected: ["a"],
    packs: { "reverse-skill": true, off: false, junk: "yes", " ": true },
  });
  assert.deepEqual(normalized.packs, { "reverse-skill": true, off: false });
  assert.equal(settings.normalizeSkillsSettings({ enabled: true, selected: [] }).packs, undefined);
  assert.deepEqual(
    settings.normalizeSkillsSettings({ enabled: true, selected: [], packs: {} }).packs,
    {},
    "an empty map is kept so a cleared switch reaches the backend",
  );
  const updated = settings.updateSkills(settings.getDefaultSettings(), {
    packs: { "reverse-skill": false },
  });
  assert.deepEqual(updated.skills.packs, { "reverse-skill": false });
});

test("composer offers pack skills that are on and never shadowed copies", () => {
  const gui = createTsModuleLoader();
  const { kbrainComposerSkillsFromList } = gui.loadModule(
    "src/pages/chat/composer/useKBrainComposerSkills.ts",
  );
  const offered = kbrainComposerSkillsFromList({
    skills: LIST,
    settings: { selected: ["local-notes", "radare2"], packs: { "reverse-skill": true } },
  });
  assert.deepEqual(
    offered.map((item) => [item.name, item.pack ?? "", item.skillFile]),
    [
      ["local-notes", "", "local-notes/SKILL.md"],
      ["radare2", "reverse-skill", "reverse-skill/skills/radare2/SKILL.md"],
      ["js-reverse", "reverse-skill", "reverse-skill/skills/js-reverse/SKILL.md"],
      ["ida", "reverse-skill", "reverse-skill/skills/ida/SKILL.md"],
    ],
  );
  assert.deepEqual(
    kbrainComposerSkillsFromList({
      skills: LIST,
      settings: { selected: ["radare2", "local-notes"], packs: { "reverse-skill": false } },
    }).map((item) => item.name),
    ["local-notes"],
  );
});

async function kbrainFixture(t, capabilities) {
  const requests = [];
  let settings = { enabled: true, selected: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    requests.push({ method: req.method, path: url.pathname, body });
    const send = (value, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/v1/health") {
      return send({
        status: "ok",
        version: "kbrain.agent.v1",
        protocol: { name: "kbrain.agent", major: 1, minor: 1 },
        capabilities,
      });
    }
    if (url.pathname === "/v1/skills/settings") {
      if ("packs" in body && capabilities.skill_packs !== 1) {
        return send({ error: "unknown field packs" }, 400);
      }
      settings = body;
      return send({ settings });
    }
    if (url.pathname === "/v1/skills") {
      return send({
        rootDir: "/fixture/skills",
        skills: LIST.filter((item) => !item.shadowed),
        shadowed: LIST.filter((item) => item.shadowed),
        settings,
      });
    }
    send({ error: "unknown route" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const modules = createTsModuleLoader({
    mocks: {
      "@liveagent/app/lib/host": {
        isKBrainBackendEnabled: () => true,
        isKBrainBrowserHost: () => true,
        isTauriHost: () => false,
        kBrainOwnedDesktopCommand: () => true,
      },
    },
  });
  modules.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: "fixture-token",
    protocolVersion: "kbrain.agent.v1",
  });
  const host = modules.loadModule("@liveagent/ui/lib/resourceHost.ts");
  const adapter = modules
    .loadModule("src/agent-ui-adapters/kbrainSkills.ts")
    .createKbrainSkillsAdapter();
  host.configureResourceHostCapabilities({
    ...host.kbrainResourceHostCapabilities,
    skillsAdapter: adapter,
  });
  return {
    requests,
    adapter,
    skills: modules.loadModule("@liveagent/ui/lib/skills/index.ts"),
  };
}

test("pack switches reach K-brain only when it reports skill_packs", async (t) => {
  const modern = await kbrainFixture(t, { skill_packs: 1 });
  await modern.adapter.settings({ enabled: true, selected: [], packs: { "reverse-skill": true } });
  const sent = modern.requests.find((r) => r.path === "/v1/skills/settings");
  assert.deepEqual(sent.body, { enabled: true, selected: [], packs: { "reverse-skill": true } });

  const older = await kbrainFixture(t, {});
  const saved = await older.adapter.settings({
    enabled: true,
    selected: ["ida"],
    packs: { "reverse-skill": true },
  });
  assert.deepEqual(saved.settings, { enabled: true, selected: ["ida"] });
  const stripped = older.requests.find((r) => r.path === "/v1/skills/settings");
  assert.deepEqual(stripped.body, { enabled: true, selected: ["ida"] });

  await older.adapter.settings({ enabled: false, selected: [] });
  assert.equal(
    older.requests.filter((r) => r.path === "/v1/health").length,
    1,
    "settings without packs need no health check",
  );
});

test("discovery keeps shadowed pack skills apart from the active list", async (t) => {
  const f = await kbrainFixture(t, { skill_packs: 1 });
  const discovery = await f.skills.discoverSkills({ force: true });
  assert.deepEqual(
    discovery.skills.map((item) => [item.name, item.pack, item.baseDir]),
    [
      ["ida", "reverse-skill", "reverse-skill/skills/ida"],
      ["js-reverse", "reverse-skill", "reverse-skill/skills/js-reverse"],
      ["local-notes", "", "local-notes"],
      ["radare2", "reverse-skill", "reverse-skill/skills/radare2"],
    ],
  );
  assert.deepEqual(
    discovery.shadowed.map((item) => [item.name, item.pack, item.shadowedBy]),
    [["radare2", "other-pack", "reverse-skill/skills/radare2"]],
  );
});

function viewProps(overrides = {}) {
  return {
    items: LIST.filter((item) => !item.shadowed).map((item) => ({ skill: item, categories: [] })),
    skillsEnabled: true,
    selected: new Set(["local-notes", "radare2"]),
    bulkSelection: new Set(),
    categoryCounts: new Map(),
    rootDir: "/skills",
    loading: false,
    initialContentPending: false,
    bulkMode: false,
    hasSkills: true,
    loadError: null,
    category: "all",
    searchQuery: "",
    filter: "",
    deletingSkillName: null,
    onRescan: () => {},
    onToggle: () => {},
    onEnterBulkMode: () => {},
    onToggleBulkSelection: () => {},
    onBulkCardClick: () => {},
    onOpenPreview: () => {},
    onDelete: () => {},
    onSelectCategory: () => {},
    ...overrides,
  };
}

function collect(node, type, found = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, type, found);
    return found;
  }
  if (node.type === type) found.push(node);
  collect(node.props?.children, type, found);
  return found;
}

test("installed skills view groups pack skills under their pack", () => {
  const InstalledSkillCard = () => null;
  const SkillPackGroup = () => null;
  const view = createTsModuleLoader({
    mocks: {
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
      "./InstalledSkillCard": { InstalledSkillCard },
      "./SkillPackGroup": { SkillPackGroup },
    },
  }).loadModule("@liveagent/ui/pages/skills-hub/InstalledSkillsView.tsx");
  const togglePack = [];
  const packInfos = new Map([
    [
      "reverse-skill",
      { skillCount: 3, enabledCount: 1, toggleState: "mixed", shadowed: [] },
    ],
    ["other-pack", { skillCount: 0, enabledCount: 0, toggleState: "off", shadowed: [LIST[4]] }],
  ]);
  const tree = view.InstalledSkillsView(
    viewProps({ packs: packInfos, onTogglePack: (pack, on) => togglePack.push([pack, on]) }),
  );
  const groups = collect(tree, SkillPackGroup);
  assert.deepEqual(
    groups.map((group) => [group.props.pack, group.props.skillCount, group.props.toggleState]),
    [
      ["reverse-skill", 3, "mixed"],
      ["other-pack", 0, "off"],
    ],
  );
  const topLevelCards = collect(tree, InstalledSkillCard).filter(
    (card) => !groups.some((group) => collect(group.props.children, InstalledSkillCard).includes(card)),
  );
  assert.deepEqual(
    topLevelCards.map((card) => card.props.skill.name),
    ["local-notes"],
  );
  const packCards = collect(groups[0].props.children, InstalledSkillCard);
  assert.deepEqual(
    packCards.map((card) => [card.props.skill.name, card.props.checked]),
    [
      ["radare2", true],
      ["js-reverse", false],
      ["ida", false],
    ],
  );
  assert.deepEqual(groups[1].props.shadowed, [LIST[4]]);
  assert.equal(groups[0].props.forceExpanded, false);
  groups[0].props.onToggle("reverse-skill", true);
  assert.deepEqual(togglePack, [["reverse-skill", true]]);

  const filtered = view.InstalledSkillsView(
    viewProps({
      packs: packInfos,
      filter: "ida",
      items: [{ skill: LIST[3], categories: [] }],
    }),
  );
  const filteredGroups = collect(filtered, SkillPackGroup);
  assert.deepEqual(
    filteredGroups.map((group) => [group.props.pack, group.props.forceExpanded]),
    [["reverse-skill", true]],
    "while filtering only packs with matches show, opened",
  );

  const flat = view.InstalledSkillsView(viewProps());
  assert.equal(collect(flat, SkillPackGroup).length, 0, "no grouping without pack info");
  assert.equal(collect(flat, InstalledSkillCard).length, 4);
});
