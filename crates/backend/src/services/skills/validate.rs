//! Skill 校验：目录结构与元数据约束。

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use walkdir::WalkDir;

use super::*;

pub(crate) fn validate_skill_dir(skill_dir: &Path) -> SkillValidationResult {
    let mut errors = Vec::new();
    if !skill_dir.exists() {
        return SkillValidationResult {
            ok: false,
            errors: vec![format!(
                "Skill directory not found: {}",
                skill_dir.display()
            )],
            metadata: None,
        };
    }
    if !skill_dir.is_dir() {
        return SkillValidationResult {
            ok: false,
            errors: vec![format!("Path is not a directory: {}", skill_dir.display())],
            metadata: None,
        };
    }

    let skill_md = skill_dir.join("SKILL.md");
    let metadata_file = if skill_md.is_file() {
        skill_md
    } else {
        match metadata_file_for(skill_dir) {
            Some(path) => path,
            None => {
                return SkillValidationResult {
                    ok: false,
                    errors: vec![
                        "SKILL.md, skill.md, skill.json, or README.md not found".to_string()
                    ],
                    metadata: None,
                };
            }
        }
    };

    let mut metadata = None;
    let mut metadata_from_plain_readme = false;
    if is_skill_json(&metadata_file) {
        match fs::read_to_string(&metadata_file)
            .map_err(|e| e.to_string())
            .and_then(|content| {
                let parsed = parse_skill_json_metadata(&content);
                let name = parsed
                    .name
                    .ok_or_else(|| "Missing 'name' in skill.json".to_string())?;
                let description = parsed
                    .description
                    .ok_or_else(|| "Missing 'description' in skill.json".to_string())?;
                Ok(SkillMetadata {
                    name,
                    description,
                    metadata_file: metadata_file.clone(),
                })
            }) {
            Ok(value) => metadata = Some(value),
            Err(error) => errors.push(error),
        }
    } else {
        match fs::read_to_string(&metadata_file)
            .map_err(|e| format!("Failed to read {}: {e}", metadata_file.display()))
            .and_then(|content| {
                let frontmatter = split_frontmatter(&content);
                let (yaml, has_frontmatter) = match frontmatter {
                    Ok((yaml, _body)) => (Some(yaml), true),
                    Err(error)
                        if is_readme_markdown(&metadata_file)
                            && is_missing_frontmatter_error(&error) =>
                    {
                        (None, false)
                    }
                    Err(error) => return Err(error),
                };

                if let Some(yaml) = yaml {
                    let keys = frontmatter_keys(&yaml);
                    let allowed = [
                        "name",
                        "description",
                        "license",
                        "allowed-tools",
                        "metadata",
                    ];
                    let unexpected = keys
                        .iter()
                        .filter(|key| !allowed.contains(&key.as_str()))
                        .cloned()
                        .collect::<Vec<_>>();
                    if !unexpected.is_empty() {
                        errors.push(format!(
                            "Unexpected key(s) in Skill frontmatter: {}",
                            unexpected.join(", ")
                        ));
                    }
                    let parsed = parse_skill_frontmatter_yaml_metadata(&yaml);
                    if is_readme_markdown(&metadata_file)
                        && parsed.name.is_none()
                        && parsed.description.is_none()
                    {
                        metadata_from_plain_readme = true;
                        let name = fallback_readme_skill_name(skill_dir)?;
                        let description = first_readme_description_line(&content)
                            .unwrap_or_else(|| format!("README.md skill instructions for {name}"))
                            .chars()
                            .take(MAX_SKILL_DESCRIPTION_LENGTH)
                            .collect();
                        return Ok(SkillMetadata {
                            name,
                            description,
                            metadata_file: metadata_file.clone(),
                        });
                    }
                    let name = parsed
                        .name
                        .ok_or_else(|| "Missing 'name' in frontmatter".to_string())?;
                    let description = parsed
                        .description
                        .ok_or_else(|| "Missing 'description' in frontmatter".to_string())?;
                    return Ok(SkillMetadata {
                        name,
                        description,
                        metadata_file: metadata_file.clone(),
                    });
                }

                if !has_frontmatter && is_readme_markdown(&metadata_file) {
                    metadata_from_plain_readme = true;
                    let name = fallback_readme_skill_name(skill_dir)?;
                    let description = first_readme_description_line(&content)
                        .unwrap_or_else(|| format!("README.md skill instructions for {name}"))
                        .chars()
                        .take(MAX_SKILL_DESCRIPTION_LENGTH)
                        .collect();
                    return Ok(SkillMetadata {
                        name,
                        description,
                        metadata_file: metadata_file.clone(),
                    });
                }

                Err("Missing Skill metadata".to_string())
            }) {
            Ok(value) => metadata = Some(value),
            Err(error) => errors.push(error),
        }
    }

    if let Some(metadata) = metadata.as_ref() {
        if let Err(error) = sanitize_skill_name(&metadata.name) {
            errors.push(error);
        }
        if metadata.description.contains('<') || metadata.description.contains('>') {
            errors.push("Description cannot contain angle brackets (< or >)".to_string());
        }
        if metadata.description.len() > MAX_SKILL_DESCRIPTION_LENGTH {
            errors.push(format!(
                "Description is too long; maximum is {MAX_SKILL_DESCRIPTION_LENGTH}"
            ));
        }
        let dir_name = skill_dir
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        if !metadata_from_plain_readme && dir_name != metadata.name {
            errors.push(format!(
                "Directory name '{dir_name}' must match frontmatter name '{}'",
                metadata.name
            ));
        }
    }

    for entry in WalkDir::new(skill_dir).follow_links(false).min_depth(1) {
        let Ok(entry) = entry else {
            continue;
        };
        if entry.file_type().is_symlink() {
            errors.push(format!(
                "Symlink is not allowed inside a Skill: {}",
                entry.path().display()
            ));
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(skill_dir).unwrap_or(entry.path());
        if matches!(
            entry.file_name().to_string_lossy().as_ref(),
            "README.md" | "INSTALLATION_GUIDE.md" | "QUICK_REFERENCE.md" | "CHANGELOG.md"
        ) && entry.path() != metadata_file
        {
            errors.push(format!(
                "Forbidden documentation file found: {}",
                rel.to_string_lossy()
            ));
        }
        let ext = entry
            .path()
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase());
        if matches!(ext.as_deref(), Some("py" | "sh" | "bash")) {
            match fs::File::open(entry.path()) {
                Ok(file) => {
                    let mut reader = BufReader::new(file);
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_ok() && !line.starts_with("#!") {
                        errors.push(format!(
                            "Script file lacks a shebang: {}",
                            rel.to_string_lossy()
                        ));
                    }
                }
                Err(error) => errors.push(format!(
                    "Failed to inspect script file {}: {error}",
                    rel.to_string_lossy()
                )),
            }
        }
    }

    SkillValidationResult {
        ok: errors.is_empty(),
        errors,
        metadata,
    }
}

pub(crate) fn validate_installed_skill(
    root: &Path,
    name: &str,
) -> Result<SystemSkillValidationResponse, String> {
    let name = sanitize_skill_name(name)?;
    let target = root.join(&name);
    let validation = validate_skill_dir(&target);
    Ok(SystemSkillValidationResponse {
        name,
        target: display_path(&target),
        ok: validation.ok,
        errors: validation.errors,
    })
}
