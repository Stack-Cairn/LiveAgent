//! Skill packs: a top-level `<root>/<dir>` without its own SKILL.md whose
//! skills sit deeper (for example `<dir>/skills/<module>/SKILL.md`).
//!
//! The rule is shared with K-brain and must stay identical:
//! - `<root>/<dir>/SKILL.md` exists: one top-level skill.
//! - otherwise any SKILL.md within [`PACK_MAX_DEPTH`] levels makes `<dir>` a pack.
//! - a pack is walked breadth-first, at most [`PACK_MAX_DEPTH`] levels below
//!   `<dir>`, [`PACK_MAX_VISITED_DIRS`] directories and [`PACK_MAX_SKILLS`]
//!   skills. Dot-dirs, [`PACK_SKIPPED_DIR_NAMES`] and symlinks that resolve
//!   outside the root are skipped; skill directories are descended into too.
//! - every directory whose SKILL.md frontmatter has `name` and `description`
//!   is a skill. Validation is lenient: the name need not match the directory.
//! - shadowing: inside a pack the shallowest path wins (ties lexicographic), a
//!   top-level skill beats a pack skill, and the lexicographically first pack
//!   wins between packs. Losers stay listed with `shadowed = true`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::*;

pub(crate) const PACK_MAX_DEPTH: usize = 4;
pub(crate) const PACK_MAX_VISITED_DIRS: usize = 5000;
pub(crate) const PACK_MAX_SKILLS: usize = 200;
pub(crate) const PACK_SKIPPED_DIR_NAMES: &[&str] = &[
    "node_modules",
    "vendor",
    "target",
    "build",
    "dist",
    "__pycache__",
];
const PACK_SKILL_FILE: &str = "SKILL.md";
const MAX_PACK_SKILL_NAME_LENGTH: usize = 128;

/// A directory inside a pack that holds a SKILL.md.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PackSkillDir {
    pub(crate) dir: PathBuf,
    /// Path relative to the pack directory, forward slashes.
    pub(crate) rel: String,
    /// Levels below the pack directory (a direct child is 1).
    pub(crate) depth: usize,
}

#[derive(Debug, Default)]
pub(crate) struct PackWalk {
    pub(crate) skill_dirs: Vec<PackSkillDir>,
    /// The visited-directory budget ran out before the walk finished.
    pub(crate) dirs_truncated: bool,
}

pub(crate) fn is_skipped_pack_dir_name(name: &str) -> bool {
    name.starts_with('.') || PACK_SKIPPED_DIR_NAMES.contains(&name)
}

fn resolves_within(path: &Path, canonical_root: &Path) -> bool {
    fs::canonicalize(path)
        .map(|target| target.starts_with(canonical_root))
        .unwrap_or(false)
}

fn has_pack_skill_file(dir: &Path, canonical_root: &Path) -> bool {
    let file = dir.join(PACK_SKILL_FILE);
    let Ok(meta) = fs::symlink_metadata(&file) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return file.is_file() && resolves_within(&file, canonical_root);
    }
    meta.is_file()
}

/// Walks `pack_dir` breadth-first and returns every directory below it that
/// holds a SKILL.md, shallowest first. `containment_root` bounds symlinks.
pub(crate) fn walk_pack(containment_root: &Path, pack_dir: &Path) -> PackWalk {
    let canonical_root =
        fs::canonicalize(containment_root).unwrap_or_else(|_| containment_root.to_path_buf());
    let mut walk = PackWalk::default();
    let mut queue = VecDeque::from([(pack_dir.to_path_buf(), String::new(), 0usize)]);
    let mut seen = HashSet::new();
    if let Ok(canonical) = fs::canonicalize(pack_dir) {
        seen.insert(canonical);
    }
    let mut visited = 0usize;

    while let Some((dir, rel, depth)) = queue.pop_front() {
        if visited >= PACK_MAX_VISITED_DIRS {
            walk.dirs_truncated = true;
            break;
        }
        visited += 1;
        if depth > 0 && has_pack_skill_file(&dir, &canonical_root) {
            walk.skill_dirs.push(PackSkillDir {
                dir: dir.clone(),
                rel: rel.clone(),
                depth,
            });
        }
        if depth >= PACK_MAX_DEPTH {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut children = entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                if is_skipped_pack_dir_name(&name) {
                    return None;
                }
                let path = entry.path();
                let file_type = entry.file_type().ok()?;
                if file_type.is_symlink() {
                    if !path.is_dir() || !resolves_within(&path, &canonical_root) {
                        return None;
                    }
                } else if !file_type.is_dir() {
                    return None;
                }
                Some((name, path))
            })
            .collect::<Vec<_>>();
        children.sort_by(|a, b| a.0.cmp(&b.0));
        for (name, path) in children {
            // Symlinks may point back up the tree; visit each real dir once.
            if let Ok(canonical) = fs::canonicalize(&path) {
                if !seen.insert(canonical) {
                    continue;
                }
            }
            let child_rel = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            queue.push_back((path, child_rel, depth + 1));
        }
    }
    walk
}

/// Lenient name check for discovered pack skills, as K-brain: non-empty, at
/// most 128 characters, no leading `.`, no whitespace, control characters or
/// path separators.
pub(crate) fn sanitize_pack_skill_name(input: &str) -> Result<String, String> {
    let name = input.trim();
    if name.is_empty() {
        return Err("Skill name cannot be empty".to_string());
    }
    if name.chars().count() > MAX_PACK_SKILL_NAME_LENGTH {
        return Err(format!(
            "Skill name '{name}' is too long; maximum is {MAX_PACK_SKILL_NAME_LENGTH}"
        ));
    }
    if name.starts_with('.') {
        return Err(format!("Skill name '{name}' must not start with '.'"));
    }
    if name
        .chars()
        .any(|ch| ch == '/' || ch == '\\' || ch.is_control() || ch.is_whitespace())
    {
        return Err(format!(
            "Skill name '{name}' must not contain whitespace, path separators or control characters"
        ));
    }
    Ok(name.to_string())
}

/// Reads a pack skill's SKILL.md frontmatter. Requires `name` and
/// `description`; the name need not match the directory and block-scalar
/// descriptions are accepted.
pub(crate) fn read_pack_skill_metadata(skill_dir: &Path) -> Result<SkillMetadata, String> {
    let metadata_file = skill_dir.join(PACK_SKILL_FILE);
    let parsed = read_skill_metadata_file(&metadata_file)
        .map_err(|error| format!("{error} ({})", metadata_file.display()))?;
    let name = parsed
        .name
        .ok_or_else(|| format!("Missing skill name in {}", metadata_file.display()))?;
    let description = parsed
        .description
        .ok_or_else(|| format!("Missing skill description in {}", metadata_file.display()))?;
    Ok(SkillMetadata {
        name: sanitize_pack_skill_name(&name)?,
        description,
        metadata_file,
    })
}

/// One parsed skill inside a pack, before shadowing is decided.
#[derive(Debug, Clone)]
pub(crate) struct PackSkill {
    pub(crate) dir: PathBuf,
    pub(crate) rel: String,
    pub(crate) depth: usize,
    pub(crate) metadata: SkillMetadata,
}

#[derive(Debug, Default)]
pub(crate) struct PackScan {
    pub(crate) skills: Vec<PackSkill>,
    pub(crate) invalid: Vec<SystemSkillInvalidEntry>,
    /// True when the walk found at least one SKILL.md (valid or not), which is
    /// what makes a directory a pack.
    pub(crate) is_pack: bool,
}

/// Walks and parses one pack. Malformed SKILL.md files become `invalid`
/// entries; parsing stops after [`PACK_MAX_SKILLS`] valid skills.
pub(crate) fn scan_pack(containment_root: &Path, pack_dir: &Path) -> PackScan {
    let walk = walk_pack(containment_root, pack_dir);
    let mut scan = PackScan {
        is_pack: !walk.skill_dirs.is_empty(),
        ..PackScan::default()
    };
    let pack_label = pack_dir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    for candidate in walk.skill_dirs {
        if scan.skills.len() >= PACK_MAX_SKILLS {
            scan.invalid.push(SystemSkillInvalidEntry {
                path: display_path(pack_dir),
                error: format!(
                    "Skill pack '{pack_label}' has more than {PACK_MAX_SKILLS} skills; the rest are ignored"
                ),
            });
            break;
        }
        match read_pack_skill_metadata(&candidate.dir) {
            Ok(metadata) => scan.skills.push(PackSkill {
                dir: candidate.dir,
                rel: candidate.rel,
                depth: candidate.depth,
                metadata,
            }),
            Err(error) => scan.invalid.push(SystemSkillInvalidEntry {
                path: display_path(&candidate.dir.join(PACK_SKILL_FILE)),
                error,
            }),
        }
    }
    if walk.dirs_truncated {
        scan.invalid.push(SystemSkillInvalidEntry {
            path: display_path(pack_dir),
            error: format!(
                "Skill pack '{pack_label}' has more than {PACK_MAX_VISITED_DIRS} directories; the rest were not scanned"
            ),
        });
    }
    scan
}

/// Decides which pack skills are shadowed. `top_level` maps the names of
/// valid top-level skills to their `baseDir`; `packs` must be sorted by pack
/// name. Returns, per pack and in the given skill order, the `baseDir` of the
/// skill that kept the name, or `None` when the skill itself kept it.
pub(crate) fn resolve_pack_shadowing(
    top_level: &HashMap<String, String>,
    packs: &[(String, Vec<PackSkill>)],
) -> Vec<Vec<Option<String>>> {
    let mut claimed = top_level.clone();
    packs
        .iter()
        .map(|(pack, skills)| {
            let mut order = (0..skills.len()).collect::<Vec<_>>();
            order.sort_by(|&a, &b| {
                skills[a]
                    .depth
                    .cmp(&skills[b].depth)
                    .then_with(|| skills[a].rel.cmp(&skills[b].rel))
            });
            let mut shadowed_by = vec![None; skills.len()];
            for index in order {
                let skill = &skills[index];
                match claimed.get(&skill.metadata.name) {
                    Some(winner) => shadowed_by[index] = Some(winner.clone()),
                    None => {
                        claimed.insert(
                            skill.metadata.name.clone(),
                            pack_skill_base_dir(pack, skill),
                        );
                    }
                }
            }
            shadowed_by
        })
        .collect()
}

/// `baseDir` of a pack skill: `<pack>/<path inside the pack>`.
pub(crate) fn pack_skill_base_dir(pack: &str, skill: &PackSkill) -> String {
    format!("{pack}/{}", skill.rel)
}

pub(crate) fn pack_skill_summary(
    root: &Path,
    pack: &str,
    skill: &PackSkill,
    shadowed_by: Option<String>,
) -> SystemSkillSummary {
    SystemSkillSummary {
        name: skill.metadata.name.clone(),
        description: skill.metadata.description.clone(),
        target: display_path(&skill.dir),
        skill_file: rel_to_root_str(root, &skill.metadata.metadata_file),
        base_dir: rel_to_root_str(root, &skill.dir),
        built_in: false,
        installed_at: fs::metadata(&skill.dir)
            .ok()
            .and_then(|metadata| metadata.created().or_else(|_| metadata.modified()).ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| u64::try_from(duration.as_millis()).ok()),
        source: None,
        pack: pack.to_string(),
        shadowed: shadowed_by.is_some(),
        shadowed_by,
    }
}

/// Whether a top-level directory of the Skills root may be a pack: dot-dirs
/// and the skipped build/vendor names never are.
pub(crate) fn may_be_pack_dir_name(name: &str) -> bool {
    !is_skipped_pack_dir_name(name)
}

/// A skill inside a pack, found by name or by baseDir (`<pack>/<rel>`).
pub(crate) struct PackSkillRef {
    pub(crate) pack: String,
    pub(crate) skill: PackSkill,
}

/// Finds the pack skill that `name_or_base_dir` refers to (its name, or its
/// baseDir with either slash). Used to explain why a pack child cannot be
/// deleted on its own and to validate one pack skill.
pub(crate) fn find_pack_skill(root: &Path, name_or_base_dir: &str) -> Option<PackSkillRef> {
    let wanted = name_or_base_dir.trim().replace('\\', "/");
    let wanted = wanted.trim_matches('/');
    if wanted.is_empty() {
        return None;
    }
    let mut entries = fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    entries.sort();
    for dir in entries {
        let Some(pack) = dir.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        if !may_be_pack_dir_name(&pack)
            || !dir.is_dir()
            || standard_metadata_file_for(&dir).is_some()
        {
            continue;
        }
        if wanted.contains('/') && !wanted.starts_with(&format!("{pack}/")) {
            continue;
        }
        let found = scan_pack(root, &dir).skills.into_iter().find(|skill| {
            skill.metadata.name == wanted || pack_skill_base_dir(&pack, skill) == wanted
        });
        if let Some(skill) = found {
            return Some(PackSkillRef { pack, skill });
        }
    }
    None
}

/// Finds the pack that holds a skill named `name` (or with that baseDir).
pub(crate) fn find_pack_for_skill_name(root: &Path, name: &str) -> Option<String> {
    find_pack_skill(root, name).map(|found| found.pack)
}
