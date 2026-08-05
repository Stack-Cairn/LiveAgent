# Authoring Patterns

Use these patterns when shaping a LiveAgent skill.

## Workflow Skill

Use this when the task has a fixed sequence.

```markdown
## Workflow

1. Inspect the input artifact.
2. Choose the relevant reference file.
3. Use the relevant `SkillsManager` action.
4. Validate the output.
5. Report the result and changed files.
```

## Decision Skill

Use this when the skill branches by source type, file type, provider, or project state.

```markdown
## Workflow

1. Determine the source type:
   - Local file: follow "Local workflow".
   - Remote URL: follow "Remote workflow".
2. Execute the selected workflow.
3. Validate and report.
```

## Managed Skill

Use `SkillsManager` for LiveAgent skill operations instead of bundling helper scripts.

- Use `SkillsManager(action=create)` for runtime skill creation.
- Use `SkillsManager(action=install)` for local, archive, HTTP, or GitHub imports.
- Use `SkillsManager(action=clawhub_search)` and `SkillsManager(action=clawhub_install)` for ClawHub store discovery and installation.
- Use `SkillsManager(action=list)` to review the skills enabled in the current conversation before upgrades or conflict-sensitive changes.
- Use `SkillsManager(action=validate)` before packaging.
- Use `SkillsManager(action=package)` only after validation passes.

## Reference Skill

Use `references/` when details are long or conditional.

- Link each reference directly from `SKILL.md`.
- Include search hints or section names for long references.
- Avoid duplicating the same instructions in both `SKILL.md` and references.
- Do not create `README.md` or installation guide files inside the skill.
