//! 内置 Agent Skill：内嵌文件定义、修改保护与启动时种子写入。

use std::fs;
use std::io;
use std::path::Path;
use walkdir::WalkDir;

use super::*;

pub(crate) struct BuiltinSkillFile {
    pub(crate) path: &'static str,
    pub(crate) content: &'static str,
}

pub(crate) struct BuiltinSkill {
    pub(crate) name: &'static str,
    pub(crate) files: &'static [BuiltinSkillFile],
    pub(crate) ownership_marker: Option<(&'static str, &'static str)>,
}

const CODE_REVIEW_OWNERSHIP_MARKER_PATH: &str = "_liveagent_builtin.json";
const CODE_REVIEW_OWNERSHIP_MARKER_CONTENT: &str =
    "{\"schemaVersion\":1,\"owner\":\"LiveAgent\",\"skill\":\"liveagent-code-review\"}\n";

const SKILLS_INSTALLER_FILES: &[BuiltinSkillFile] = &[
    BuiltinSkillFile {
        path: "SKILL.md",
        content: include_str!("../../../prompt/skills/skills-installer/SKILL.md"),
    },
    BuiltinSkillFile {
        path: "references/install-sources.md",
        content: include_str!(
            "../../../prompt/skills/skills-installer/references/install-sources.md"
        ),
    },
    BuiltinSkillFile {
        path: "references/safety-and-conflicts.md",
        content: include_str!(
            "../../../prompt/skills/skills-installer/references/safety-and-conflicts.md"
        ),
    },
];

const SKILLS_CREATOR_FILES: &[BuiltinSkillFile] = &[
    BuiltinSkillFile {
        path: "SKILL.md",
        content: include_str!("../../../prompt/skills/skills-creator/SKILL.md"),
    },
    BuiltinSkillFile {
        path: "references/agent-skill-format.md",
        content: include_str!(
            "../../../prompt/skills/skills-creator/references/agent-skill-format.md"
        ),
    },
    BuiltinSkillFile {
        path: "references/authoring-patterns.md",
        content: include_str!(
            "../../../prompt/skills/skills-creator/references/authoring-patterns.md"
        ),
    },
];

const CODE_REVIEW_FILES: &[BuiltinSkillFile] = &[
    BuiltinSkillFile {
        path: "SKILL.md",
        content: include_str!("../../../prompt/skills/liveagent-code-review/SKILL.md"),
    },
    BuiltinSkillFile {
        path: CODE_REVIEW_OWNERSHIP_MARKER_PATH,
        content: CODE_REVIEW_OWNERSHIP_MARKER_CONTENT,
    },
];

pub(crate) const BUILTIN_AGENT_SKILLS: &[BuiltinSkill] = &[
    BuiltinSkill {
        name: "liveagent-code-review",
        files: CODE_REVIEW_FILES,
        ownership_marker: Some((
            CODE_REVIEW_OWNERSHIP_MARKER_PATH,
            CODE_REVIEW_OWNERSHIP_MARKER_CONTENT,
        )),
    },
    BuiltinSkill {
        name: "skills-installer",
        files: SKILLS_INSTALLER_FILES,
        ownership_marker: None,
    },
    BuiltinSkill {
        name: "skills-creator",
        files: SKILLS_CREATOR_FILES,
        ownership_marker: None,
    },
];

fn builtin_agent_skill(name: &str) -> Option<&'static BuiltinSkill> {
    BUILTIN_AGENT_SKILLS
        .iter()
        .find(|skill| skill.name.eq_ignore_ascii_case(name))
}

fn builtin_skill_owns_target(target: &Path, builtin: &BuiltinSkill) -> Result<bool, String> {
    let Some((marker_path, expected_content)) = builtin.ownership_marker else {
        return Ok(true);
    };
    let marker_path = sanitize_skill_child_rel_path(marker_path)?;
    let marker = target.join(marker_path);
    match fs::read_to_string(&marker) {
        Ok(content) => Ok(content == expected_content),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "Failed to inspect built-in Skill ownership marker {}: {error}",
            marker.display()
        )),
    }
}

pub(crate) fn is_managed_builtin_skill_dir(skill_dir: &Path, name: &str) -> bool {
    builtin_agent_skill(name)
        .and_then(|builtin| builtin_skill_owns_target(skill_dir, builtin).ok())
        .unwrap_or(false)
}

pub(crate) fn ensure_not_builtin_skill_management_target(
    root: &Path,
    name: &str,
    action: &str,
) -> Result<(), String> {
    let Some(builtin) = builtin_agent_skill(name) else {
        return Ok(());
    };
    let target = root.join(name);
    let is_protected = !target.exists() || builtin_skill_owns_target(&target, builtin)?;
    if is_protected {
        return Err(format!(
            "SkillsManager action={action} cannot modify built-in Skill \"{name}\". Built-in Skills are managed by LiveAgent; create or update a separate user Skill instead."
        ));
    }
    Ok(())
}

pub fn ensure_builtin_agent_skills_sync() -> Result<Vec<SystemBuiltinSkillSeedResponse>, String> {
    let root = skills_root_dir()?;
    ensure_builtin_agent_skills_in_root(&root)
}

pub(crate) fn builtin_skill_files_match(
    target: &Path,
    builtin: &BuiltinSkill,
) -> Result<bool, String> {
    let mut actual_files = Vec::new();
    for entry in WalkDir::new(target).follow_links(false).min_depth(1) {
        let entry = entry.map_err(|e| format!("Failed to inspect built-in Skill: {e}"))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(target)
            .map_err(|e| format!("Failed to compute built-in Skill path: {e}"))?
            .to_string_lossy()
            .replace('\\', "/");
        actual_files.push(rel);
    }
    actual_files.sort();

    let mut expected_files = builtin
        .files
        .iter()
        .map(|file| {
            sanitize_skill_child_rel_path(file.path)
                .map(|path| path.to_string_lossy().replace('\\', "/"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    expected_files.sort();
    if actual_files != expected_files {
        return Ok(false);
    }

    for file in builtin.files {
        let rel = sanitize_skill_child_rel_path(file.path)?;
        let path = target.join(rel);
        match fs::read_to_string(&path) {
            Ok(content) if content == file.content => {}
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(format!(
                    "Failed to read built-in Skill file {}: {error}",
                    path.display()
                ));
            }
        }
    }
    Ok(true)
}

pub(crate) fn ensure_builtin_agent_skills_in_root(
    root: &Path,
) -> Result<Vec<SystemBuiltinSkillSeedResponse>, String> {
    // Seeding backs up and rewrites live skill directories in place, so it
    // must be serialized with every other skills-root writer.
    let _guard = skills_write_guard();
    fs::create_dir_all(root).map_err(|e| format!("Failed to create Skills root directory: {e}"))?;
    let mut results = Vec::new();
    for builtin in BUILTIN_AGENT_SKILLS {
        let name = sanitize_skill_name(builtin.name)?;
        let target = root.join(&name);
        let mut backup = None;
        let mut write_action = "created";

        if target.exists() {
            if builtin.ownership_marker.is_some() && !builtin_skill_owns_target(&target, builtin)? {
                results.push(SystemBuiltinSkillSeedResponse {
                    name,
                    target: display_path(&target),
                    action: "conflict_preserved".to_string(),
                    backup: None,
                });
                continue;
            }
            let validation = validate_skill_dir(&target);
            let valid_same_name = validation.ok
                && validation
                    .metadata
                    .as_ref()
                    .map(|metadata| metadata.name == name)
                    .unwrap_or(false);
            if valid_same_name {
                if builtin_skill_files_match(&target, builtin)? {
                    results.push(SystemBuiltinSkillSeedResponse {
                        name,
                        target: display_path(&target),
                        action: "kept".to_string(),
                        backup: None,
                    });
                    continue;
                }
                write_action = "updated";
            } else {
                write_action = "replaced_invalid";
            }
            backup = Some(backup_existing_path(&root, &target, &name)?);
        }

        fs::create_dir_all(&target)
            .map_err(|e| format!("Failed to create built-in Skill directory: {e}"))?;
        for file in builtin.files {
            let rel = sanitize_skill_child_rel_path(file.path)?;
            let path = target.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create built-in Skill parent: {e}"))?;
            }
            fs::write(&path, file.content).map_err(|e| {
                format!(
                    "Failed to write built-in Skill file {}: {e}",
                    path.display()
                )
            })?;
        }
        let validation = validate_skill_dir(&target);
        if !validation.ok {
            return Err(format!(
                "Built-in Skill '{}' did not validate after seeding:\n{}",
                builtin.name,
                validation.errors.join("\n")
            ));
        }
        results.push(SystemBuiltinSkillSeedResponse {
            name,
            target: display_path(&target),
            action: write_action.to_string(),
            backup: backup.map(|path| display_path(&path)),
        });
    }
    Ok(results)
}
