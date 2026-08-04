# LiveAgent Skill Format

Use this reference when writing or reviewing a LiveAgent-compatible skill.

## Language

- Prefer English for skill documentation (`SKILL.md`, Markdown files in `references/`, example documentation) so skills stay broadly reusable; other languages are accepted, so follow the user's preference when they state one.
- Keep code identifiers, filenames, shell commands, URLs, API names, and literal values unchanged when they are part of the workflow.

## Discovery Model

- LiveAgent discovers runtime skills from the fixed user Skills root managed by `SkillsManager`.
- `SkillsManager(action=create)` writes runtime skills under that fixed Skills root.
- The repository source copy for built-in project skills lives under `crates/agent-gui/src-tauri/prompt/skills/<skill-name>`, but that is not the runtime installation root.
- The runtime scanner accepts `SKILL.md`, `skill.md`, `skill.json`, and fallback `README.md`.
- Markdown skill entries should begin with YAML frontmatter containing `name` and `description`. `README.md` without frontmatter is supported only as an import/discovery fallback; LiveAgent derives the name from the directory and loads the full README when enabled.
- JSON skills must contain top-level string fields named `name` and `description`.
- The UI and chat runtime inject metadata only for normal skill entries. Fallback `README.md` entries without metadata are loaded inline because there is no metadata to disclose progressively.

## Directory Shape

```text
skill-name/
├── SKILL.md
├── references/
└── assets/
```

Only `SKILL.md` is required. Create optional directories only when they serve the skill:

- `references/` stores longer guidance that should be loaded only when needed.
- `assets/` stores output resources such as templates, icons, fonts, or boilerplate files.

## Frontmatter Rules

Use lowercase letters, digits, and hyphens for `name`.

```markdown
---
name: my-skill
description: Do a specific LiveAgent workflow. Use when the user asks for the exact tasks this skill supports.
---
```

The `description` is both the trigger text and the UI summary. Include what the skill does and when it should be used. Do not hide trigger conditions in the body because the body is loaded only after the skill is selected or read.

`allowed-tools` is accepted only as compatibility metadata when importing existing skills. LiveAgent currently enforces tool access through the chat Skills selector and runtime `SkillAccessPolicy`, not through per-skill frontmatter.

## Runtime Rules

- Relative paths inside a skill are resolved from the skill base directory. When inspecting or updating enabled skill files, use file tools with `skill://<baseDir>/...`, an absolute path returned by a tool, or the exact `pathRef` returned by a prior tool.
- Use `SkillsManager` actions for LiveAgent skill creation, installation, listing, validation, and packaging. Do not bundle Python helper scripts for these core workflows.
- If the skill needs reference or asset files, mention them from `SKILL.md` with exact relative paths.
- If a workflow writes outside the repository workspace, make that explicit and require the user to confirm the destination.
- Creating or installing into the fixed Skills root is an explicit `SkillsManager` action; do not silently write repository source copies.
