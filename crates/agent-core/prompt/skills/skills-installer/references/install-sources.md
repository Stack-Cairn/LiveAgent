# Install Sources

Use this reference to choose the right source handling path.

## ClawHub

Use ClawHub actions when the user asks to find or install a public skill from the ClawHub store:

```text
SkillsManager(action=clawhub_search, query=memory, limit=10)
SkillsManager(action=clawhub_install, slug=example-skill, conflict=backup)
```

`clawhub_search` returns store cards with a `slug`. Pass that exact slug to `clawhub_install`. Use `conflict=backup` by default for upgrades.

## Local Directory

A local source is valid when it is one of these shapes:

```text
my-skill/
└── SKILL.md
```

```text
readme-skill/
└── README.md
```

```text
skill-pack/
├── first-skill/
│   └── SKILL.md
└── second-skill/
    └── SKILL.md
```

```text
repo-root/
└── skills/
    └── my-skill/
        └── SKILL.md
```

The installer copies complete skill directories into the destination root. `README.md` is only a fallback when the same directory does not contain `SKILL.md`, `skill.md`, or `skill.json`; if the README has no metadata, LiveAgent loads the full README when that skill is enabled.

When the local source lives in the current chat workspace, pass it as a workspace-relative path such as `./my-skill`, `skills/my-skill`, or `./dist/my-skill.skill`. LiveAgent resolves workspace-relative paths, absolute workspace paths, `~/...`, `file://`, and `pathRef` values before copying the source into the fixed runtime Skills root.

## Archive

`.zip` and `.skill` files are treated as zip archives. The installer extracts them into a temporary directory, rejects paths that escape the extraction root, then detects one or more skill directories.

Supported archive layouts are the same as local directory layouts.

## GitHub URL

Use a GitHub tree URL when possible:

```text
https://github.com/owner/repo/tree/main/skills/my-skill
```

The installer first downloads the repository zip for public repositories. If download fails because the repository is private or inaccessible, `method=auto` falls back to git sparse checkout. Existing git credentials or environment-based credentials are reused; LiveAgent does not manage tokens.

Use `method=git` when download mode is not appropriate.

## HTTP(S) URL

HTTP(S) sources must point to a `.zip` / `.skill` archive or to a single `SKILL.md`, `skill.md`, or `skill.json` file. Archives use the same layouts as local directory sources.

## Destination

Runtime installation always targets LiveAgent's fixed user Skills root through `SkillsManager`. File tools do not use a `root` argument; when you need to inspect enabled Skill files, pass `skill://<baseDir>/...`, an absolute path returned by a tool, or the exact `pathRef` returned by a prior tool. Use separate staging roots only in tests or implementation validation, not in normal user workflows.
