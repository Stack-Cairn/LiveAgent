use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::ZipArchive;

use super::manifest::load_manifest;
use super::types::{PluginInstallOptions, PluginManifest, PluginRuntimeKind, PluginTrustLevel};

const MAX_PACKAGE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PACKAGE_FILES: usize = 4096;
const MAX_INTEGRITY_BYTES: u64 = 1024 * 1024;

#[derive(Debug)]
pub struct PreparedPluginPackage {
    pub manifest: PluginManifest,
    pub package_hash: String,
    pub trust_level: PluginTrustLevel,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IntegrityManifest {
    algorithm: String,
    files: BTreeMap<String, String>,
}

pub fn prepare_plugin_package(
    source: &Path,
    plugins_root: &Path,
    options: &PluginInstallOptions,
) -> Result<PreparedPluginPackage, String> {
    let staging_root = plugins_root.join("staging");
    let store_root = plugins_root.join("store");
    fs::create_dir_all(&staging_root)
        .map_err(|error| format!("创建插件 staging 目录失败：{error}"))?;
    fs::create_dir_all(&store_root).map_err(|error| format!("创建插件 store 目录失败：{error}"))?;

    let staging = staging_root.join(format!("package-{}", Uuid::new_v4()));
    fs::create_dir(&staging).map_err(|error| format!("创建插件 staging 包失败：{error}"))?;
    let staged_result = if source.is_dir() {
        copy_directory(source, &staging)
    } else if source.is_file() {
        extract_archive(source, &staging)
    } else {
        Err(format!("插件源不存在：{}", source.display()))
    };
    if let Err(error) = staged_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let result = (|| {
        let manifest = load_manifest(&staging)?;
        if manifest.runtime.kind == PluginRuntimeKind::Process && !options.allow_full_trust {
            return Err("该插件需要 Full Trust 进程权限，安装时必须显式确认".to_string());
        }
        let integrity_verified = verify_integrity_manifest(&staging)?;
        if !integrity_verified && !options.allow_unsigned {
            return Err("插件未提供可验证的 integrity.json，需以开发者模式显式安装".to_string());
        }
        let package_hash = compute_package_hash(&staging)?;
        let destination = store_root.join(&package_hash);
        if destination.exists() {
            fs::remove_dir_all(&staging)
                .map_err(|error| format!("清理重复插件 staging 失败：{error}"))?;
        } else {
            fs::rename(&staging, &destination)
                .map_err(|error| format!("原子安装插件包失败：{error}"))?;
        }
        let trust_level = if manifest.runtime.kind == PluginRuntimeKind::Process {
            PluginTrustLevel::FullTrustProcess
        } else if integrity_verified {
            PluginTrustLevel::IntegrityVerified
        } else {
            PluginTrustLevel::UnsignedDeveloper
        };
        Ok(PreparedPluginPackage {
            manifest,
            package_hash,
            trust_level,
        })
    })();

    if result.is_err() && staging.exists() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}

pub fn compute_package_hash(root: &Path) -> Result<String, String> {
    let mut files = collect_package_files(root)?;
    files.sort();
    let mut digest = Sha256::new();
    for path in files {
        let relative = path
            .strip_prefix(root)
            .map_err(|error| format!("计算插件相对路径失败：{error}"))?;
        let relative = relative.to_string_lossy().replace('\\', "/");
        digest.update((relative.len() as u64).to_le_bytes());
        digest.update(relative.as_bytes());
        let mut file = File::open(&path)
            .map_err(|error| format!("读取插件文件 {} 失败：{error}", path.display()))?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|error| format!("读取插件文件 {} 失败：{error}", path.display()))?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
    }
    Ok(hex_digest(digest.finalize().as_slice()))
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    let source = source
        .canonicalize()
        .map_err(|error| format!("解析插件源目录失败：{error}"))?;
    let destination = destination
        .canonicalize()
        .map_err(|error| format!("解析插件 staging 目录失败：{error}"))?;
    if destination.starts_with(&source) {
        return Err("插件源目录不能包含 LiveAgent 插件管理目录".to_string());
    }
    let mut total_bytes = 0_u64;
    let mut file_count = 0_usize;
    let mut seen = HashSet::new();
    for entry in WalkDir::new(&source).follow_links(false) {
        let entry = entry.map_err(|error| format!("遍历插件目录失败：{error}"))?;
        let path = entry.path();
        if path == source {
            continue;
        }
        let relative = path
            .strip_prefix(&source)
            .map_err(|error| format!("解析插件相对路径失败：{error}"))?;
        validate_relative_path(relative)?;
        let normalized = relative
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        if !seen.insert(normalized) {
            return Err(format!(
                "插件包包含重复或大小写冲突路径：{}",
                relative.display()
            ));
        }
        let file_type = entry.file_type();
        if file_type.is_symlink() {
            return Err(format!("插件包不允许符号链接：{}", relative.display()));
        }
        let target = destination.join(relative);
        if file_type.is_dir() {
            fs::create_dir_all(&target)
                .map_err(|error| format!("创建插件目录失败 {}：{error}", target.display()))?;
            continue;
        }
        if !file_type.is_file() {
            return Err(format!(
                "插件包包含不支持的文件类型：{}",
                relative.display()
            ));
        }
        file_count += 1;
        if file_count > MAX_PACKAGE_FILES {
            return Err(format!("插件包文件数量超过 {MAX_PACKAGE_FILES} 限制"));
        }
        let size = entry
            .metadata()
            .map_err(|error| format!("读取插件文件元数据失败：{error}"))?
            .len();
        validate_file_size(size, &mut total_bytes)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建插件父目录失败：{error}"))?;
        }
        fs::copy(path, &target)
            .map_err(|error| format!("复制插件文件 {} 失败：{error}", relative.display()))?;
    }
    Ok(())
}

fn extract_archive(source: &Path, destination: &Path) -> Result<(), String> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case("lap") && !extension.eq_ignore_ascii_case("zip") {
        return Err("插件文件必须使用 .lap 或 .zip 扩展名".to_string());
    }
    let file = File::open(source).map_err(|error| format!("打开插件包失败：{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("解析插件包失败：{error}"))?;
    if archive.len() > MAX_PACKAGE_FILES {
        return Err(format!("插件包文件数量超过 {MAX_PACKAGE_FILES} 限制"));
    }
    let mut total_bytes = 0_u64;
    let mut seen = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取插件压缩项失败：{error}"))?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| format!("插件包包含越界路径：{}", entry.name()))?
            .to_path_buf();
        validate_relative_path(&enclosed)?;
        let normalized = enclosed
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        if !seen.insert(normalized) {
            return Err(format!(
                "插件包包含重复或大小写冲突路径：{}",
                enclosed.display()
            ));
        }
        if entry
            .unix_mode()
            .map(|mode| mode & 0o170000 == 0o120000)
            .unwrap_or(false)
        {
            return Err(format!("插件包不允许符号链接：{}", enclosed.display()));
        }
        let target = destination.join(&enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|error| format!("创建插件目录失败：{error}"))?;
            continue;
        }
        validate_file_size(entry.size(), &mut total_bytes)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建插件父目录失败：{error}"))?;
        }
        let mut output = File::create(&target)
            .map_err(|error| format!("创建插件文件失败 {}：{error}", target.display()))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("解压插件文件失败 {}：{error}", target.display()))?;
        output
            .flush()
            .map_err(|error| format!("写入插件文件失败 {}：{error}", target.display()))?;
    }
    Ok(())
}

fn verify_integrity_manifest(root: &Path) -> Result<bool, String> {
    let path = root.join("integrity.json");
    if !path.exists() {
        return Ok(false);
    }
    let metadata =
        fs::metadata(&path).map_err(|error| format!("读取 integrity.json 元数据失败：{error}"))?;
    if metadata.len() > MAX_INTEGRITY_BYTES {
        return Err("integrity.json 超过 1 MiB 限制".to_string());
    }
    let bytes = fs::read(&path).map_err(|error| format!("读取 integrity.json 失败：{error}"))?;
    let integrity: IntegrityManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("解析 integrity.json 失败：{error}"))?;
    if !integrity.algorithm.eq_ignore_ascii_case("sha256") {
        return Err("integrity.json 仅支持 sha256".to_string());
    }
    let files = collect_package_files(root)?;
    let expected_files = files
        .iter()
        .filter_map(|path| {
            let relative = path
                .strip_prefix(root)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            (relative != "integrity.json").then_some(relative)
        })
        .collect::<HashSet<_>>();
    let declared_files = integrity.files.keys().cloned().collect::<HashSet<_>>();
    if expected_files != declared_files {
        return Err("integrity.json 文件清单与插件包内容不一致".to_string());
    }
    for (relative, expected_hash) in integrity.files {
        validate_relative_path(Path::new(&relative))?;
        let bytes = fs::read(root.join(&relative))
            .map_err(|error| format!("读取完整性文件 {relative} 失败：{error}"))?;
        let actual = hex_digest(Sha256::digest(bytes).as_slice());
        if !actual.eq_ignore_ascii_case(expected_hash.trim_start_matches("sha256-")) {
            return Err(format!("插件文件完整性校验失败：{relative}"));
        }
    }
    Ok(true)
}

fn collect_package_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|error| format!("遍历插件包失败：{error}"))?;
        if entry.file_type().is_symlink() {
            return Err(format!("插件包不允许符号链接：{}", entry.path().display()));
        }
        if entry.file_type().is_file() {
            files.push(entry.path().to_path_buf());
        }
    }
    Ok(files)
}

fn validate_relative_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err("插件包包含无效路径".to_string());
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!("插件包包含越界路径：{}", path.display()));
    }
    Ok(())
}

fn validate_file_size(size: u64, total_bytes: &mut u64) -> Result<(), String> {
    if size > MAX_FILE_BYTES {
        return Err(format!(
            "插件单文件超过 {} MiB 限制",
            MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    *total_bytes = total_bytes.saturating_add(size);
    if *total_bytes > MAX_PACKAGE_BYTES {
        return Err(format!(
            "插件解压后超过 {} MiB 限制",
            MAX_PACKAGE_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
