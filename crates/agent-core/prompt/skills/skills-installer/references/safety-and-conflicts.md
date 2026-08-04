# Safety and Conflicts

Use this reference before installing or replacing LiveAgent skills.

## Conflict Modes

- `backup`: default. Move the existing target into the hidden backup area, then copy the new skill.
- `fail`: stop when the target already exists.
- `overwrite`: delete the existing target, then copy the new skill. Use only after explicit confirmation.

If an install fails after a backup, keep the backup directory and report its path.

## Safety Checks

- Reject absolute or parent-traversing paths inside zip archives.
- Require every installed source to contain `SKILL.md`, `skill.md`, `skill.json`, or fallback `README.md`.
- Parse `name` and `description` before installing. For `README.md` without frontmatter, LiveAgent derives the skill name from the directory and loads the full README when enabled.
- Use the skill metadata name as the destination directory unless `name=` is supplied for a single-skill install.
- Never delete backup directories automatically.
- Do not manually edit LiveAgent Settings. SkillsManager automatically enables newly installed skills for the current conversation when installation succeeds.

## After Install

LiveAgent discovers skills through a scan of the fixed skills root. After an install, LiveAgent refreshes discovery; if the UI still has stale state:

1. Open Settings -> Skills and click scan/rescan, or reopen the chat Skills menu.
2. The new skill is already enabled for the current conversation; select it in Settings or the chat Skills menu only if it should remain enabled for future chats.
3. If it still does not appear, verify the installed directory contains valid metadata.
