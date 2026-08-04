//! 扫描本机其他 CLI 工具（Claude Code / Codex / CodeBuddy）已安装的 Skills，
//! 供 UI 展示后由用户勾选导入（导入本身复用既有 install 动作，source = 技能目录）。

use super::library::discover_skill_dirs;
use super::metadata::{read_skill_metadata_from_dir, standard_metadata_file_for};
use super::types::{SystemExternalSkillEntry, SystemExternalToolScan};
use crate::runtime::platform::expand_tilde_path;

const EXTERNAL_TOOL_ROOTS: &[(&str, &str)] = &[
    ("claude-code", "~/.claude/skills"),
    ("codex", "~/.codex/skills"),
    // CodeBuddy 的技能市场缓存目录：可能包含未安装的技能，由 UI 提示用户。
    ("codebuddy", "~/.codebuddy/skills-marketplace/skills"),
];

pub(crate) fn scan_external_skills() -> Vec<SystemExternalToolScan> {
    EXTERNAL_TOOL_ROOTS
        .iter()
        .map(|(tool, raw_root)| {
            let root = expand_tilde_path(raw_root);
            let exists = root.is_dir();
            let mut skills = Vec::new();
            let mut errors = Vec::new();
            if exists {
                for dir in discover_skill_dirs(&root) {
                    // 仅接受带标准元数据（skill.json / SKILL.md / skill.md）的技能：
                    // 纯 README 回退的目录名会在 install 的暂存目录校验中必然失败。
                    if standard_metadata_file_for(&dir).is_none() {
                        errors.push(format!(
                            "No SKILL.md, skill.md, or skill.json found in {}",
                            dir.display()
                        ));
                        continue;
                    }
                    match read_skill_metadata_from_dir(&dir) {
                        Ok(meta) => skills.push(SystemExternalSkillEntry {
                            name: meta.name,
                            description: meta.description,
                            base_dir: dir.display().to_string(),
                            skill_file: meta.metadata_file.display().to_string(),
                        }),
                        Err(err) => errors.push(err),
                    }
                }
                skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            }
            SystemExternalToolScan {
                tool: (*tool).to_string(),
                root_dir: (*raw_root).to_string(),
                exists,
                skills,
                errors,
            }
        })
        .collect()
}
