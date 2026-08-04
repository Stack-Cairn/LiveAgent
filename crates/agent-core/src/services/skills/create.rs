//! 创建 Skill：SKILL.md 模板渲染与 create payload 编排。

use serde_json::Value;
use std::fs;
use std::path::Path;

use super::*;

pub(crate) fn yaml_quote(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{escaped}\"")
}

pub(crate) fn render_skill_template(name: &str, description: &str, body: Option<&str>) -> String {
    let body = body.map(str::trim).filter(|value| !value.is_empty());
    let rendered_body = body.map_or_else(
        || {
            format!(
                "# {}\n\n> Prefer English for skill documentation so it stays broadly reusable; other languages are accepted.\n\n## Workflow\n\n1. Inspect the user's request and gather the required context.\n2. Follow the workflow this skill is meant to capture.\n3. Validate the result and report changed files or outputs.\n",
                title_case_skill_name(name)
            )
        },
        |value| value.to_string(),
    );
    format!(
        "---\nname: {name}\ndescription: {}\n---\n\n{}\n",
        yaml_quote(description),
        rendered_body
    )
}

pub(crate) fn create_skill_from_payload(
    root: &Path,
    payload: &serde_json::Map<String, Value>,
) -> Result<SystemSkillInstallResult, String> {
    let raw_name = object_string(payload, "name")
        .ok_or_else(|| "SkillsManager create requires name".to_string())?;
    let normalized = normalize_skill_name(raw_name);
    let name = sanitize_skill_name(&normalized)?;
    ensure_not_builtin_skill_management_target(root, &name, "create")?;
    let description = object_string(payload, "description")
        .ok_or_else(|| "SkillsManager create requires description".to_string())?
        .trim()
        .to_string();
    if description.len() > MAX_SKILL_DESCRIPTION_LENGTH {
        return Err(format!(
            "Skill description is too long; maximum is {MAX_SKILL_DESCRIPTION_LENGTH}"
        ));
    }
    let body = object_string(payload, "body");
    let conflict = normalize_conflict(object_string(payload, "conflict"), "fail")?;

    let tmp = TempDir::new("liveagent-skill-create")?;
    let source_dir = tmp.path().join(&name);
    fs::create_dir_all(&source_dir)
        .map_err(|e| format!("Failed to create staged Skill directory: {e}"))?;
    fs::write(
        source_dir.join("SKILL.md"),
        render_skill_template(&name, &description, body),
    )
    .map_err(|e| format!("Failed to write staged SKILL.md: {e}"))?;

    if let Some(files) = payload.get("files") {
        let files = files
            .as_array()
            .ok_or_else(|| "SkillsManager create files must be an array".to_string())?;
        for file in files {
            let file = file
                .as_object()
                .ok_or_else(|| "SkillsManager create file entries must be objects".to_string())?;
            let rel = object_string(file, "path")
                .ok_or_else(|| "SkillsManager create file.path is required".to_string())?;
            let rel_path = sanitize_skill_child_rel_path(rel)?;
            if is_skill_metadata_candidate(&rel_path) {
                return Err("Use name/description/body to create SKILL.md; files must not replace Skill metadata".to_string());
            }
            let content = file
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| "SkillsManager create file.content is required".to_string())?;
            if content.len() as u64 > MAX_SKILL_FILE_BYTES {
                return Err(format!("Skill file is too large: {rel}"));
            }
            let target = source_dir.join(rel_path);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create staged Skill file parent: {e}"))?;
            }
            fs::write(&target, content).map_err(|e| {
                format!(
                    "Failed to write staged Skill file {}: {e}",
                    target.display()
                )
            })?;
        }
    }

    let validation = validate_skill_dir(&source_dir);
    if !validation.ok {
        return Err(format!(
            "Created Skill did not validate:\n{}",
            validation.errors.join("\n")
        ));
    }

    install_skill_dir(root, &source_dir, &name, &conflict, None)
}
