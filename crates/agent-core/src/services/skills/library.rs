//! 已安装 Skill 库：目录发现、列表、文本读取、删除、打包与 `_meta.json` 源信息。

use serde_json::Value;
use std::fs;
use std::io::{self, BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::*;

const SKILL_READ_MAX_BYTES: usize = 200 * 1024; // 200KB
const DEFAULT_SKILL_READ_LENGTH_LINES: usize = 200;
const DEFAULT_SKILL_GLOB_MAX_RESULTS: usize = 2000;

pub(crate) fn should_skip_discovery_path(root: &Path, path: &Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components().any(|component| match component {
        Component::Normal(segment) => {
            let name = segment.to_string_lossy();
            name.starts_with('.') || name.contains(".backup-") || name.starts_with("backup-")
        }
        _ => false,
    })
}

pub(crate) fn has_skill_metadata_ancestor(root: &Path, path: &Path) -> bool {
    if !path.starts_with(root) {
        return false;
    }
    let mut current = path.parent();
    while let Some(parent) = current {
        if !parent.starts_with(root) {
            break;
        }
        if parent == root {
            break;
        }
        if metadata_file_for(parent).is_some() {
            return true;
        }
        current = parent.parent();
    }
    false
}

pub(crate) fn should_include_metadata_candidate(root: &Path, path: &Path) -> bool {
    if !is_skill_metadata_candidate(path) {
        return false;
    }
    if !is_readme_markdown(path) {
        return true;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    standard_metadata_file_for(parent).is_none() && !has_skill_metadata_ancestor(root, parent)
}

pub(crate) fn is_skill_dir(path: &Path) -> bool {
    path.is_dir() && metadata_file_for(path).is_some()
}

pub fn system_list_skill_files_sync() -> Result<SystemListSkillFilesResponse, String> {
    let root = skills_root_dir()?;
    let root_dir = skill_root_display(&root);

    let mut paths = Vec::new();
    let mut truncated = false;
    for entry in WalkDir::new(&root).follow_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };

        if should_skip_discovery_path(&root, entry.path()) {
            continue;
        }
        if !entry.file_type().is_file() || !should_include_metadata_candidate(&root, entry.path()) {
            continue;
        }

        if paths.len() >= DEFAULT_SKILL_GLOB_MAX_RESULTS {
            truncated = true;
            break;
        }

        paths.push(rel_to_root_str(&root, entry.path()));
    }

    paths.sort();
    Ok(SystemListSkillFilesResponse {
        root_dir,
        paths,
        truncated,
    })
}

pub fn system_read_skill_metadata_sync(
    path: String,
) -> Result<SystemReadSkillMetadataResponse, String> {
    let root = skills_root_dir()?;
    let rel = sanitize_skill_rel_path(&path)?;
    let target = root.join(rel);
    let target = ensure_within_skills_root_existing(&root, &target)?;
    read_skill_metadata_file(&target)
}

pub fn system_read_skill_text_sync(
    path: String,
    offset: Option<usize>,
    length: Option<usize>,
) -> Result<SystemReadSkillTextResponse, String> {
    let root = skills_root_dir()?;
    read_skill_text_from_root(&root, &path, offset, length)
}

pub(crate) fn read_skill_text_from_root(
    root: &Path,
    path: &str,
    offset: Option<usize>,
    length: Option<usize>,
) -> Result<SystemReadSkillTextResponse, String> {
    let rel = sanitize_skill_rel_path(path)?;
    let target = root.join(rel);
    let target = ensure_within_skills_root_existing(root, &target)?;
    let md =
        fs::metadata(&target).map_err(|e| format!("Failed to read Skill file metadata: {e}"))?;
    if !md.is_file() {
        return Err("Only regular Skill files can be read (not directories)".to_string());
    }

    let offset = offset.unwrap_or(0);
    let length = length.unwrap_or(DEFAULT_SKILL_READ_LENGTH_LINES);

    let file =
        fs::File::open(&target).map_err(|e| format!("Failed to open the Skill file: {e}"))?;
    let mut reader = BufReader::new(file);

    let mut line_idx: usize = 0;
    let mut taken: usize = 0;
    let mut out = String::new();
    let mut truncated = false;
    let mut buf = Vec::new();

    loop {
        buf.clear();
        let n = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("Failed to read the Skill file: {e}"))?;
        if n == 0 {
            break;
        }

        if line_idx < offset {
            line_idx += 1;
            continue;
        }

        if taken >= length {
            truncated = true;
            break;
        }

        if out.len().saturating_add(buf.len()) > SKILL_READ_MAX_BYTES {
            truncated = true;
            break;
        }

        out.push_str(&String::from_utf8_lossy(&buf));
        line_idx += 1;
        taken += 1;
    }

    Ok(SystemReadSkillTextResponse {
        content: out,
        truncated,
    })
}

pub(crate) fn discover_skill_dirs(root: &Path) -> Vec<PathBuf> {
    let mut root = root.to_path_buf();
    if root.is_file() && is_skill_metadata_candidate(&root) {
        if let Some(parent) = root.parent() {
            root = parent.to_path_buf();
        }
    }

    if root.is_dir() && standard_metadata_file_for(&root).is_some() {
        return vec![root];
    }

    let nested_skills = root.join("skills");
    if nested_skills.is_dir() {
        let candidates = read_child_skill_dirs(&nested_skills);
        if !candidates.is_empty() {
            return candidates;
        }
    }

    if root.is_dir() {
        let candidates = read_child_skill_dirs(&root);
        if !candidates.is_empty() {
            return candidates;
        }
    }

    if is_skill_dir(&root) {
        return vec![root];
    }

    Vec::new()
}

pub(crate) fn read_child_skill_dirs(root: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return candidates;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .file_name()
            .map(|name| {
                let name = name.to_string_lossy();
                name.starts_with('.') || name.contains(".backup-")
            })
            .unwrap_or(false)
        {
            continue;
        }
        if is_skill_dir(&path) {
            candidates.push(path);
        }
    }
    candidates.sort();
    candidates
}

pub(crate) fn read_skill_source_metadata(skill_dir: &Path) -> Option<SystemSkillSourceMetadata> {
    let meta_path = skill_dir.join("_meta.json");
    let content = fs::read_to_string(meta_path).ok()?;
    let value = serde_json::from_str::<Value>(&content).ok()?;
    let slug = value
        .get("slug")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let version = value
        .get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let optional_string = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    };
    let published_at = value.get("publishedAt").and_then(Value::as_u64);

    Some(SystemSkillSourceMetadata {
        registry: "clawhub".to_string(),
        slug,
        owner_handle: optional_string("ownerHandle"),
        version,
        published_at,
        original_name: optional_string("originalName"),
        normalized_name: optional_string("normalizedName"),
        compatibility_transform: optional_string("compatibilityTransform"),
    })
}

pub(crate) fn skill_summary_from_dir(
    root: &Path,
    skill_dir: &Path,
) -> Result<SystemSkillSummary, String> {
    let metadata = read_skill_metadata_from_dir(skill_dir)?;
    let built_in = is_managed_builtin_skill_dir(skill_dir, &metadata.name);
    let skill_file = rel_to_root_str(root, &metadata.metadata_file);
    let base_dir = rel_to_root_str(root, skill_dir);
    Ok(SystemSkillSummary {
        name: metadata.name,
        description: metadata.description,
        target: display_path(skill_dir),
        skill_file,
        base_dir,
        built_in,
        installed_at: fs::metadata(skill_dir)
            .ok()
            .and_then(|metadata| metadata.created().or_else(|_| metadata.modified()).ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| u64::try_from(duration.as_millis()).ok()),
        source: read_skill_source_metadata(skill_dir),
    })
}

pub(crate) fn list_installed_skills(
    root: &Path,
) -> Result<(Vec<SystemSkillSummary>, Vec<SystemSkillInvalidEntry>), String> {
    let mut skills = Vec::new();
    let mut invalid = Vec::new();
    let entries = fs::read_dir(root).map_err(|e| format!("Failed to list Skills root: {e}"))?;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                invalid.push(SystemSkillInvalidEntry {
                    path: root.display().to_string(),
                    error: error.to_string(),
                });
                continue;
            }
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.contains(".backup-") || !path.is_dir() {
            continue;
        }
        match skill_summary_from_dir(root, &path) {
            Ok(summary) => skills.push(summary),
            Err(error) => invalid.push(SystemSkillInvalidEntry {
                path: display_path(&path),
                error,
            }),
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok((skills, invalid))
}

pub(crate) fn delete_installed_skill(
    root: &Path,
    name: &str,
) -> Result<SystemSkillDeleteResponse, String> {
    let name = sanitize_skill_name(name)?;
    ensure_not_builtin_skill_management_target(root, &name, "delete")?;
    let _guard = skills_write_guard();
    let target = root.join(&name);
    let metadata = fs::symlink_metadata(&target).map_err(|e| {
        format!(
            "Skill does not exist or cannot be inspected: {}: {e}",
            target.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "SkillsManager action=delete refuses to delete symlink target: {}",
            target.display()
        ));
    }
    if !metadata.is_dir() {
        return Err(format!(
            "SkillsManager action=delete requires an installed Skill directory: {}",
            target.display()
        ));
    }
    fs::remove_dir_all(&target)
        .map_err(|e| format!("Failed to delete Skill {}: {e}", target.display()))?;
    Ok(SystemSkillDeleteResponse {
        name,
        target: display_path(&target),
    })
}

pub(crate) fn package_installed_skill(
    root: &Path,
    name: &str,
) -> Result<SystemSkillPackageResponse, String> {
    let name = sanitize_skill_name(name)?;
    let _guard = skills_write_guard();
    let target = root.join(&name);
    let validation = validate_skill_dir(&target);
    if !validation.ok {
        return Err(format!(
            "Validation failed before packaging:\n{}",
            validation.errors.join("\n")
        ));
    }
    let packages_root = root.join(".packages");
    fs::create_dir_all(&packages_root)
        .map_err(|e| format!("Failed to create Skills packages directory: {e}"))?;
    let archive = packages_root.join(format!("{name}.skill"));
    let archive_file = fs::File::create(&archive)
        .map_err(|e| format!("Failed to create Skill archive {}: {e}", archive.display()))?;
    let mut writer = ZipWriter::new(archive_file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    for entry in WalkDir::new(&target).follow_links(false).min_depth(1) {
        let entry = entry.map_err(|e| format!("Failed to inspect Skill for packaging: {e}"))?;
        if entry.file_type().is_symlink() {
            return Err(format!(
                "Cannot package symlink inside Skill: {}",
                entry.path().display()
            ));
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| format!("Failed to compute archive path: {e}"))?
            .to_string_lossy()
            .replace('\\', "/");
        writer
            .start_file(rel, options)
            .map_err(|e| format!("Failed to start archive file: {e}"))?;
        let mut file = fs::File::open(entry.path())
            .map_err(|e| format!("Failed to open Skill file for packaging: {e}"))?;
        io::copy(&mut file, &mut writer)
            .map_err(|e| format!("Failed to write Skill archive: {e}"))?;
    }
    writer
        .finish()
        .map_err(|e| format!("Failed to finish Skill archive: {e}"))?;

    Ok(SystemSkillPackageResponse {
        name,
        target: display_path(&target),
        archive: display_path(&archive),
    })
}
