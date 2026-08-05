---
name: skills-creator
description: Create or update LiveAgent runtime skills. Use when you need to summarize a workflow into a skill, write it into the fixed user skills root, validate it, package it, or refine a skill's references for LiveAgent's SkillsManager flow.
---

# Skills Creator

Create LiveAgent-compatible skills in the fixed runtime skills root by keeping the entrypoint concise, moving long guidance into references, and using helper files only when the workflow truly needs them. Prefer English for generated skill documentation so skills stay broadly reusable, but other languages are accepted.

## Workflow

1. Confirm the target skill name, trigger description, captured workflow, and any required reference/helper files.
2. Read `references/agent-skill-format.md` and `references/authoring-patterns.md` through file tools before shaping long instructions. Use `path="skill://skills-creator/references/agent-skill-format.md"` and `path="skill://skills-creator/references/authoring-patterns.md"`, or use the exact `pathRef` returned by a prior tool.
3. Draft the `SKILL.md` body in imperative form. Keep frontmatter to `name` and `description` unless a compatibility reason requires an optional key.
4. Move deterministic or reusable details into `files` only when they are truly needed; keep explanatory material in `references/`; keep output-only resources in `assets/`.
5. Use `SkillsManager(action=create)` to write the skill into the fixed user skills root. Keep `conflict=fail` unless the user explicitly wants replacement.
6. Use `SkillsManager(action=validate)` after creation. Fix validation errors before packaging.
7. Use `SkillsManager(action=package)` only after validation passes and a distributable archive is required.
8. After creation, the new skill is enabled for the current conversation automatically; ask LiveAgent to rescan skills or reopen the Skills menu only if the new skill does not appear immediately.

## Rules

- Keep one skill per directory.
- Name the directory exactly after the skill name.
- Prefer English for generated skill documents, including `SKILL.md`, Markdown files in `references/`, and example documentation; follow the user's language preference when they state one.
- Do not add README-style files such as `README.md`, `INSTALLATION_GUIDE.md`, `QUICK_REFERENCE.md`, or `CHANGELOG.md` inside a skill.
- Prefer one-hop references from `SKILL.md`; do not build deep reference chains.
- Keep the `SKILL.md` body short enough to read comfortably through `SkillsManager`.
- When inspecting or optimizing files inside an enabled installed skill, use `Read`, `List`, `Glob`, `Grep`, `Write`, `Edit`, or `Delete` with the exact path you see: prefer `skill://<baseDir>/...` or a `pathRef` returned by a tool. Do not use Bash for workspace or Skill file operations.
- Create new skill directories through `SkillsManager(action=create)` or `SkillsManager(action=install)`. Use `conflict=backup` or `conflict=overwrite` only when the user has accepted replacement.
- Creating a skill automatically enables it for the current conversation.

## Commands

```bash
SkillsManager(action=create, name=my-skill, description=..., body=...)
SkillsManager(action=validate, name=my-skill)
SkillsManager(action=package, name=my-skill)
```
