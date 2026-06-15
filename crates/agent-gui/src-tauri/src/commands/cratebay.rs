use reqwest::header::{ACCEPT, USER_AGENT};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};
use zip::ZipArchive;

const DEFAULT_CRATEBAY_REPOSITORY: &str = "nicepkg/CrateBay";
const CRATEBAY_INSTALL_DIR: &str = "cratebay-sandbox";
const INSTALL_MANIFEST: &str = "install.json";

#[derive(Debug, Clone, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    prerelease: bool,
    draft: bool,
    html_url: Option<String>,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CrateBayInstallManifest {
    tag_name: String,
    asset_name: String,
    sha256: String,
    installed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateBayReleaseInfo {
    tag_name: String,
    name: Option<String>,
    prerelease: bool,
    release_url: Option<String>,
    asset_name: Option<String>,
    asset_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateBayStatus {
    installed: bool,
    repository: String,
    install_dir: String,
    binary_path: Option<String>,
    manifest: Option<CrateBayInstallManifest>,
    version: Option<String>,
    latest_release: Option<CrateBayReleaseInfo>,
    runtime: Option<CliCommandResult>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCommandResult {
    ok: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    json: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateBayContainerCreateRequest {
    name: String,
    image: String,
    cpu: Option<u32>,
    memory: Option<u64>,
    command: Option<String>,
    entrypoint: Option<String>,
    working_dir: Option<String>,
    env: Option<Vec<String>>,
    publish: Option<Vec<String>>,
    volume: Option<Vec<String>>,
    pod: Option<String>,
    network: Option<String>,
    user: Option<String>,
    read_only: Option<bool>,
    no_start: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateBayContainerRunRequest {
    image: String,
    command: Vec<String>,
    name: Option<String>,
    env: Option<Vec<String>>,
    volume: Option<Vec<String>>,
    cpu: Option<u32>,
    memory: Option<u64>,
    working_dir: Option<String>,
    entrypoint: Option<String>,
    pod: Option<String>,
    network: Option<String>,
    user: Option<String>,
    read_only: Option<bool>,
    no_pull: Option<bool>,
    remove: Option<bool>,
    keep: Option<bool>,
    timeout: Option<u64>,
    max_output_bytes: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateBayExecRequest {
    id: String,
    command: Vec<String>,
    working_dir: Option<String>,
    timeout: Option<u64>,
    max_output_bytes: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateBayTerminalOpenRequest {
    id: String,
    session_id: Option<String>,
    working_dir: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    command: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateBayTerminalSessionRequest {
    id: String,
    session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateBayTerminalInputRequest {
    id: String,
    session_id: String,
    data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateBayTerminalResizeRequest {
    id: String,
    session_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateBayLogsRequest {
    id: String,
    tail: Option<u32>,
    timestamps: Option<bool>,
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn cratebay_repository() -> String {
    std::env::var("LIVEAGENT_CRATEBAY_REPOSITORY")
        .ok()
        .or_else(|| option_env!("LIVEAGENT_CRATEBAY_REPOSITORY").map(str::to_string))
        .map(|value| value.trim().trim_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CRATEBAY_REPOSITORY.to_string())
}

fn install_root(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("failed to resolve app data directory: {err}"))?;
    Ok(data_dir.join(CRATEBAY_INSTALL_DIR))
}

fn binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "cratebay.exe"
    } else {
        "cratebay"
    }
}

fn installed_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(installed_binary_path_from_root(&install_root(app)?))
}

fn installed_binary_path_from_root(root: &Path) -> PathBuf {
    root.join("bin").join(binary_name())
}

fn read_install_manifest(app: &AppHandle) -> Option<CrateBayInstallManifest> {
    read_install_manifest_from_root(&install_root(app).ok()?)
}

fn read_install_manifest_from_root(root: &Path) -> Option<CrateBayInstallManifest> {
    let path = root.join(INSTALL_MANIFEST);
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn parse_json_output(stdout: &str, stderr: &str) -> Option<Value> {
    serde_json::from_str(stdout.trim())
        .ok()
        .or_else(|| serde_json::from_str(stderr.trim()).ok())
}

async fn run_binary(binary: PathBuf, args: Vec<String>) -> Result<CliCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_binary_sync(&binary, args))
        .await
        .map_err(|err| format!("cratebay command task failed: {err}"))?
}

fn run_binary_sync(binary: &Path, args: Vec<String>) -> Result<CliCommandResult, String> {
    let output = Command::new(binary)
        .args(args)
        .output()
        .map_err(|err| format!("failed to execute {}: {err}", binary.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let json = parse_json_output(&stdout, &stderr);
    Ok(CliCommandResult {
        ok: output.status.success(),
        exit_code: output.status.code(),
        stdout,
        stderr,
        json,
    })
}

fn cratebay_cli_args(args: Vec<String>) -> Vec<String> {
    let mut cli_args = vec!["--json".to_string()];
    cli_args.extend(args);
    cli_args
}

fn keep_container_after_run(keep: Option<bool>, remove: Option<bool>) -> bool {
    keep.unwrap_or(false) || remove == Some(false)
}

async fn run_installed_cli(app: &AppHandle, args: Vec<String>) -> Result<CliCommandResult, String> {
    let root = install_root(app)?;
    run_installed_cli_from_root(&root, args).await
}

async fn run_installed_cli_from_root(
    root: &Path,
    args: Vec<String>,
) -> Result<CliCommandResult, String> {
    let binary = installed_binary_path_from_root(root);
    if !binary.is_file() {
        return Err("CrateBay sandbox is not installed. Install it from the Sandbox panel or run CrateBayInstall first.".to_string());
    }
    run_binary(binary, cratebay_cli_args(args)).await
}

#[cfg(test)]
fn run_installed_cli_from_root_sync(
    root: &Path,
    args: Vec<String>,
) -> Result<CliCommandResult, String> {
    let binary = installed_binary_path_from_root(root);
    if !binary.is_file() {
        return Err("CrateBay sandbox is not installed. Install it from the Sandbox panel or run CrateBayInstall first.".to_string());
    }
    run_binary_sync(&binary, cratebay_cli_args(args))
}

async fn installed_version(app: &AppHandle) -> Option<String> {
    let binary = installed_binary_path(app).ok()?;
    if !binary.is_file() {
        return None;
    }
    let result = run_binary(binary, vec!["--version".to_string()])
        .await
        .ok()?;
    let version = result.stdout.trim();
    (!version.is_empty()).then(|| version.to_string())
}

fn platform_tokens() -> Vec<&'static str> {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    let arch_alias = if arch == "x86_64" { "x64" } else { "arm64" };
    vec![os, arch, arch_alias]
}

fn asset_score(name: &str) -> i32 {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".sha256") || lower == "sha256sums.txt" || lower == "sha256sums" {
        return -1;
    }
    let tokens = platform_tokens();
    if !tokens.iter().any(|token| lower.contains(token)) {
        return -1;
    }

    let mut score = 0;
    if lower.contains("headless") {
        score += 60;
    }
    if lower.contains("cli") || lower.contains("sandbox") {
        score += 30;
    }
    if lower.ends_with(".zip") {
        score += 20;
    }
    if lower.starts_with("cratebay")
        || lower.starts_with("cratebay-")
        || lower.starts_with("cratebay_")
    {
        score += 10;
    }
    if lower.contains("gui")
        || lower.ends_with(".dmg")
        || lower.ends_with(".msi")
        || lower.ends_with(".appimage")
    {
        score -= 50;
    }
    score
}

fn select_headless_asset(release: &GitHubRelease) -> Option<GitHubAsset> {
    release
        .assets
        .iter()
        .filter_map(|asset| {
            let score = asset_score(&asset.name);
            (score >= 0).then(|| (score, asset.clone()))
        })
        .max_by_key(|(score, _)| *score)
        .map(|(_, asset)| asset)
}

fn release_info(release: &GitHubRelease) -> CrateBayReleaseInfo {
    let selected = select_headless_asset(release);
    CrateBayReleaseInfo {
        tag_name: release.tag_name.clone(),
        name: release.name.clone(),
        prerelease: release.prerelease,
        release_url: release.html_url.clone(),
        asset_name: selected.as_ref().map(|asset| asset.name.clone()),
        asset_size: selected.as_ref().map(|asset| asset.size),
    }
}

fn parse_release_version(tag_name: &str) -> Option<Version> {
    Version::parse(tag_name.trim().trim_start_matches('v')).ok()
}

fn compare_release_newest_first(a: &GitHubRelease, b: &GitHubRelease) -> Ordering {
    match (
        parse_release_version(&a.tag_name),
        parse_release_version(&b.tag_name),
    ) {
        (Some(left), Some(right)) => right.cmp(&left),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => b.tag_name.cmp(&a.tag_name),
    }
}

fn select_newest_headless_release(mut releases: Vec<GitHubRelease>) -> Option<GitHubRelease> {
    releases.sort_by(compare_release_newest_first);
    releases
        .into_iter()
        .find(|release| select_headless_asset(release).is_some())
}

async fn fetch_releases(include_prerelease: bool) -> Result<Vec<GitHubRelease>, String> {
    let repository = cratebay_repository();
    let url = format!("https://api.github.com/repos/{repository}/releases");
    reqwest::Client::new()
        .get(url)
        .header(USER_AGENT, "LiveAgent CrateBay sandbox installer")
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|err| format!("failed to query CrateBay releases: {err}"))?
        .error_for_status()
        .map_err(|err| format!("CrateBay releases request failed: {err}"))?
        .json::<Vec<GitHubRelease>>()
        .await
        .map_err(|err| format!("failed to parse CrateBay releases: {err}"))
        .map(|releases| {
            releases
                .into_iter()
                .filter(|release| !release.draft && (include_prerelease || !release.prerelease))
                .collect()
        })
}

async fn selected_release(include_prerelease: bool) -> Result<GitHubRelease, String> {
    select_newest_headless_release(fetch_releases(include_prerelease).await?).ok_or_else(|| {
        "No CrateBay release with a matching headless asset was found for this platform."
            .to_string()
    })
}

async fn download_text(url: &str) -> Result<String, String> {
    reqwest::Client::new()
        .get(url)
        .header(USER_AGENT, "LiveAgent CrateBay sandbox installer")
        .send()
        .await
        .map_err(|err| format!("failed to download {url}: {err}"))?
        .error_for_status()
        .map_err(|err| format!("download failed for {url}: {err}"))?
        .text()
        .await
        .map_err(|err| format!("failed to read {url}: {err}"))
}

async fn download_bytes(url: &str) -> Result<Vec<u8>, String> {
    reqwest::Client::new()
        .get(url)
        .header(USER_AGENT, "LiveAgent CrateBay sandbox installer")
        .send()
        .await
        .map_err(|err| format!("failed to download {url}: {err}"))?
        .error_for_status()
        .map_err(|err| format!("download failed for {url}: {err}"))?
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|err| format!("failed to read {url}: {err}"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn parse_sha256_line(line: &str, asset_name: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.len() < 64 {
        return None;
    }
    let hash = &trimmed[..64];
    if !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    if trimmed.len() == 64 || trimmed.contains(asset_name) {
        Some(hash.to_ascii_lowercase())
    } else {
        None
    }
}

async fn expected_sha256(release: &GitHubRelease, asset: &GitHubAsset) -> Result<String, String> {
    let per_asset_name = format!("{}.sha256", asset.name);
    if let Some(checksum_asset) = release
        .assets
        .iter()
        .find(|candidate| candidate.name == per_asset_name)
    {
        let text = download_text(&checksum_asset.browser_download_url).await?;
        if let Some(hash) = text
            .lines()
            .find_map(|line| parse_sha256_line(line, &asset.name))
        {
            return Ok(hash);
        }
    }

    if let Some(checksum_asset) = release
        .assets
        .iter()
        .find(|candidate| candidate.name.eq_ignore_ascii_case("SHA256SUMS.txt"))
    {
        let text = download_text(&checksum_asset.browser_download_url).await?;
        if let Some(hash) = text
            .lines()
            .find_map(|line| parse_sha256_line(line, &asset.name))
        {
            return Ok(hash);
        }
    }

    Err(format!(
        "CrateBay release asset '{}' has no SHA256 checksum asset. Refusing unverified install.",
        asset.name
    ))
}

fn find_extracted_binary(root: &Path) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        let entries = fs::read_dir(&path).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.file_name().and_then(|name| name.to_str()) == Some(binary_name()) {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|err| format!("failed to read permissions for {}: {err}", path.display()))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).map_err(|err| {
        format!(
            "failed to set executable permission on {}: {err}",
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn extract_zip(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let reader = Cursor::new(bytes);
    let mut archive =
        ZipArchive::new(reader).map_err(|err| format!("failed to read CrateBay archive: {err}"))?;

    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|err| format!("failed to read CrateBay archive entry: {err}"))?;
        let Some(enclosed) = file.enclosed_name().map(|path| path.to_path_buf()) else {
            continue;
        };
        let out_path = dest.join(enclosed);
        if file.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|err| format!("failed to create {}: {err}", out_path.display()))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
        }
        let mut out_file = fs::File::create(&out_path)
            .map_err(|err| format!("failed to create {}: {err}", out_path.display()))?;
        std::io::copy(&mut file, &mut out_file)
            .map_err(|err| format!("failed to extract {}: {err}", out_path.display()))?;
    }
    Ok(())
}

fn install_downloaded_asset(
    app: &AppHandle,
    release: &GitHubRelease,
    asset: &GitHubAsset,
    bytes: Vec<u8>,
    sha256: String,
) -> Result<(), String> {
    install_downloaded_asset_to_root(&install_root(app)?, release, asset, bytes, sha256)
}

fn install_downloaded_asset_to_root(
    root: &Path,
    release: &GitHubRelease,
    asset: &GitHubAsset,
    bytes: Vec<u8>,
    sha256: String,
) -> Result<(), String> {
    let parent = root
        .parent()
        .ok_or_else(|| "invalid CrateBay install directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
    let tmp = parent.join(format!("{CRATEBAY_INSTALL_DIR}.tmp"));
    if tmp.exists() {
        fs::remove_dir_all(&tmp)
            .map_err(|err| format!("failed to clean {}: {err}", tmp.display()))?;
    }
    fs::create_dir_all(&tmp).map_err(|err| format!("failed to create {}: {err}", tmp.display()))?;

    if asset.name.to_ascii_lowercase().ends_with(".zip") {
        extract_zip(&bytes, &tmp)?;
    } else {
        let bin_dir = tmp.join("bin");
        fs::create_dir_all(&bin_dir)
            .map_err(|err| format!("failed to create {}: {err}", bin_dir.display()))?;
        fs::write(bin_dir.join(binary_name()), &bytes)
            .map_err(|err| format!("failed to write CrateBay binary: {err}"))?;
    }

    let binary = find_extracted_binary(&tmp).ok_or_else(|| {
        format!(
            "CrateBay binary '{}' was not found in {}",
            binary_name(),
            asset.name
        )
    })?;
    let bin_dir = tmp.join("bin");
    fs::create_dir_all(&bin_dir)
        .map_err(|err| format!("failed to create {}: {err}", bin_dir.display()))?;
    let normalized_binary = bin_dir.join(binary_name());
    if binary != normalized_binary {
        fs::copy(&binary, &normalized_binary).map_err(|err| {
            format!(
                "failed to normalize CrateBay binary from {} to {}: {err}",
                binary.display(),
                normalized_binary.display()
            )
        })?;
    }
    make_executable(&normalized_binary)?;

    let manifest = CrateBayInstallManifest {
        tag_name: release.tag_name.clone(),
        asset_name: asset.name.clone(),
        sha256,
        installed_at: now_rfc3339(),
    };
    fs::write(
        tmp.join(INSTALL_MANIFEST),
        serde_json::to_string_pretty(&manifest)
            .map_err(|err| format!("failed to serialize CrateBay manifest: {err}"))?,
    )
    .map_err(|err| format!("failed to write CrateBay manifest: {err}"))?;

    if root.exists() {
        fs::remove_dir_all(&root)
            .map_err(|err| format!("failed to remove existing {}: {err}", root.display()))?;
    }
    fs::rename(&tmp, &root).map_err(|err| format!("failed to install CrateBay sandbox: {err}"))?;
    Ok(())
}

async fn latest_release_info(include_prerelease: bool) -> Option<CrateBayReleaseInfo> {
    selected_release(include_prerelease)
        .await
        .ok()
        .map(|release| release_info(&release))
}

#[tauri::command]
pub async fn cratebay_status(
    app: AppHandle,
    include_prerelease: Option<bool>,
) -> Result<CrateBayStatus, String> {
    let repository = cratebay_repository();
    let root = install_root(&app)?;
    let binary = installed_binary_path(&app)?;
    let installed = binary.is_file();
    let manifest = read_install_manifest(&app);
    let version = installed_version(&app).await;
    let runtime = if installed {
        run_installed_cli(&app, vec!["runtime".into(), "status".into()])
            .await
            .ok()
    } else {
        None
    };

    Ok(CrateBayStatus {
        installed,
        repository,
        install_dir: root.display().to_string(),
        binary_path: installed.then(|| binary.display().to_string()),
        manifest,
        version,
        latest_release: latest_release_info(include_prerelease.unwrap_or(false)).await,
        runtime,
        error: None,
    })
}

#[tauri::command]
pub async fn cratebay_install(
    app: AppHandle,
    include_prerelease: Option<bool>,
) -> Result<CrateBayStatus, String> {
    let release = selected_release(include_prerelease.unwrap_or(false)).await?;
    let asset = select_headless_asset(&release)
        .ok_or_else(|| "selected release does not include a headless asset".to_string())?;
    let expected = expected_sha256(&release, &asset).await?;
    let bytes = download_bytes(&asset.browser_download_url).await?;
    let actual = sha256_hex(&bytes);
    if actual != expected {
        return Err(format!(
            "CrateBay asset checksum mismatch for {}: expected {}, got {}",
            asset.name, expected, actual
        ));
    }
    install_downloaded_asset(&app, &release, &asset, bytes, actual)?;
    cratebay_status(app, include_prerelease).await
}

#[tauri::command]
pub async fn cratebay_update(
    app: AppHandle,
    include_prerelease: Option<bool>,
) -> Result<CrateBayStatus, String> {
    cratebay_install(app, include_prerelease).await
}

#[tauri::command]
pub async fn cratebay_uninstall(app: AppHandle) -> Result<CrateBayStatus, String> {
    let root = install_root(&app)?;
    if root.exists() {
        fs::remove_dir_all(&root)
            .map_err(|err| format!("failed to remove {}: {err}", root.display()))?;
    }
    cratebay_status(app, Some(false)).await
}

#[tauri::command]
pub async fn cratebay_runtime_status(app: AppHandle) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["runtime".into(), "status".into()]).await
}

#[tauri::command]
pub async fn cratebay_runtime_start(app: AppHandle) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["runtime".into(), "start".into()]).await
}

#[tauri::command]
pub async fn cratebay_runtime_stop(app: AppHandle) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["runtime".into(), "stop".into()]).await
}

#[tauri::command]
pub async fn cratebay_engine_status(app: AppHandle) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "status".into()]).await
}

#[tauri::command]
pub async fn cratebay_engine_substrate(app: AppHandle) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "substrate".into()]).await
}

#[tauri::command]
pub async fn cratebay_engine_storage_gc(
    app: AppHandle,
    apply: Option<bool>,
    prune_exited_containers: Option<bool>,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["engine".into(), "storage-gc".into()];
    if apply.unwrap_or(false) {
        args.push("--apply".into());
    }
    if prune_exited_containers == Some(false) {
        args.push("--prune-exited-containers=false".into());
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_shim_tasks(app: AppHandle) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "shim-tasks".into()]).await
}

#[tauri::command]
pub async fn cratebay_engine_shim_reap(
    app: AppHandle,
    id: String,
    apply: Option<bool>,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["engine".into(), "reap-shim-task".into(), id];
    if apply.unwrap_or(false) {
        args.push("--apply".into());
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_containers(app: AppHandle) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "containers".into()]).await
}

#[tauri::command]
pub async fn cratebay_engine_images(app: AppHandle) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "images".into()]).await
}

#[tauri::command]
pub async fn cratebay_engine_image_pull(
    app: AppHandle,
    image: String,
    tag: Option<String>,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["engine".into(), "pull-image".into(), image];
    push_optional(&mut args, "--tag", tag);
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_image_inspect(
    app: AppHandle,
    id: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "inspect-image".into(), id]).await
}

#[tauri::command]
pub async fn cratebay_engine_image_remove(
    app: AppHandle,
    id: String,
    force: Option<bool>,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["engine".into(), "remove-image".into(), id];
    if force.unwrap_or(false) {
        args.push("--force".into());
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_image_tag(
    app: AppHandle,
    source: String,
    target: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(
        &app,
        vec!["engine".into(), "tag-image".into(), source, target],
    )
    .await
}

#[tauri::command]
pub async fn cratebay_engine_image_pack(
    app: AppHandle,
    container: String,
    image: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(
        &app,
        vec!["engine".into(), "pack-image".into(), container, image],
    )
    .await
}

#[tauri::command]
pub async fn cratebay_engine_image_export(
    app: AppHandle,
    images: Vec<String>,
    output: String,
) -> Result<CliCommandResult, String> {
    let mut args = vec![
        "engine".into(),
        "export-images".into(),
        "--output".into(),
        output,
    ];
    args.extend(images);
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_image_import(
    app: AppHandle,
    input: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "import-image".into(), input]).await
}

#[tauri::command]
pub async fn cratebay_engine_networks(app: AppHandle) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "networks".into()]).await
}

#[tauri::command]
pub async fn cratebay_engine_network_inspect(
    app: AppHandle,
    id: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "inspect-network".into(), id]).await
}

#[tauri::command]
pub async fn cratebay_engine_network_create(
    app: AppHandle,
    name: String,
    driver: Option<String>,
    internal: Option<bool>,
    enable_ipv6: Option<bool>,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["engine".into(), "create-network".into(), name];
    push_optional(&mut args, "--driver", driver);
    if internal.unwrap_or(false) {
        args.push("--internal".into());
    }
    if enable_ipv6.unwrap_or(false) {
        args.push("--ipv6".into());
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_network_remove(
    app: AppHandle,
    id: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "remove-network".into(), id]).await
}

#[tauri::command]
pub async fn cratebay_engine_volumes(app: AppHandle) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "volumes".into()]).await
}

#[tauri::command]
pub async fn cratebay_engine_volume_inspect(
    app: AppHandle,
    name: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "inspect-volume".into(), name]).await
}

#[tauri::command]
pub async fn cratebay_engine_volume_create(
    app: AppHandle,
    name: String,
    driver: Option<String>,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["engine".into(), "create-volume".into(), name];
    push_optional(&mut args, "--driver", driver);
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_volume_remove(
    app: AppHandle,
    name: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "remove-volume".into(), name]).await
}

#[tauri::command]
pub async fn cratebay_engine_pods(app: AppHandle) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "pods".into()]).await
}

#[tauri::command]
pub async fn cratebay_engine_pod_create(
    app: AppHandle,
    name: String,
    driver: Option<String>,
    internal: Option<bool>,
    enable_ipv6: Option<bool>,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["engine".into(), "create-pod".into(), name];
    push_optional(&mut args, "--driver", driver);
    if internal.unwrap_or(false) {
        args.push("--internal".into());
    }
    if enable_ipv6.unwrap_or(false) {
        args.push("--ipv6".into());
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_pod_remove(
    app: AppHandle,
    name: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "remove-pod".into(), name]).await
}

#[tauri::command]
pub async fn cratebay_engine_pod_attach(
    app: AppHandle,
    name: String,
    container: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["pod".into(), "add".into(), name, container]).await
}

#[tauri::command]
pub async fn cratebay_engine_pod_detach(
    app: AppHandle,
    name: String,
    container: String,
    force: Option<bool>,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["pod".into(), "remove".into(), name, container];
    if force.unwrap_or(false) {
        args.push("--force".into());
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_container_create(
    app: AppHandle,
    request: CrateBayContainerCreateRequest,
) -> Result<CliCommandResult, String> {
    let mut args = vec![
        "engine".into(),
        "create".into(),
        request.name,
        "--image".into(),
        request.image,
    ];
    push_optional_number(&mut args, "--cpu", request.cpu);
    push_optional_number(&mut args, "--memory", request.memory);
    push_optional(&mut args, "--command", request.command);
    push_optional(&mut args, "--entrypoint", request.entrypoint);
    push_optional(&mut args, "--working-dir", request.working_dir);
    push_repeated(&mut args, "--env", request.env);
    push_repeated(&mut args, "--publish", request.publish);
    push_repeated(&mut args, "--volume", request.volume);
    push_optional(&mut args, "--pod", request.pod);
    push_optional(&mut args, "--network", request.network);
    push_optional(&mut args, "--user", request.user);
    if request.read_only.unwrap_or(false) {
        args.push("--read-only".into());
    }
    if request.no_start.unwrap_or(false) {
        args.push("--no-start".into());
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_container_run(
    app: AppHandle,
    request: CrateBayContainerRunRequest,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["engine".into(), "run".into()];
    push_optional(&mut args, "--name", request.name);
    push_repeated(&mut args, "--env", request.env);
    push_repeated(&mut args, "--volume", request.volume);
    push_optional_number(&mut args, "--cpu", request.cpu);
    push_optional_number(&mut args, "--memory", request.memory);
    push_optional(&mut args, "--working-dir", request.working_dir);
    push_optional(&mut args, "--entrypoint", request.entrypoint);
    push_optional(&mut args, "--pod", request.pod);
    push_optional(&mut args, "--network", request.network);
    push_optional(&mut args, "--user", request.user);
    if request.read_only.unwrap_or(false) {
        args.push("--read-only".into());
    }
    if request.no_pull.unwrap_or(false) {
        args.push("--no-pull".into());
    }
    if keep_container_after_run(request.keep, request.remove) {
        args.push("--keep".into());
    }
    push_optional_number(&mut args, "--timeout", request.timeout);
    push_optional_number(&mut args, "--max-output-bytes", request.max_output_bytes);
    args.push(request.image);
    args.push("--".into());
    args.extend(request.command);
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_container_start(
    app: AppHandle,
    id: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "start".into(), id]).await
}

#[tauri::command]
pub async fn cratebay_engine_container_stop(
    app: AppHandle,
    id: String,
    timeout: Option<u64>,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["engine".into(), "stop".into(), id];
    push_optional_number(&mut args, "--timeout", timeout);
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_container_remove(
    app: AppHandle,
    id: String,
    force: Option<bool>,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["engine".into(), "remove".into(), id];
    if force.unwrap_or(false) {
        args.push("--force".into());
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_container_inspect(
    app: AppHandle,
    id: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "inspect".into(), id]).await
}

#[tauri::command]
pub async fn cratebay_engine_container_stats(
    app: AppHandle,
    id: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["engine".into(), "stats".into(), id]).await
}

#[tauri::command]
pub async fn cratebay_engine_container_logs(
    app: AppHandle,
    request: CrateBayLogsRequest,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["engine".into(), "logs".into(), request.id];
    push_optional_number(&mut args, "--tail", request.tail);
    if request.timestamps.unwrap_or(false) {
        args.push("--timestamps".into());
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_container_exec(
    app: AppHandle,
    request: CrateBayExecRequest,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["engine".into(), "exec".into(), request.id];
    push_optional(&mut args, "--working-dir", request.working_dir);
    push_optional_number(&mut args, "--timeout", request.timeout);
    push_optional_number(&mut args, "--max-output-bytes", request.max_output_bytes);
    args.push("--".into());
    args.extend(request.command);
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_terminal_open(
    app: AppHandle,
    request: CrateBayTerminalOpenRequest,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["engine".into(), "terminal-open".into(), request.id];
    push_optional(&mut args, "--session-id", request.session_id);
    push_optional_number(&mut args, "--cols", request.cols);
    push_optional_number(&mut args, "--rows", request.rows);
    push_optional(&mut args, "--working-dir", request.working_dir);
    if let Some(command) = request.command.filter(|command| !command.is_empty()) {
        args.push("--".into());
        args.extend(command);
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_engine_terminal_input(
    app: AppHandle,
    request: CrateBayTerminalInputRequest,
) -> Result<CliCommandResult, String> {
    run_installed_cli(
        &app,
        vec![
            "engine".into(),
            "terminal-input".into(),
            request.id,
            "--session-id".into(),
            request.session_id,
            "--data".into(),
            request.data,
        ],
    )
    .await
}

#[tauri::command]
pub async fn cratebay_engine_terminal_read(
    app: AppHandle,
    request: CrateBayTerminalSessionRequest,
) -> Result<CliCommandResult, String> {
    run_installed_cli(
        &app,
        vec![
            "engine".into(),
            "terminal-read".into(),
            request.id,
            "--session-id".into(),
            request.session_id,
        ],
    )
    .await
}

#[tauri::command]
pub async fn cratebay_engine_terminal_resize(
    app: AppHandle,
    request: CrateBayTerminalResizeRequest,
) -> Result<CliCommandResult, String> {
    run_installed_cli(
        &app,
        vec![
            "engine".into(),
            "terminal-resize".into(),
            request.id,
            "--session-id".into(),
            request.session_id,
            "--cols".into(),
            request.cols.to_string(),
            "--rows".into(),
            request.rows.to_string(),
        ],
    )
    .await
}

#[tauri::command]
pub async fn cratebay_engine_terminal_close(
    app: AppHandle,
    request: CrateBayTerminalSessionRequest,
) -> Result<CliCommandResult, String> {
    run_installed_cli(
        &app,
        vec![
            "engine".into(),
            "terminal-close".into(),
            request.id,
            "--session-id".into(),
            request.session_id,
        ],
    )
    .await
}

#[tauri::command]
pub async fn cratebay_container_list(
    app: AppHandle,
    all: Option<bool>,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["container".into(), "list".into()];
    if all.unwrap_or(true) {
        args.push("--all".into());
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_container_create(
    app: AppHandle,
    request: CrateBayContainerCreateRequest,
) -> Result<CliCommandResult, String> {
    let mut args = vec![
        "container".into(),
        "create".into(),
        request.name,
        "--image".into(),
        request.image,
    ];
    push_optional_number(&mut args, "--cpu", request.cpu);
    push_optional_number(&mut args, "--memory", request.memory);
    push_optional(&mut args, "--command", request.command);
    push_optional(&mut args, "--entrypoint", request.entrypoint);
    push_optional(&mut args, "--working-dir", request.working_dir);
    push_repeated(&mut args, "--env", request.env);
    push_repeated(&mut args, "--publish", request.publish);
    push_repeated(&mut args, "--volume", request.volume);
    push_optional(&mut args, "--pod", request.pod);
    push_optional(&mut args, "--network", request.network);
    push_optional(&mut args, "--user", request.user);
    if request.read_only.unwrap_or(false) {
        args.push("--read-only".into());
    }
    if request.no_start.unwrap_or(false) {
        args.push("--no-start".into());
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_container_run(
    app: AppHandle,
    request: CrateBayContainerRunRequest,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["run".into()];
    push_optional(&mut args, "--name", request.name);
    push_repeated(&mut args, "--env", request.env);
    push_repeated(&mut args, "--volume", request.volume);
    push_optional_number(&mut args, "--cpu", request.cpu);
    push_optional_number(&mut args, "--memory", request.memory);
    push_optional(&mut args, "--working-dir", request.working_dir);
    push_optional(&mut args, "--entrypoint", request.entrypoint);
    push_optional(&mut args, "--pod", request.pod);
    push_optional(&mut args, "--network", request.network);
    push_optional(&mut args, "--user", request.user);
    push_optional_number(&mut args, "--timeout", request.timeout);
    push_optional_number(&mut args, "--max-output-bytes", request.max_output_bytes);
    args.push("--no-propagate-exit-code".into());
    if request.read_only.unwrap_or(false) {
        args.push("--read-only".into());
    }
    if request.no_pull.unwrap_or(false) {
        args.push("--no-pull".into());
    }
    if keep_container_after_run(request.keep, request.remove) {
        args.push("--keep".into());
    }
    args.push(request.image);
    args.push("--".into());
    args.extend(request.command);
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_container_exec(
    app: AppHandle,
    request: CrateBayExecRequest,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["container".into(), "exec".into(), request.id];
    push_optional(&mut args, "--working-dir", request.working_dir);
    push_optional_number(&mut args, "--timeout", request.timeout);
    push_optional_number(&mut args, "--max-output-bytes", request.max_output_bytes);
    args.push("--no-propagate-exit-code".into());
    args.push("--".into());
    args.extend(request.command);
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_container_logs(
    app: AppHandle,
    request: CrateBayLogsRequest,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["container".into(), "logs".into(), request.id];
    push_optional_number(&mut args, "--tail", request.tail);
    if request.timestamps.unwrap_or(false) {
        args.push("--timestamps".into());
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_container_inspect(
    app: AppHandle,
    id: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["container".into(), "inspect".into(), id]).await
}

#[tauri::command]
pub async fn cratebay_container_remove(
    app: AppHandle,
    id: String,
    force: Option<bool>,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["container".into(), "delete".into(), id];
    if force.unwrap_or(false) {
        args.push("--force".into());
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_pod_list(app: AppHandle) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["pod".into(), "list".into()]).await
}

#[tauri::command]
pub async fn cratebay_pod_create(app: AppHandle, name: String) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["pod".into(), "create".into(), name]).await
}

#[tauri::command]
pub async fn cratebay_pod_delete(
    app: AppHandle,
    name: String,
    force: Option<bool>,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["pod".into(), "delete".into(), name];
    if force.unwrap_or(false) {
        args.push("--force".into());
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_pod_add(
    app: AppHandle,
    name: String,
    container: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["pod".into(), "add".into(), name, container]).await
}

#[tauri::command]
pub async fn cratebay_pod_remove(
    app: AppHandle,
    name: String,
    container: String,
    force: Option<bool>,
) -> Result<CliCommandResult, String> {
    let mut args = vec!["pod".into(), "remove".into(), name, container];
    if force.unwrap_or(false) {
        args.push("--force".into());
    }
    run_installed_cli(&app, args).await
}

#[tauri::command]
pub async fn cratebay_image_list(app: AppHandle) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["image".into(), "list".into()]).await
}

#[tauri::command]
pub async fn cratebay_image_pull(
    app: AppHandle,
    image: String,
) -> Result<CliCommandResult, String> {
    run_installed_cli(&app, vec!["image".into(), "pull".into(), image]).await
}

fn push_optional(args: &mut Vec<String>, flag: &str, value: Option<String>) {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        args.push(flag.to_string());
        args.push(value);
    }
}

fn push_optional_number<T: ToString>(args: &mut Vec<String>, flag: &str, value: Option<T>) {
    if let Some(value) = value {
        args.push(flag.to_string());
        args.push(value.to_string());
    }
}

fn push_repeated(args: &mut Vec<String>, flag: &str, values: Option<Vec<String>>) {
    for value in values.unwrap_or_default() {
        if value.trim().is_empty() {
            continue;
        }
        args.push(flag.to_string());
        args.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        asset_score, binary_name, install_downloaded_asset_to_root,
        installed_binary_path_from_root, keep_container_after_run, parse_sha256_line,
        platform_tokens, read_install_manifest_from_root, run_installed_cli_from_root_sync,
        select_headless_asset, select_newest_headless_release, sha256_hex, GitHubAsset,
        GitHubRelease,
    };
    use std::fs;
    use std::io::{Cursor, Write};
    use tempfile::tempdir;
    use zip::write::FileOptions;

    fn headless_asset(tag_name: &str) -> GitHubAsset {
        let tokens = platform_tokens();
        GitHubAsset {
            name: format!(
                "CrateBay-{tag_name}-headless-{}-{}.zip",
                tokens[0], tokens[1]
            ),
            browser_download_url: format!("https://example.test/{tag_name}.zip"),
            size: 42,
        }
    }

    fn desktop_asset(tag_name: &str) -> GitHubAsset {
        let tokens = platform_tokens();
        GitHubAsset {
            name: format!("CrateBay-{tag_name}-{}-{}.dmg", tokens[0], tokens[1]),
            browser_download_url: format!("https://example.test/{tag_name}.dmg"),
            size: 42,
        }
    }

    fn release(tag_name: &str, assets: Vec<GitHubAsset>) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag_name.to_string(),
            name: Some(tag_name.to_string()),
            prerelease: false,
            draft: false,
            html_url: None,
            assets,
        }
    }

    fn synthetic_headless_zip(binary_contents: &[u8]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut archive = zip::ZipWriter::new(cursor);
        let file_options = FileOptions::default().unix_permissions(0o644);
        let binary_options = FileOptions::default().unix_permissions(0o755);

        archive
            .start_file(format!("bin/{}", binary_name()), binary_options)
            .expect("start binary entry");
        archive
            .write_all(binary_contents)
            .expect("write binary entry");

        archive
            .start_file(
                "resources/runtime-images/cratebay-runtime-test/vmlinuz",
                file_options,
            )
            .expect("start runtime image entry");
        archive
            .write_all(b"synthetic kernel")
            .expect("write runtime image entry");

        archive
            .start_file("README.txt", file_options)
            .expect("start readme entry");
        archive
            .write_all(b"synthetic CrateBay headless package")
            .expect("write readme entry");

        archive.finish().expect("finish archive").into_inner()
    }

    #[test]
    fn ignores_desktop_assets_for_headless_install() {
        assert!(asset_score("CrateBay-v1.0.0-macOS-aarch64.dmg") < 30);
    }

    #[test]
    fn selects_newest_semver_headless_release() {
        let selected = select_newest_headless_release(vec![
            release("v1.0.0", vec![headless_asset("v1.0.0")]),
            release("v2.0.0", vec![desktop_asset("v2.0.0")]),
            release("v1.2.0", vec![headless_asset("v1.2.0")]),
        ])
        .expect("matching headless release");

        assert_eq!(selected.tag_name, "v1.2.0");
        assert!(select_headless_asset(&selected).is_some());
    }

    #[test]
    fn parses_sha256_sum_lines() {
        let hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_sha256_line(
                &format!("{hash}  CrateBay-v1.0.0-headless-macos-aarch64.zip"),
                "CrateBay-v1.0.0-headless-macos-aarch64.zip"
            ),
            Some(hash.to_string())
        );
    }

    #[test]
    fn maps_remove_false_to_keep_for_run_commands() {
        assert!(!keep_container_after_run(None, None));
        assert!(!keep_container_after_run(Some(false), Some(true)));
        assert!(keep_container_after_run(None, Some(false)));
        assert!(keep_container_after_run(Some(true), Some(true)));
    }

    #[test]
    fn installs_headless_zip_to_requested_root() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join("cratebay-sandbox");
        let asset = headless_asset("v1.2.3");
        let release = release("v1.2.3", vec![asset.clone()]);
        let archive = synthetic_headless_zip(b"synthetic cratebay binary");
        let hash = sha256_hex(&archive);

        install_downloaded_asset_to_root(&root, &release, &asset, archive, hash.clone())
            .expect("install synthetic headless package");

        assert!(installed_binary_path_from_root(&root).is_file());
        assert!(root
            .join("resources/runtime-images/cratebay-runtime-test/vmlinuz")
            .is_file());

        let manifest = read_install_manifest_from_root(&root).expect("install manifest");
        assert_eq!(manifest.tag_name, "v1.2.3");
        assert_eq!(manifest.asset_name, asset.name);
        assert_eq!(manifest.sha256, hash);
    }

    #[cfg(unix)]
    #[test]
    fn runs_installed_cli_with_json_prefix_and_parses_output() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join("cratebay-sandbox");
        let bin_dir = root.join("bin");
        fs::create_dir_all(&bin_dir).expect("create bin dir");
        let binary = installed_binary_path_from_root(&root);
        fs::write(
            &binary,
            r#"#!/bin/sh
printf '{"state":"ready","firstArg":"%s","secondArg":"%s","thirdArg":"%s"}\n' "$1" "$2" "$3"
"#,
        )
        .expect("write fake cratebay");
        super::make_executable(&binary).expect("fake cratebay executable");

        let result = run_installed_cli_from_root_sync(
            &root,
            vec!["runtime".to_string(), "status".to_string()],
        )
        .expect("run fake cratebay");

        assert!(result.ok);
        let json = result.json.expect("json output");
        assert_eq!(json["state"], "ready");
        assert_eq!(json["firstArg"], "--json");
        assert_eq!(json["secondArg"], "runtime");
        assert_eq!(json["thirdArg"], "status");
    }
}
