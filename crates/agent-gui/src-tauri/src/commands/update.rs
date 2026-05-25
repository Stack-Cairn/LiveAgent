use std::time::Duration;

use reqwest::header::{ACCEPT, USER_AGENT};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Url};
use tauri_plugin_updater::UpdaterExt;

const DEFAULT_UPDATE_REPOSITORY: &str = "Stack-Cairn/LiveAgent";
const UPDATE_MANIFEST_ASSET: &str = "latest.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheckResponse {
    configured: bool,
    available: bool,
    current_version: String,
    version: Option<String>,
    date: Option<String>,
    body: Option<String>,
    channel: AppUpdateChannel,
    release_tag: Option<String>,
    release_name: Option<String>,
    release_url: Option<String>,
    repository: String,
    message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum AppUpdateChannel {
    Stable,
    Prerelease,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    draft: bool,
    prerelease: bool,
    html_url: Option<String>,
    published_at: Option<String>,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Clone)]
struct SelectedRelease {
    tag_name: String,
    name: Option<String>,
    prerelease: bool,
    html_url: Option<String>,
    published_at: Option<String>,
    manifest_url: String,
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn update_repository() -> String {
    std::env::var("LIVEAGENT_UPDATE_REPOSITORY")
        .ok()
        .or_else(|| option_env!("LIVEAGENT_UPDATE_REPOSITORY").map(str::to_string))
        .map(|value| value.trim().trim_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_UPDATE_REPOSITORY.to_string())
}

fn updater_public_key() -> Option<String> {
    std::env::var("LIVEAGENT_UPDATER_PUBLIC_KEY")
        .ok()
        .or_else(|| option_env!("LIVEAGENT_UPDATER_PUBLIC_KEY").map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn requested_channel(include_prerelease: bool) -> AppUpdateChannel {
    if include_prerelease {
        AppUpdateChannel::Prerelease
    } else {
        AppUpdateChannel::Stable
    }
}

fn release_channel(release: &SelectedRelease) -> AppUpdateChannel {
    if release.prerelease {
        AppUpdateChannel::Prerelease
    } else {
        AppUpdateChannel::Stable
    }
}

fn version_from_tag(tag_name: &str) -> String {
    tag_name.trim().trim_start_matches('v').to_string()
}

fn unconfigured_response(
    app: &AppHandle,
    include_prerelease: bool,
    repository: String,
) -> AppUpdateCheckResponse {
    AppUpdateCheckResponse {
        configured: false,
        available: false,
        current_version: current_version(app),
        version: None,
        date: None,
        body: None,
        channel: requested_channel(include_prerelease),
        release_tag: None,
        release_name: None,
        release_url: None,
        repository,
        message: Some("Updater public key is not configured.".to_string()),
    }
}

fn response_for_release(
    app: &AppHandle,
    repository: String,
    release: &SelectedRelease,
    available: bool,
    update_version: Option<String>,
    update_date: Option<String>,
    update_body: Option<String>,
) -> AppUpdateCheckResponse {
    AppUpdateCheckResponse {
        configured: true,
        available,
        current_version: current_version(app),
        version: update_version.or_else(|| Some(version_from_tag(&release.tag_name))),
        date: update_date.or_else(|| release.published_at.clone()),
        body: update_body,
        channel: release_channel(release),
        release_tag: Some(release.tag_name.clone()),
        release_name: release.name.clone(),
        release_url: release.html_url.clone(),
        repository,
        message: None,
    }
}

async fn select_release_manifest(
    repository: &str,
    include_prerelease: bool,
) -> Result<SelectedRelease, String> {
    let url = format!("https://api.github.com/repos/{repository}/releases?per_page=30");
    let releases = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("failed to create GitHub client: {error}"))?
        .get(url)
        .header(USER_AGENT, "LiveAgent-Updater")
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("failed to query GitHub releases: {error}"))?;

    if !releases.status().is_success() {
        return Err(format!(
            "GitHub release lookup failed with status {}",
            releases.status()
        ));
    }

    let releases = releases
        .json::<Vec<GitHubRelease>>()
        .await
        .map_err(|error| format!("failed to parse GitHub releases: {error}"))?;

    for release in releases {
        if release.draft {
            continue;
        }
        if release.prerelease && !include_prerelease {
            continue;
        }

        if let Some(asset) = release
            .assets
            .iter()
            .find(|asset| asset.name == UPDATE_MANIFEST_ASSET)
        {
            return Ok(SelectedRelease {
                tag_name: release.tag_name,
                name: release.name,
                prerelease: release.prerelease,
                html_url: release.html_url,
                published_at: release.published_at,
                manifest_url: asset.browser_download_url.clone(),
            });
        }
    }

    if include_prerelease {
        Err("No stable or pre-release updater manifest was found.".to_string())
    } else {
        Err("No stable updater manifest was found.".to_string())
    }
}

fn build_updater(
    app: &AppHandle,
    public_key: &str,
    manifest_url: &str,
) -> Result<tauri_plugin_updater::Updater, String> {
    let manifest_url = Url::parse(manifest_url)
        .map_err(|error| format!("invalid updater manifest URL: {error}"))?;

    app.updater_builder()
        .pubkey(public_key.to_string())
        .endpoints(vec![manifest_url])
        .map_err(|error| format!("invalid updater endpoint: {error}"))?
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("failed to initialize updater: {error}"))
}

#[tauri::command]
pub async fn app_update_check(
    app: AppHandle,
    include_prerelease: bool,
) -> Result<AppUpdateCheckResponse, String> {
    let repository = update_repository();
    let Some(public_key) = updater_public_key() else {
        return Ok(unconfigured_response(&app, include_prerelease, repository));
    };

    let release = select_release_manifest(&repository, include_prerelease).await?;
    let updater = build_updater(&app, &public_key, &release.manifest_url)?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("failed to check for updates: {error}"))?;

    Ok(match update {
        Some(update) => response_for_release(
            &app,
            repository,
            &release,
            true,
            Some(update.version),
            update.date.map(|date| date.to_string()),
            update.body,
        ),
        None => response_for_release(&app, repository, &release, false, None, None, None),
    })
}

#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    include_prerelease: bool,
) -> Result<AppUpdateCheckResponse, String> {
    let repository = update_repository();
    let Some(public_key) = updater_public_key() else {
        return Ok(unconfigured_response(&app, include_prerelease, repository));
    };

    let release = select_release_manifest(&repository, include_prerelease).await?;
    let updater = build_updater(&app, &public_key, &release.manifest_url)?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("failed to check for updates: {error}"))?;

    let Some(update) = update else {
        return Ok(response_for_release(
            &app, repository, &release, false, None, None, None,
        ));
    };

    let version = update.version.clone();
    let date = update.date.map(|date| date.to_string());
    let body = update.body.clone();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("failed to install update: {error}"))?;

    Ok(response_for_release(
        &app,
        repository,
        &release,
        false,
        Some(version),
        date,
        body,
    ))
}
