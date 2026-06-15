use std::time::Duration;

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use reqwest::header::{ACCEPT, RANGE, USER_AGENT};
use reqwest::StatusCode;
use serde::Serialize;
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

#[derive(Debug, Clone)]
struct SelectedRelease {
    tag_name: String,
    name: Option<String>,
    prerelease: bool,
    html_url: Option<String>,
    published_at: Option<String>,
    manifest_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReleaseFeedEntry {
    tag_name: String,
    title: Option<String>,
    html_url: Option<String>,
    updated: Option<String>,
}

#[derive(Default)]
struct ReleaseFeedEntryBuilder {
    title: Option<String>,
    html_url: Option<String>,
    updated: Option<String>,
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

fn updater_public_key_override() -> Option<String> {
    std::env::var("LIVEAGENT_UPDATER_PUBLIC_KEY")
        .ok()
        .or_else(|| option_env!("LIVEAGENT_UPDATER_PUBLIC_KEY").map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
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

fn github_url_with_segments<'a>(
    segments: impl IntoIterator<Item = &'a str>,
) -> Result<String, String> {
    let mut url = Url::parse("https://github.com/")
        .map_err(|error| format!("invalid GitHub URL: {error}"))?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| "invalid GitHub URL path".to_string())?;
        path.clear();
        for segment in segments {
            path.push(segment);
        }
    }
    Ok(url.to_string())
}

fn repository_segments(repository: &str) -> Vec<&str> {
    repository
        .split('/')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn release_feed_url(repository: &str) -> Result<String, String> {
    let mut segments = repository_segments(repository);
    segments.push("releases.atom");
    github_url_with_segments(segments)
}

fn release_tag_url(repository: &str, tag_name: &str) -> Result<String, String> {
    let mut segments = repository_segments(repository);
    segments.extend(["releases", "tag", tag_name]);
    github_url_with_segments(segments)
}

fn release_manifest_url(repository: &str, tag_name: &str) -> Result<String, String> {
    let mut segments = repository_segments(repository);
    segments.extend(["releases", "download", tag_name, UPDATE_MANIFEST_ASSET]);
    github_url_with_segments(segments)
}

fn tag_name_from_release_url(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    let segments = url.path_segments()?.collect::<Vec<_>>();
    let tag_index = segments
        .windows(2)
        .position(|window| window == ["releases", "tag"])?;
    segments
        .get(tag_index + 2)
        .map(|segment| segment.to_string())
}

fn is_semver_prerelease_tag(tag_name: &str) -> bool {
    let version = tag_name
        .trim()
        .trim_start_matches('v')
        .trim_start_matches('V');
    version.contains('-')
}

fn release_link_from_attributes(element: &BytesStart<'_>) -> Result<Option<String>, String> {
    let mut href: Option<String> = None;
    let mut rel: Option<String> = None;

    for attr in element.attributes().with_checks(false) {
        let attr =
            attr.map_err(|error| format!("failed to parse release feed link attribute: {error}"))?;
        let value = attr
            .decode_and_unescape_value(element.decoder())
            .map_err(|error| format!("failed to decode release feed link attribute: {error}"))?
            .into_owned();
        match attr.key.as_ref() {
            b"href" => href = Some(value),
            b"rel" => rel = Some(value),
            _ => {}
        }
    }

    if rel.as_deref().unwrap_or("alternate") == "alternate" {
        Ok(href)
    } else {
        Ok(None)
    }
}

fn parse_release_feed(feed: &str) -> Result<Vec<ReleaseFeedEntry>, String> {
    let mut reader = Reader::from_str(feed);
    reader.config_mut().trim_text(true);

    let mut entries = Vec::new();
    let mut current: Option<ReleaseFeedEntryBuilder> = None;
    let mut current_text_field: Option<&'static str> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => match element.local_name().as_ref() {
                b"entry" => current = Some(ReleaseFeedEntryBuilder::default()),
                b"title" if current.is_some() => current_text_field = Some("title"),
                b"updated" if current.is_some() => current_text_field = Some("updated"),
                b"link" if current.is_some() => {
                    if let Some(link) = release_link_from_attributes(&element)? {
                        if let Some(entry) = current.as_mut() {
                            entry.html_url = Some(link);
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::Empty(element)) => {
                if element.local_name().as_ref() == b"link" && current.is_some() {
                    if let Some(link) = release_link_from_attributes(&element)? {
                        if let Some(entry) = current.as_mut() {
                            entry.html_url = Some(link);
                        }
                    }
                }
            }
            Ok(Event::Text(text)) => {
                if let (Some(entry), Some(field)) = (current.as_mut(), current_text_field) {
                    let value = text
                        .decode()
                        .map_err(|error| format!("failed to decode release feed text: {error}"))?
                        .trim()
                        .to_string();
                    if !value.is_empty() {
                        match field {
                            "title" => entry.title = Some(value),
                            "updated" => entry.updated = Some(value),
                            _ => {}
                        }
                    }
                }
            }
            Ok(Event::End(element)) => match element.local_name().as_ref() {
                b"title" | b"updated" => current_text_field = None,
                b"entry" => {
                    if let Some(entry) = current.take() {
                        if let Some(html_url) = entry.html_url {
                            if let Some(tag_name) = tag_name_from_release_url(&html_url) {
                                entries.push(ReleaseFeedEntry {
                                    tag_name,
                                    title: entry.title,
                                    html_url: Some(html_url),
                                    updated: entry.updated,
                                });
                            }
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("failed to parse GitHub release feed: {error}")),
            _ => {}
        }
    }

    Ok(entries)
}

fn selected_release_candidates_from_entries(
    repository: &str,
    entries: Vec<ReleaseFeedEntry>,
    include_prerelease: bool,
) -> Result<Vec<SelectedRelease>, String> {
    entries
        .into_iter()
        .filter(|entry| include_prerelease || !is_semver_prerelease_tag(&entry.tag_name))
        .map(|entry| {
            let prerelease = is_semver_prerelease_tag(&entry.tag_name);
            Ok(SelectedRelease {
                manifest_url: release_manifest_url(repository, &entry.tag_name)?,
                html_url: Some(match entry.html_url {
                    Some(html_url) => html_url,
                    None => release_tag_url(repository, &entry.tag_name)?,
                }),
                tag_name: entry.tag_name,
                name: entry.title,
                prerelease,
                published_at: entry.updated,
            })
        })
        .collect()
}

fn github_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("failed to create GitHub client: {error}"))
}

async fn manifest_exists(client: &reqwest::Client, manifest_url: &str) -> Result<bool, String> {
    let response = client
        .head(manifest_url)
        .header(USER_AGENT, "LiveAgent-Updater")
        .send()
        .await
        .map_err(|error| format!("failed to probe updater manifest: {error}"))?;
    let status = response.status();
    if status.is_success() {
        return Ok(true);
    }

    if status == StatusCode::METHOD_NOT_ALLOWED {
        let response = client
            .get(manifest_url)
            .header(USER_AGENT, "LiveAgent-Updater")
            .header(RANGE, "bytes=0-0")
            .send()
            .await
            .map_err(|error| format!("failed to probe updater manifest: {error}"))?;
        let status = response.status();
        return Ok(status.is_success() || status == StatusCode::PARTIAL_CONTENT);
    }

    if status.is_client_error() {
        return Ok(false);
    }

    Err(format!(
        "updater manifest probe failed with status {status}"
    ))
}

fn no_update_response(
    app: &AppHandle,
    repository: String,
    channel: AppUpdateChannel,
) -> AppUpdateCheckResponse {
    AppUpdateCheckResponse {
        configured: true,
        available: false,
        current_version: current_version(app),
        version: None,
        date: None,
        body: None,
        channel,
        release_tag: None,
        release_name: None,
        release_url: None,
        repository,
        message: None,
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
) -> Result<Option<SelectedRelease>, String> {
    let client = github_client()?;
    let feed_url = release_feed_url(repository)?;
    let response = client
        .get(feed_url)
        .header(USER_AGENT, "LiveAgent-Updater")
        .header(
            ACCEPT,
            "application/atom+xml, application/xml;q=0.9, */*;q=0.8",
        )
        .send()
        .await
        .map_err(|error| format!("failed to query GitHub release feed: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!(
            "GitHub release feed lookup failed with status {status}"
        ));
    }

    let feed = response
        .text()
        .await
        .map_err(|error| format!("failed to read GitHub release feed: {error}"))?;
    let candidates = selected_release_candidates_from_entries(
        repository,
        parse_release_feed(&feed)?,
        include_prerelease,
    )?;

    for release in candidates {
        if manifest_exists(&client, &release.manifest_url).await? {
            return Ok(Some(release));
        }
    }

    Ok(None)
}

fn build_updater(
    app: &AppHandle,
    manifest_url: &str,
) -> Result<tauri_plugin_updater::Updater, String> {
    let manifest_url = Url::parse(manifest_url)
        .map_err(|error| format!("invalid updater manifest URL: {error}"))?;

    let mut builder = app.updater_builder();
    if let Some(public_key) = updater_public_key_override() {
        builder = builder.pubkey(public_key);
    }

    builder
        .endpoints(vec![manifest_url])
        .map_err(|error| format!("invalid updater endpoint: {error}"))?
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("failed to initialize updater: {error}"))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn app_update_check(
    app: AppHandle,
    include_prerelease: bool,
) -> Result<AppUpdateCheckResponse, String> {
    let repository = update_repository();

    let Some(release) = select_release_manifest(&repository, include_prerelease).await? else {
        return Ok(no_update_response(
            &app,
            repository,
            if include_prerelease {
                AppUpdateChannel::Prerelease
            } else {
                AppUpdateChannel::Stable
            },
        ));
    };
    let updater = build_updater(&app, &release.manifest_url)?;
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

#[tauri::command(rename_all = "snake_case")]
pub async fn app_update_install(
    app: AppHandle,
    include_prerelease: bool,
) -> Result<AppUpdateCheckResponse, String> {
    let repository = update_repository();

    let Some(release) = select_release_manifest(&repository, include_prerelease).await? else {
        return Ok(no_update_response(
            &app,
            repository,
            if include_prerelease {
                AppUpdateChannel::Prerelease
            } else {
                AppUpdateChannel::Stable
            },
        ));
    };
    let updater = build_updater(&app, &release.manifest_url)?;
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

#[tauri::command]
pub fn app_restart(app: AppHandle) -> Result<(), String> {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_entry(tag_name: &str) -> ReleaseFeedEntry {
        ReleaseFeedEntry {
            tag_name: tag_name.to_string(),
            title: Some(format!("LiveAgent {tag_name}")),
            html_url: Some(format!(
                "https://github.com/Stack-Cairn/LiveAgent/releases/tag/{tag_name}"
            )),
            updated: Some("2026-05-25T12:27:41Z".to_string()),
        }
    }

    #[test]
    fn parses_release_feed_entries() {
        let entries = parse_release_feed(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <updated>2026-05-25T16:00:34Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/Stack-Cairn/LiveAgent/releases/tag/v0.1.2"/>
    <title>LiveAgent v0.1.2</title>
  </entry>
</feed>"#,
        )
        .expect("feed should parse");

        assert_eq!(
            entries,
            vec![ReleaseFeedEntry {
                tag_name: "v0.1.2".to_string(),
                title: Some("LiveAgent v0.1.2".to_string()),
                html_url: Some(
                    "https://github.com/Stack-Cairn/LiveAgent/releases/tag/v0.1.2".to_string()
                ),
                updated: Some("2026-05-25T16:00:34Z".to_string()),
            }]
        );
    }

    #[test]
    fn stable_channel_ignores_semver_prerelease_candidates() {
        let selected = selected_release_candidates_from_entries(
            DEFAULT_UPDATE_REPOSITORY,
            vec![feed_entry("v0.1.2-beta.1")],
            false,
        )
        .expect("candidates should be built");

        assert!(selected.is_empty());
    }

    #[test]
    fn prerelease_channel_can_select_prerelease_manifest() {
        let selected = selected_release_candidates_from_entries(
            DEFAULT_UPDATE_REPOSITORY,
            vec![feed_entry("v0.1.2-beta.1")],
            true,
        )
        .expect("candidates should be built");

        assert_eq!(selected[0].tag_name, "v0.1.2-beta.1");
        assert_eq!(
            selected[0].manifest_url,
            "https://github.com/Stack-Cairn/LiveAgent/releases/download/v0.1.2-beta.1/latest.json"
        );
        assert!(selected[0].prerelease);
    }

    #[test]
    fn stable_channel_selects_next_stable_manifest_after_prerelease() {
        let selected = selected_release_candidates_from_entries(
            DEFAULT_UPDATE_REPOSITORY,
            vec![feed_entry("v0.1.2-beta.1"), feed_entry("v0.1.1")],
            false,
        )
        .expect("candidates should be built");

        assert_eq!(selected[0].tag_name, "v0.1.1");
        assert!(!selected[0].prerelease);
    }
}
