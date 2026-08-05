//! Skill 元数据：frontmatter / skill.json 解析、README 回退与元数据文件定位。

use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::*;

const SKILL_METADATA_MAX_BYTES: usize = 200 * 1024; // 200KB

pub(crate) fn is_skill_markdown(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().eq_ignore_ascii_case("skill.md"))
        .unwrap_or(false)
}

pub(crate) fn is_readme_markdown(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().eq_ignore_ascii_case("README.md"))
        .unwrap_or(false)
}

pub(crate) fn is_skill_json(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().eq_ignore_ascii_case("skill.json"))
        .unwrap_or(false)
}

pub(crate) fn standard_metadata_file_for(skill_dir: &Path) -> Option<PathBuf> {
    for name in ["skill.json", "SKILL.md", "skill.md"] {
        let candidate = skill_dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let entries = fs::read_dir(skill_dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path();
        if candidate.is_file()
            && candidate
                .file_name()
                .map(|name| {
                    let name = name.to_string_lossy();
                    name.eq_ignore_ascii_case("skill.json") || name.eq_ignore_ascii_case("skill.md")
                })
                .unwrap_or(false)
        {
            return Some(candidate);
        }
    }
    None
}

pub(crate) fn is_skill_metadata_candidate(path: &Path) -> bool {
    is_skill_markdown(path) || is_skill_json(path) || is_readme_markdown(path)
}

pub(crate) fn unquote_yaml_scalar(raw: &str) -> String {
    let value = raw.trim();
    if value.len() >= 2 {
        let quoted_with_double = value.starts_with('"') && value.ends_with('"');
        let quoted_with_single = value.starts_with('\'') && value.ends_with('\'');
        if quoted_with_double || quoted_with_single {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

pub(crate) fn normalize_skill_metadata_value(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

pub(crate) fn parse_yaml_top_level_scalar(yaml: &str, key: &str) -> Option<String> {
    if !yaml.contains('\n') {
        return parse_inline_yaml_top_level_scalar(yaml, key);
    }

    let lines: Vec<&str> = yaml.lines().collect();
    let prefix = format!("{key}:");
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let Some(rest) = line.strip_prefix(&prefix) else {
            i += 1;
            continue;
        };

        let rest = rest.trim();
        if rest == "|" || rest == ">" {
            i += 1;
            let mut block = Vec::new();
            while i < lines.len() {
                let block_line = lines[i];
                let is_indented = block_line
                    .chars()
                    .next()
                    .map(char::is_whitespace)
                    .unwrap_or(false);
                if !is_indented {
                    break;
                }
                block.push(block_line.trim_start().to_string());
                i += 1;
            }
            return Some(block.join("\n"));
        }

        return Some(unquote_yaml_scalar(rest));
    }

    None
}

pub(crate) fn inline_yaml_key_start(yaml: &str, key: &str) -> Option<usize> {
    let prefix = format!("{key}:");
    yaml.match_indices(&prefix).find_map(|(index, _)| {
        let is_boundary = index == 0
            || yaml[..index]
                .chars()
                .next_back()
                .map(char::is_whitespace)
                .unwrap_or(false);
        is_boundary.then_some(index)
    })
}

pub(crate) fn parse_inline_yaml_top_level_scalar(yaml: &str, key: &str) -> Option<String> {
    let start = inline_yaml_key_start(yaml, key)? + key.len() + 1;
    let mut end = yaml.len();
    for other in [
        "name",
        "description",
        "license",
        "allowed-tools",
        "metadata",
    ] {
        if other == key {
            continue;
        }
        if let Some(next) = inline_yaml_key_start(&yaml[start..], other) {
            end = end.min(start + next);
        }
    }
    Some(unquote_yaml_scalar(yaml[start..end].trim()))
}

pub(crate) fn parse_skill_frontmatter_yaml_metadata(yaml: &str) -> SystemReadSkillMetadataResponse {
    let name = parse_yaml_top_level_scalar(yaml, "name");
    let description = parse_yaml_top_level_scalar(yaml, "description");

    SystemReadSkillMetadataResponse {
        name: normalize_skill_metadata_value(name),
        description: normalize_skill_metadata_value(description),
    }
}

pub(crate) fn parse_skill_json_metadata(json_text: &str) -> SystemReadSkillMetadataResponse {
    let Ok(parsed) = serde_json::from_str::<Value>(strip_utf8_bom(json_text)) else {
        return SystemReadSkillMetadataResponse {
            name: None,
            description: None,
        };
    };

    let name = parsed
        .get("name")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let description = parsed
        .get("description")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    SystemReadSkillMetadataResponse {
        name: normalize_skill_metadata_value(name),
        description: normalize_skill_metadata_value(description),
    }
}

pub(crate) fn empty_skill_metadata_response() -> SystemReadSkillMetadataResponse {
    SystemReadSkillMetadataResponse {
        name: None,
        description: None,
    }
}

pub(crate) fn is_missing_frontmatter_error(error: &str) -> bool {
    error == "Skill frontmatter must start with ---"
}

pub(crate) fn fallback_readme_skill_name(skill_dir: &Path) -> Result<String, String> {
    let raw = skill_dir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "readme-skill".to_string());
    let normalized = normalize_skill_name(&raw);
    sanitize_skill_name(&normalized)
}

pub(crate) fn first_readme_description_line(content: &str) -> Option<String> {
    strip_utf8_bom(content).lines().find_map(|line| {
        let mut value = line.trim();
        if value.is_empty() {
            return None;
        }
        if value == "---" {
            return None;
        }
        value = value.trim_start_matches('#').trim();
        if value.is_empty() {
            return None;
        }
        let value = value
            .trim_matches(|ch: char| ch == '*' || ch == '_' || ch == '`')
            .trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

pub(crate) fn fallback_readme_description(
    readme_file: &Path,
    name: &str,
) -> Result<String, String> {
    let content = fs::read_to_string(readme_file)
        .map_err(|e| format!("Failed to read README.md fallback: {e}"))?;
    let description = first_readme_description_line(&content)
        .unwrap_or_else(|| format!("README.md skill instructions for {name}"));
    Ok(description
        .chars()
        .take(MAX_SKILL_DESCRIPTION_LENGTH)
        .collect())
}

pub(crate) fn read_skill_markdown_frontmatter_yaml<R: BufRead>(
    reader: &mut R,
) -> Result<String, String> {
    let mut buf = Vec::new();
    let mut yaml = String::new();
    let mut is_first_line = true;

    loop {
        buf.clear();
        let n = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("Failed to read Skill file: {e}"))?;
        if n == 0 {
            return Err("Skill frontmatter must start with ---".to_string());
        }

        let line = String::from_utf8_lossy(&buf).to_string();
        let line = if is_first_line {
            is_first_line = false;
            strip_utf8_bom(&line).to_string()
        } else {
            line
        };

        if line.trim().is_empty() {
            continue;
        }

        if line.trim() != "---" {
            if let Some((yaml, _body)) = split_inline_frontmatter(&line) {
                return Ok(yaml);
            }
            return Err("Skill frontmatter must start with ---".to_string());
        }
        break;
    }

    let mut found_end = false;
    loop {
        buf.clear();
        let n = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("Failed to read Skill file: {e}"))?;
        if n == 0 {
            break;
        }

        let line = String::from_utf8_lossy(&buf);
        if yaml.len().saturating_add(line.len()) > SKILL_METADATA_MAX_BYTES {
            return Err(format!(
                "Skill frontmatter is too large, over {} bytes",
                SKILL_METADATA_MAX_BYTES
            ));
        }

        if line.trim() == "---" {
            found_end = true;
            break;
        }
        yaml.push_str(&line);
    }

    if !found_end {
        return Err("Skill frontmatter is missing closing ---".to_string());
    }

    Ok(yaml)
}

pub(crate) fn metadata_file_for(skill_dir: &Path) -> Option<PathBuf> {
    if let Some(candidate) = standard_metadata_file_for(skill_dir) {
        return Some(candidate);
    }
    let readme = skill_dir.join("README.md");
    if readme.is_file() {
        return Some(readme);
    }
    let entries = fs::read_dir(skill_dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path();
        if candidate.is_file()
            && candidate
                .file_name()
                .map(|name| {
                    let name = name.to_string_lossy();
                    name.eq_ignore_ascii_case("README.md")
                })
                .unwrap_or(false)
        {
            return Some(candidate);
        }
    }
    None
}

pub(crate) fn read_skill_metadata_from_dir(skill_dir: &Path) -> Result<SkillMetadata, String> {
    let metadata_file = metadata_file_for(skill_dir).ok_or_else(|| {
        format!(
            "No SKILL.md, skill.md, skill.json, or README.md found in {}",
            skill_dir.display()
        )
    })?;
    let metadata = read_skill_metadata_file(&metadata_file)?;
    let name = metadata.name.clone();
    let description = metadata.description.clone();
    if is_readme_markdown(&metadata_file) && name.is_none() && description.is_none() {
        let name = fallback_readme_skill_name(skill_dir)?;
        let description = fallback_readme_description(&metadata_file, &name)?;
        sanitize_skill_name(&name)?;
        return Ok(SkillMetadata {
            name,
            description,
            metadata_file,
        });
    }

    let name = name.ok_or_else(|| format!("Missing skill name in {}", metadata_file.display()))?;
    let description = description
        .ok_or_else(|| format!("Missing skill description in {}", metadata_file.display()))?;
    sanitize_skill_name(&name)?;
    Ok(SkillMetadata {
        name,
        description,
        metadata_file,
    })
}

pub(crate) fn read_skill_metadata_file(
    target: &Path,
) -> Result<SystemReadSkillMetadataResponse, String> {
    let md = fs::metadata(target).map_err(|e| format!("Failed to read Skill metadata: {e}"))?;
    if !md.is_file() {
        return Err("Only regular Skill metadata files can be read".to_string());
    }

    if is_skill_json(target) {
        let content =
            fs::read_to_string(target).map_err(|e| format!("Failed to read skill.json: {e}"))?;
        if content.len() > SKILL_METADATA_MAX_BYTES {
            return Err(format!(
                "skill.json is too large, over {} bytes",
                SKILL_METADATA_MAX_BYTES
            ));
        }
        return Ok(parse_skill_json_metadata(&content));
    }

    if !is_skill_markdown(target) && !is_readme_markdown(target) {
        return Err(
            "Skill metadata files only support skill.json / SKILL.md / skill.md / README.md"
                .to_string(),
        );
    }

    let file = fs::File::open(target).map_err(|e| format!("Failed to open Skill file: {e}"))?;
    let mut reader = BufReader::new(file);
    let yaml = match read_skill_markdown_frontmatter_yaml(&mut reader) {
        Ok(yaml) => yaml,
        Err(error) if is_readme_markdown(target) && is_missing_frontmatter_error(&error) => {
            return Ok(empty_skill_metadata_response());
        }
        Err(error) => return Err(error),
    };
    Ok(parse_skill_frontmatter_yaml_metadata(&yaml))
}

pub(crate) fn split_inline_frontmatter(content: &str) -> Option<(String, String)> {
    let rest = content.trim_start().strip_prefix("---")?;
    if rest.trim_start().starts_with('\n') || rest.trim().is_empty() {
        return None;
    }
    let closing = rest.find("---")?;
    let yaml = rest[..closing].trim().to_string();
    let body = rest[closing + 3..].trim_start().to_string();
    Some((yaml, body))
}

pub(crate) fn frontmatter_keys(yaml: &str) -> Vec<String> {
    if !yaml.contains('\n') {
        return [
            "name",
            "description",
            "license",
            "allowed-tools",
            "metadata",
        ]
        .into_iter()
        .filter(|key| inline_yaml_key_start(yaml, key).is_some())
        .map(ToString::to_string)
        .collect();
    }

    let mut keys = Vec::new();
    for line in yaml.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if line
            .chars()
            .next()
            .map(char::is_whitespace)
            .unwrap_or(false)
        {
            continue;
        }
        if let Some((key, _)) = line.split_once(':') {
            let key = key.trim();
            if !key.is_empty()
                && key
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
            {
                keys.push(key.to_string());
            }
        }
    }
    keys
}

pub(crate) fn split_frontmatter(content: &str) -> Result<(String, String), String> {
    let normalized = strip_utf8_bom(content);
    if let Some((yaml, body)) = split_inline_frontmatter(normalized) {
        return Ok((yaml, body));
    }

    let lines = normalized.split_inclusive('\n').collect::<Vec<_>>();
    let mut index = 0usize;
    while index < lines.len() && lines[index].trim().is_empty() {
        index += 1;
    }
    if index >= lines.len() || lines[index].trim() != "---" {
        return Err("Skill frontmatter must start with ---".to_string());
    }
    index += 1;
    let mut yaml = String::new();
    while index < lines.len() {
        if lines[index].trim() == "---" {
            let body = lines[index + 1..].join("");
            return Ok((yaml, body));
        }
        yaml.push_str(lines[index]);
        index += 1;
    }
    Err("Skill frontmatter is missing the closing ---".to_string())
}
