//! Skill pack discovery, limits, shadowing, delete and install, on a synthetic
//! fixture laid out like a real reverse-engineering pack: a router SKILL.md at
//! `skills/`, modules one level below it, a depth-3 sub-module, a duplicate of
//! the router inside client adapter dirs (`plugins/.../skills/...`, depth 4),
//! plus junk that must be ignored.

use super::*;
use serde_json::json;
use std::fs;
use std::io::Write;
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

fn write_file(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
    fs::write(path, content).expect("write file");
}

fn write_skill_md(dir: &Path, name: &str, description: &str) {
    write_file(
        &dir.join("SKILL.md"),
        &format!("---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n"),
    );
}

/// Builds `<root>/demo-pack` and returns the pack directory.
fn write_demo_pack(root: &Path) -> std::path::PathBuf {
    let pack = root.join("demo-pack");
    write_file(&pack.join("README.md"), "# Demo pack\n");
    // Router (depth 1) and modules (depth 2).
    write_skill_md(&pack.join("skills"), "demo-router", "Routes demo tasks");
    write_skill_md(
        &pack.join("skills/radare2"),
        "radare2",
        "Disassemble binaries",
    );
    write_skill_md(
        &pack.join("skills/js-reverse"),
        "js-reverse",
        "Reverse JS bundles",
    );
    // Block-scalar description.
    write_file(
        &pack.join("skills/block-desc/SKILL.md"),
        "---\nname: block-desc\ndescription: |\n  First line.\n  Second line.\nmetadata:\n  tier: 2\n---\n\n# Block\n",
    );
    // Depth 3 inside a skill dir (skill dirs are descended into).
    write_skill_md(
        &pack.join("skills/reverse-engineering/dsl-vm-reverse"),
        "dsl-vm-reverse",
        "Reverse custom VMs",
    );
    write_skill_md(
        &pack.join("skills/reverse-engineering"),
        "reverse-engineering",
        "General reversing",
    );
    // Client adapter dirs: a duplicate of the router at depth 4.
    write_skill_md(
        &pack.join("plugins/demo-pack/skills/demo-router"),
        "demo-router",
        "Routes demo tasks (adapter copy)",
    );
    // A name that does not match its dir is allowed in packs.
    write_skill_md(&pack.join("extra/odd-dir"), "Odd_Name.v2", "Lenient name");
    write_skill_md(
        &pack.join("extra/spaced"),
        "Two Words",
        "Not a valid pack skill name",
    );
    // Too deep (depth 5): ignored.
    write_skill_md(&pack.join("a/b/c/d/too-deep"), "too-deep", "Depth five");
    // Junk that must be skipped.
    write_skill_md(
        &pack.join("node_modules/pkg"),
        "from-node-modules",
        "Skip me",
    );
    write_skill_md(&pack.join("dist/bundle"), "from-dist", "Skip me");
    write_skill_md(&pack.join(".git/hooks"), "from-git", "Skip me");
    write_skill_md(
        &pack.join("skills/__pycache__/x"),
        "from-pycache",
        "Skip me",
    );
    write_file(&pack.join("docs/plans/notes.md"), "# notes\n");
    // Malformed SKILL.md (no description).
    write_file(
        &pack.join("skills/broken/SKILL.md"),
        "---\nname: broken\n---\n\n# Broken\n",
    );
    pack
}

#[cfg(unix)]
fn symlink_dir(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).expect("create symlink");
}

fn names(skills: &[SystemSkillSummary]) -> Vec<String> {
    skills.iter().map(|skill| skill.name.clone()).collect()
}

fn find<'a>(skills: &'a [SystemSkillSummary], base_dir: &str) -> &'a SystemSkillSummary {
    skills
        .iter()
        .find(|skill| skill.base_dir == base_dir)
        .unwrap_or_else(|| panic!("missing {base_dir} in {:?}", names(skills)))
}

#[test]
fn pack_discovery_lists_nested_skills_with_pack_and_base_dir() {
    let tmp = TempDir::new("liveagent-pack-discovery").expect("temp dir");
    let root = tmp.path().join("skills");
    write_demo_pack(&root);
    write_skill_md(&root.join("plain"), "plain", "Top-level skill");

    let (skills, invalid) = list_installed_skills(&root).expect("list");

    let plain = find(&skills, "plain");
    assert_eq!(plain.pack, "");
    assert!(!plain.shadowed);

    let router = find(&skills, "demo-pack/skills");
    assert_eq!(router.name, "demo-router");
    assert_eq!(router.pack, "demo-pack");
    assert_eq!(router.skill_file, "demo-pack/skills/SKILL.md");
    assert!(!router.shadowed);

    let radare = find(&skills, "demo-pack/skills/radare2");
    assert_eq!(radare.pack, "demo-pack");
    assert_eq!(radare.skill_file, "demo-pack/skills/radare2/SKILL.md");

    find(&skills, "demo-pack/skills/reverse-engineering");
    find(
        &skills,
        "demo-pack/skills/reverse-engineering/dsl-vm-reverse",
    );
    assert_eq!(find(&skills, "demo-pack/extra/odd-dir").name, "Odd_Name.v2");
    assert_eq!(
        find(&skills, "demo-pack/skills/block-desc").description,
        "First line.\nSecond line."
    );

    let adapter = find(&skills, "demo-pack/plugins/demo-pack/skills/demo-router");
    assert!(adapter.shadowed);
    assert_eq!(adapter.shadowed_by.as_deref(), Some("demo-pack/skills"));

    for skipped in [
        "too-deep",
        "from-node-modules",
        "from-dist",
        "from-git",
        "from-pycache",
        "broken",
    ] {
        assert!(
            !names(&skills).contains(&skipped.to_string()),
            "{skipped} should not be listed"
        );
    }
    // The malformed SKILL.md is reported, the README-only pack dir is not.
    assert_eq!(invalid.len(), 2, "{invalid:?}");
    assert!(invalid[0].path.ends_with("extra/spaced/SKILL.md"));
    assert!(
        invalid[0].error.contains("whitespace"),
        "{}",
        invalid[0].error
    );
    assert!(invalid[1].path.ends_with("skills/broken/SKILL.md"));
    assert!(invalid[1].error.contains("description"));
}

#[test]
fn top_level_skill_with_skill_md_is_not_walked_as_pack() {
    let tmp = TempDir::new("liveagent-pack-top-level").expect("temp dir");
    let root = tmp.path().join("skills");
    let top = root.join("parent");
    write_skill_md(&top, "parent", "Has its own SKILL.md");
    write_skill_md(&top.join("skills/child"), "child", "Nested under a skill");

    let (skills, invalid) = list_installed_skills(&root).expect("list");

    assert_eq!(names(&skills), vec!["parent"]);
    assert_eq!(skills[0].pack, "");
    assert!(invalid.is_empty());
}

#[test]
fn dir_without_any_skill_md_stays_a_readme_fallback_skill() {
    let tmp = TempDir::new("liveagent-pack-readme").expect("temp dir");
    let root = tmp.path().join("skills");
    write_file(&root.join("readme-only/README.md"), "# Readme only\n");

    let (skills, _) = list_installed_skills(&root).expect("list");

    assert_eq!(names(&skills), vec!["readme-only"]);
    assert_eq!(skills[0].pack, "");
}

#[cfg(unix)]
#[test]
fn pack_walk_skips_symlinks_that_escape_the_root() {
    let tmp = TempDir::new("liveagent-pack-symlink").expect("temp dir");
    let root = tmp.path().join("skills");
    let outside = tmp.path().join("outside");
    write_skill_md(&outside.join("escaped"), "escaped", "Outside the root");
    let pack = root.join("z-linky");
    write_skill_md(&pack.join("skills/inside"), "inside", "Inside");
    symlink_dir(&outside, &pack.join("skills/escape-link"));
    // A link inside the root is followed, and a link back up does not loop.
    write_skill_md(&root.join("shared/one"), "shared-one", "Shared inside root");
    symlink_dir(&root.join("shared"), &pack.join("skills/shared-link"));
    symlink_dir(&pack, &pack.join("skills/loop"));
    // A SKILL.md symlinked from outside the root is ignored.
    write_file(
        &outside.join("leaked.md"),
        "---\nname: leaked\ndescription: Outside file\n---\n",
    );
    fs::create_dir_all(pack.join("skills/leak")).expect("leak dir");
    std::os::unix::fs::symlink(outside.join("leaked.md"), pack.join("skills/leak/SKILL.md"))
        .expect("file symlink");

    let (skills, _) = list_installed_skills(&root).expect("list");
    let listed = names(&skills);

    assert!(listed.contains(&"inside".to_string()));
    assert!(!listed.contains(&"escaped".to_string()));
    assert!(!listed.contains(&"leaked".to_string()));
    // `shared` is a pack of its own; through the link it is a shadowed copy.
    let via_link = find(&skills, "z-linky/skills/shared-link/one");
    assert!(via_link.shadowed);
    assert!(!find(&skills, "shared/one").shadowed);
}

#[test]
fn shadowing_prefers_top_level_then_shallowest_then_first_pack() {
    let tmp = TempDir::new("liveagent-pack-shadowing").expect("temp dir");
    let root = tmp.path().join("skills");
    write_skill_md(&root.join("radare2"), "radare2", "Top-level wins");
    write_skill_md(
        &root.join("alpha-pack/skills/radare2"),
        "radare2",
        "Loses to top",
    );
    write_skill_md(
        &root.join("alpha-pack/skills/shared"),
        "shared",
        "Alpha wins",
    );
    write_skill_md(
        &root.join("beta-pack/shared"),
        "shared",
        "Beta is shallower but later",
    );
    // Within one pack: same depth, lexicographic path wins.
    write_skill_md(&root.join("beta-pack/x/b-dup"), "dup", "Second");
    write_skill_md(&root.join("beta-pack/x/a-dup"), "dup", "First");

    let (skills, _) = list_installed_skills(&root).expect("list");

    assert!(!find(&skills, "radare2").shadowed);
    let lost = find(&skills, "alpha-pack/skills/radare2");
    assert!(lost.shadowed);
    assert_eq!(lost.shadowed_by.as_deref(), Some("radare2"));

    assert!(!find(&skills, "alpha-pack/skills/shared").shadowed);
    let beta_shared = find(&skills, "beta-pack/shared");
    assert!(beta_shared.shadowed);
    assert_eq!(
        beta_shared.shadowed_by.as_deref(),
        Some("alpha-pack/skills/shared")
    );

    assert!(!find(&skills, "beta-pack/x/a-dup").shadowed);
    assert!(find(&skills, "beta-pack/x/b-dup").shadowed);
}

#[test]
fn manage_list_puts_shadowed_pack_skills_apart() {
    let tmp = TempDir::new("liveagent-pack-manage-list").expect("temp dir");
    let root = tmp.path().join("skills");
    write_demo_pack(&root);
    let (skills, _) = list_installed_skills(&root).expect("list");
    let (shadowed, active): (Vec<_>, Vec<_>) = skills.into_iter().partition(|s| s.shadowed);
    let mut active_names = names(&active);
    active_names.dedup();
    assert_eq!(
        active_names.len(),
        active.len(),
        "one active entry per name"
    );
    assert_eq!(
        shadowed
            .iter()
            .map(|skill| skill.base_dir.as_str())
            .collect::<Vec<_>>(),
        vec!["demo-pack/plugins/demo-pack/skills/demo-router"]
    );
}

#[test]
fn pack_walk_caps_skills_per_pack() {
    let tmp = TempDir::new("liveagent-pack-skill-cap").expect("temp dir");
    let root = tmp.path().join("skills");
    let pack = root.join("big-pack");
    for index in 0..(PACK_MAX_SKILLS + 5) {
        let name = format!("skill-{index:03}");
        write_skill_md(&pack.join(&name), &name, "Many");
    }

    let scan = scan_pack(&root, &pack);

    assert_eq!(scan.skills.len(), PACK_MAX_SKILLS);
    assert!(scan
        .invalid
        .iter()
        .any(|entry| entry.error.contains("more than 200 skills")));
}

#[test]
fn pack_walk_caps_visited_dirs() {
    let tmp = TempDir::new("liveagent-pack-dir-cap").expect("temp dir");
    let root = tmp.path().join("skills");
    let pack = root.join("wide-pack");
    // 80 * 80 = 6400 directories at depth 2, over the 5000 budget. The skill
    // sits last in BFS order so the budget runs out before reaching it.
    for outer in 0..80 {
        for inner in 0..80 {
            fs::create_dir_all(pack.join(format!("d{outer:02}/e{inner:02}"))).expect("dir");
        }
    }
    write_skill_md(&pack.join("a-first"), "a-first", "Found early");
    write_skill_md(&pack.join("d79/e79"), "too-late", "Past the budget");

    let walk = walk_pack(&root, &pack);
    let rels = walk
        .skill_dirs
        .iter()
        .map(|dir| dir.rel.as_str())
        .collect::<Vec<_>>();

    assert!(walk.dirs_truncated);
    assert_eq!(rels, vec!["a-first"]);
    let scan = scan_pack(&root, &pack);
    assert!(scan
        .invalid
        .iter()
        .any(|entry| entry.error.contains("more than 5000 directories")));
}

#[test]
fn delete_pack_child_explains_and_whole_pack_deletes() {
    let tmp = TempDir::new("liveagent-pack-delete").expect("temp dir");
    let root = tmp.path().join("skills");
    write_demo_pack(&root);

    let error = delete_installed_skill(&root, "radare2").expect_err("child delete refused");
    assert!(error.contains("skill pack 'demo-pack'"), "{error}");
    let error = delete_installed_skill(&root, "demo-pack/skills/radare2")
        .expect_err("child delete by baseDir refused");
    assert!(error.contains("skill pack 'demo-pack'"), "{error}");
    assert!(root.join("demo-pack/skills/radare2/SKILL.md").is_file());

    delete_installed_skill(&root, "demo-pack").expect("delete pack");
    assert!(!root.join("demo-pack").exists());
}

#[test]
fn install_local_dir_with_nested_skills_installs_a_pack() {
    let tmp = TempDir::new("liveagent-pack-install-dir").expect("temp dir");
    let source_root = tmp.path().join("src");
    let source = write_demo_pack(&source_root);
    write_file(&source.join(".git/config"), "[core]\n");
    write_file(&source.join(".DS_Store"), "x");
    write_file(&source.join("skills/radare2/.env"), "SECRET=1\n");
    let root = tmp.path().join("skills");

    let payload = json!({ "source": source.to_string_lossy(), "conflict": "fail" });
    let installed =
        install_source_from_payload(&root, payload.as_object().expect("object")).expect("install");

    assert!(installed
        .iter()
        .all(|item| item.pack.as_deref() == Some("demo-pack")));
    assert_eq!(installed[0].name, "demo-router");
    assert_eq!(installed[0].skill_file, "demo-pack/skills/SKILL.md");
    assert!(root.join("demo-pack/skills/radare2/SKILL.md").is_file());
    assert!(!root.join("demo-pack/.git").exists());
    assert!(!root.join("demo-pack/.DS_Store").exists());
    assert!(!root.join("demo-pack/skills/radare2/.env").exists());

    let (skills, _) = list_installed_skills(&root).expect("list");
    assert_eq!(find(&skills, "demo-pack/skills/radare2").pack, "demo-pack");
}

#[test]
fn install_zip_with_wrapper_dir_installs_a_pack() {
    let tmp = TempDir::new("liveagent-pack-install-zip").expect("temp dir");
    let archive = tmp.path().join("zip-pack.zip");
    {
        let file = fs::File::create(&archive).expect("archive file");
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (path, name) in [
            ("zip-pack-main/skills/one/SKILL.md", "one"),
            ("zip-pack-main/skills/two/deeper/SKILL.md", "two"),
        ] {
            writer.start_file(path, options).expect("start file");
            writer
                .write_all(format!("---\nname: {name}\ndescription: Zip {name}\n---\n").as_bytes())
                .expect("write file");
        }
        writer.finish().expect("finish archive");
    }
    let root = tmp.path().join("skills");

    let payload = json!({ "source": archive.to_string_lossy(), "conflict": "fail" });
    let installed =
        install_source_from_payload(&root, payload.as_object().expect("object")).expect("install");

    assert_eq!(
        installed
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>(),
        vec!["one", "two"]
    );
    // Like K-brain, an archive's single wrapper directory names the pack.
    assert!(installed
        .iter()
        .all(|item| item.pack.as_deref() == Some("zip-pack-main")));
    assert!(root
        .join("zip-pack-main/skills/two/deeper/SKILL.md")
        .is_file());
}

#[test]
fn install_repo_of_flat_skills_still_installs_separately() {
    let tmp = TempDir::new("liveagent-pack-install-flat").expect("temp dir");
    let repo = tmp.path().join("repo");
    write_skill_md(&repo.join("skills/first-skill"), "first-skill", "First");
    write_skill_md(&repo.join("skills/second-skill"), "second-skill", "Second");
    let root = tmp.path().join("skills");

    let payload = json!({ "source": repo.to_string_lossy(), "conflict": "fail" });
    let installed =
        install_source_from_payload(&root, payload.as_object().expect("object")).expect("install");

    assert!(installed.iter().all(|item| item.pack.is_none()));
    assert!(root.join("first-skill/SKILL.md").is_file());
    assert!(root.join("second-skill/SKILL.md").is_file());
    assert!(!root.join("repo").exists());
}

#[test]
fn install_pack_without_valid_skills_fails() {
    let tmp = TempDir::new("liveagent-pack-install-invalid").expect("temp dir");
    let source = tmp.path().join("bad-pack");
    write_file(
        &source.join("skills/group/x/SKILL.md"),
        "---\nname: x\n---\n",
    );
    let root = tmp.path().join("skills");

    let payload = json!({ "source": source.to_string_lossy(), "conflict": "fail" });
    let error = install_source_from_payload(&root, payload.as_object().expect("object"))
        .expect_err("no valid skill");

    assert!(error.contains("no valid SKILL.md"), "{error}");
    assert!(!root.join("bad-pack").exists());
}

#[test]
fn pack_name_comes_from_the_source() {
    let stage = Path::new("/tmp/stage/archive");
    let wrapper = Path::new("/tmp/stage/archive/repo-main");
    assert_eq!(
        pack_name_for_source(
            "https://github.com/owner/Reverse-Skill",
            "main",
            stage,
            wrapper
        )
        .as_deref(),
        Some("reverse-skill")
    );
    assert_eq!(
        pack_name_for_source(
            "https://github.com/owner/repo/tree/main/packs/sec-pack",
            "main",
            stage,
            wrapper,
        )
        .as_deref(),
        Some("sec-pack")
    );
    assert_eq!(
        pack_name_for_source("/downloads/my-pack.zip", "main", stage, stage).as_deref(),
        Some("my-pack")
    );
    assert_eq!(
        pack_name_for_source("/downloads/my-pack.zip", "main", stage, wrapper).as_deref(),
        Some("repo-main")
    );
}

#[test]
fn pack_skill_names_follow_the_lenient_rule() {
    assert_eq!(
        sanitize_pack_skill_name(" Odd_Name.v2 ").as_deref(),
        Ok("Odd_Name.v2")
    );
    for bad in ["", ".hidden", "two words", "a/b", "a\\b", "tab\tname"] {
        assert!(
            sanitize_pack_skill_name(bad).is_err(),
            "{bad:?} must be rejected"
        );
    }
    assert!(sanitize_pack_skill_name(&"x".repeat(128)).is_ok());
    assert!(sanitize_pack_skill_name(&"x".repeat(129)).is_err());
}

#[test]
fn skipped_top_level_dirs_never_become_packs() {
    let tmp = TempDir::new("liveagent-pack-skipped-top").expect("temp dir");
    let root = tmp.path().join("skills");
    write_skill_md(
        &root.join("node_modules/pkg/skills/hidden"),
        "hidden",
        "Hidden",
    );
    write_skill_md(&root.join("dist/skills/bundled"), "bundled", "Bundled");
    write_demo_pack(&root);

    let (skills, _) = list_installed_skills(&root).expect("list");
    assert!(skills
        .iter()
        .all(|skill| skill.pack != "node_modules" && skill.pack != "dist"));
    assert!(!names(&skills).contains(&"hidden".to_string()));
    assert!(!names(&skills).contains(&"bundled".to_string()));
}

#[test]
fn validate_checks_a_whole_pack_or_one_pack_skill() {
    let tmp = TempDir::new("liveagent-pack-validate").expect("temp dir");
    let root = tmp.path().join("skills");
    write_demo_pack(&root);

    let pack = validate_installed_skill(&root, "demo-pack").expect("validate pack");
    assert!(pack.ok, "{:?}", pack.errors);
    assert_eq!(pack.pack.as_deref(), Some("demo-pack"));
    assert!(
        pack.warnings
            .iter()
            .any(|warning| warning.contains("broken")),
        "{:?}",
        pack.warnings
    );

    let by_name = validate_installed_skill(&root, "radare2").expect("validate child");
    assert!(by_name.ok);
    assert_eq!(by_name.pack.as_deref(), Some("demo-pack"));
    let by_base_dir = validate_installed_skill(&root, "demo-pack/skills/js-reverse")
        .expect("validate child by baseDir");
    assert!(by_base_dir.ok);
    assert_eq!(by_base_dir.name, "js-reverse");

    write_skill_md(&root.join("empty-pack/group/x"), "", "");
    let empty = validate_installed_skill(&root, "empty-pack").expect("validate empty pack");
    assert!(!empty.ok);
    assert!(
        empty.errors[0].contains("no valid SKILL.md"),
        "{:?}",
        empty.errors
    );
}
