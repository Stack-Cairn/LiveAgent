//! Native, user-authorized Image Studio export. The webview supplies an asset
//! identifier, never an HTTP source or filesystem destination.
use std::fs::{self, Metadata};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use image::ImageFormat;
use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderMap, CONTENT_LENGTH, CONTENT_TYPE, ETAG};
use rfd::{FileDialog, MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tempfile::NamedTempFile;

use crate::services::kbrain_backend::{KBrainBackendConnection, KBrainBackendState};

const MAX_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PIXELS: u64 = 100_000_000;

type ExportResult<T> = Result<T, ImageExportError>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageExportRequest {
    pub asset_id: String,
    /// A scope guard only: this value is never used as an HTTP destination.
    pub backend_base_url: String,
    pub destination: String,
    pub file_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageExportError {
    pub code: &'static str,
    pub message: &'static str,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

fn error(code: &'static str, message: &'static str) -> ImageExportError {
    ImageExportError {
        code,
        message,
        retryable: false,
        status: None,
    }
}

#[derive(Debug, Serialize)]
pub struct ImageExportOutcome {
    pub saved: bool,
}

fn validate_asset_id(id: &str) -> ExportResult<()> {
    if id.is_empty()
        || id.len() > 256
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(error("INVALID_ARGUMENT", "Invalid image asset identifier"));
    }
    Ok(())
}

fn validate_file_name(name: &str) -> ExportResult<()> {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
        });
    if name.is_empty()
        || name.len() > 240
        || name.trim() != name
        || name.ends_with('.')
        || reserved
        || name
            .chars()
            .any(|c| c.is_control() || "/\\:<>\"|?*".contains(c))
    {
        return Err(error("INVALID_ARGUMENT", "Invalid image export filename"));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
struct AssetHeaders {
    mime: String,
    bytes: u64,
    etag: Option<String>,
}

impl AssetHeaders {
    fn parse(headers: &HeaderMap) -> ExportResult<Self> {
        let mime = headers
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .map(str::trim)
            .unwrap_or("");
        if !matches!(mime, "image/png" | "image/jpeg" | "image/webp") {
            return Err(error("INVALID_ASSET", "Unsupported image content type"));
        }
        let bytes = headers
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v > 0 && *v <= MAX_BYTES)
            .ok_or_else(|| error("INVALID_ASSET", "Missing or invalid original image size"))?;
        Ok(Self {
            mime: mime.to_owned(),
            bytes,
            etag: headers
                .get(ETAG)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned),
        })
    }

    fn format(&self) -> (ImageFormat, &'static str) {
        match self.mime.as_str() {
            "image/jpeg" => (ImageFormat::Jpeg, "jpg"),
            "image/webp" => (ImageFormat::WebP, "webp"),
            _ => (ImageFormat::Png, "png"),
        }
    }
}

fn http_client() -> ExportResult<Client> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| {
            error(
                "NETWORK_ERROR",
                "Unable to initialize image export transport",
            )
        })
}

fn asset_url(
    connection: &KBrainBackendConnection,
    request: &ImageExportRequest,
) -> ExportResult<String> {
    validate_asset_id(&request.asset_id)?;
    if request.backend_base_url != connection.base_url {
        return Err(error(
            "UNSUPPORTED",
            "Native export supports only the selected managed local KBrain backend",
        ));
    }
    // The connection is obtained from KBrainBackendState, not from the webview.
    Ok(format!(
        "{}/v1/image/assets/{}/content?variant=original",
        connection.base_url.trim_end_matches('/'),
        request.asset_id
    ))
}

fn check_response(response: Response) -> ExportResult<Response> {
    if response.status().as_u16() == 200 {
        return Ok(response);
    }
    let status = response.status().as_u16();
    Err(ImageExportError {
        code: match status {
            401 => "UNAUTHORIZED",
            403 => "FORBIDDEN",
            404 => "NOT_FOUND",
            _ => "BACKEND_ERROR",
        },
        message: "KBrain could not provide the original image",
        retryable: status >= 500,
        status: Some(status),
    })
}

fn inspect_asset(
    client: &Client,
    connection: &KBrainBackendConnection,
    url: &str,
) -> ExportResult<AssetHeaders> {
    // Do not return reqwest errors or upstream bodies: these can contain URLs,
    // credentials or provider diagnostics. Authentication never enters logs.
    let response = client
        .head(url)
        .bearer_auth(&connection.token)
        .send()
        .map_err(|_| error("NETWORK_ERROR", "Unable to inspect original image"))?;
    AssetHeaders::parse(check_response(response)?.headers())
}

#[derive(Debug, PartialEq)]
struct FileStamp {
    bytes: u64,
    modified: SystemTime,
}

fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn target_stamp(path: &Path) -> ExportResult<Option<FileStamp>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !is_link(&meta) && meta.is_file() => Ok(Some(FileStamp {
            bytes: meta.len(),
            modified: meta
                .modified()
                .map_err(|_| error("IO_ERROR", "Unable to inspect export target"))?,
        })),
        Ok(_) => Err(error(
            "INVALID_TARGET",
            "Export target must be a regular file, not a link or directory",
        )),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(error("IO_ERROR", "Unable to inspect export target")),
    }
}

struct AuthorizedTarget {
    path: PathBuf,
    parent: PathBuf,
    overwrite: Option<FileStamp>,
}

fn resolve_target(selected: PathBuf) -> ExportResult<AuthorizedTarget> {
    if !selected.is_absolute() {
        return Err(error("INVALID_TARGET", "Export target must be absolute"));
    }
    let name = selected
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| error("INVALID_TARGET", "Invalid export target filename"))?;
    validate_file_name(name)?;
    let parent = selected
        .parent()
        .and_then(|p| fs::canonicalize(p).ok())
        .filter(|p| p.is_dir())
        .ok_or_else(|| error("INVALID_TARGET", "Export directory is unavailable"))?;
    let path = parent.join(name);
    let overwrite = target_stamp(&path)?;
    Ok(AuthorizedTarget {
        path,
        parent,
        overwrite,
    })
}

fn choose_target(file_name: &str, extension: &str) -> ExportResult<Option<AuthorizedTarget>> {
    loop {
        let Some(selected) = FileDialog::new()
            .set_title("Export original image")
            .set_file_name(file_name)
            .add_filter("Image", &[extension])
            .save_file()
        else {
            return Ok(None);
        };
        let target = resolve_target(selected)?;
        if target.overwrite.is_none() {
            return Ok(Some(target));
        }
        // Native save dialogs often also ask this. Keep authorization explicit
        // on every platform and allow choosing another name instead.
        let choice = MessageDialog::new().set_title("Image export: file exists")
            .set_description("Replace the selected file? Choose No to select another filename, or Cancel to stop exporting.")
            .set_level(MessageLevel::Warning).set_buttons(MessageButtons::YesNoCancel).show();
        match choice {
            MessageDialogResult::Yes => return Ok(Some(target)),
            MessageDialogResult::No => continue,
            _ => return Ok(None),
        }
    }
}

fn validate_image(temp: &mut NamedTempFile, metadata: &AssetHeaders) -> ExportResult<()> {
    temp.seek(SeekFrom::Start(0))
        .map_err(|_| error("IO_ERROR", "Unable to validate image export"))?;
    let mut reader = image::ImageReader::new(BufReader::new(temp.as_file_mut()))
        .with_guessed_format()
        .map_err(|_| error("INVALID_ASSET", "Unable to identify original image"))?;
    if reader.format() != Some(metadata.format().0) {
        return Err(error(
            "INVALID_ASSET",
            "Original image does not match its content type",
        ));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(100_000);
    limits.max_image_height = Some(100_000);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let decoder = reader
        .into_decoder()
        .map_err(|_| error("INVALID_ASSET", "Invalid original image"))?;
    use image::ImageDecoder;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(error(
            "INVALID_ASSET",
            "Original image exceeds pixel limits",
        ));
    }
    image::DynamicImage::from_decoder(decoder)
        .map_err(|_| error("INVALID_ASSET", "Invalid original image data"))?;
    Ok(())
}

fn write_original(
    mut source: impl Read,
    metadata: &AssetHeaders,
    target: &AuthorizedTarget,
) -> ExportResult<()> {
    let mut temp = tempfile::Builder::new()
        .prefix(".image-export-")
        .tempfile_in(&target.parent)
        .map_err(|_| error("IO_ERROR", "Unable to create temporary image export"))?;
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = source
            .read(&mut buffer)
            .map_err(|_| error("IO_ERROR", "Original image transfer was interrupted"))?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > metadata.bytes {
            return Err(error(
                "INVALID_ASSET",
                "Original image exceeds its declared size",
            ));
        }
        temp.write_all(&buffer[..count])
            .map_err(|_| error("IO_ERROR", "Unable to write image export"))?;
    }
    if total != metadata.bytes {
        return Err(error(
            "INVALID_ASSET",
            "Original image transfer is incomplete",
        ));
    }
    validate_image(&mut temp, metadata)?;
    temp.as_file()
        .sync_all()
        .map_err(|_| error("IO_ERROR", "Unable to flush image export"))?;
    if fs::canonicalize(&target.parent).ok().as_ref() != Some(&target.parent) {
        return Err(error(
            "INVALID_TARGET",
            "Export directory changed during transfer",
        ));
    }
    let current = target_stamp(&target.path)?;
    if current != target.overwrite {
        return Err(error(
            "CONFLICT",
            "Export target changed; select the target and confirm again",
        ));
    }
    // Same-directory temp -> atomic publication. A new file must use
    // persist_noclobber, including if a competing writer creates it now.
    let result = if target.overwrite.is_some() {
        temp.persist(&target.path)
    } else {
        temp.persist_noclobber(&target.path)
    };
    result.map_err(|failure| {
        // PersistError owns the temporary file; dropping it removes that file.
        if failure.error.kind() == io::ErrorKind::AlreadyExists {
            error(
                "CONFLICT",
                "Export target exists; select another name or confirm replacement",
            )
        } else {
            error("IO_ERROR", "Unable to publish image export")
        }
    })?;
    Ok(())
}

fn download_original(
    client: &Client,
    connection: &KBrainBackendConnection,
    url: &str,
    metadata: &AssetHeaders,
    target: &AuthorizedTarget,
) -> ExportResult<()> {
    let response = client
        .get(url)
        .bearer_auth(&connection.token)
        .send()
        .map_err(|_| error("NETWORK_ERROR", "Unable to read original image"))?;
    let response = check_response(response)?;
    if AssetHeaders::parse(response.headers())? != *metadata {
        return Err(error(
            "INVALID_ASSET",
            "Original image metadata changed during export",
        ));
    }
    write_original(response, metadata, target)
}

/// Destination authorization and publication occur in one Rust invocation.
/// No reusable path grant, raw bytes, token or arbitrary source URL crosses IPC.
#[tauri::command]
pub async fn image_export_asset(
    app: AppHandle,
    state: State<'_, Arc<KBrainBackendState>>,
    request: ImageExportRequest,
) -> ExportResult<ImageExportOutcome> {
    if !matches!(request.destination.as_str(), "download" | "local_workspace") {
        return Err(error(
            "UNSUPPORTED",
            "This image export destination is unavailable",
        ));
    }
    validate_asset_id(&request.asset_id)?;
    if let Some(name) = &request.file_name {
        validate_file_name(name)?;
    }
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let connection = state
            .ensure_started(&app)
            .map_err(|_| error("BACKEND_ERROR", "Managed KBrain backend is unavailable"))?;
        let url = asset_url(&connection, &request)?;
        let client = http_client()?;
        let metadata = inspect_asset(&client, &connection, &url)?;
        let extension = metadata.format().1;
        let file_name = request
            .file_name
            .unwrap_or_else(|| format!("image-{}.{}", request.asset_id, extension));
        validate_file_name(&file_name)?;
        let Some(target) = choose_target(&file_name, extension)? else {
            return Ok(ImageExportOutcome { saved: false });
        };
        download_original(&client, &connection, &url, &metadata, &target)?;
        Ok(ImageExportOutcome { saved: true })
    })
    .await
    .map_err(|_| error("IO_ERROR", "Image export task failed"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn fixture() -> (Vec<u8>, AssetHeaders) {
        let mut data = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 3)
            .write_to(&mut data, ImageFormat::Png)
            .unwrap();
        let bytes = data.into_inner();
        let headers = AssetHeaders {
            mime: "image/png".into(),
            bytes: bytes.len() as u64,
            etag: Some("\"asset-hash\"".into()),
        };
        (bytes, headers)
    }

    #[test]
    fn rejects_path_control_and_device_names() {
        for name in [
            "", ".", "..", "../a.png", "a/b.png", "a\\b.png", "C:a.png", "a\n.png", "a\0.png",
            "CON.png", "LPT1.png", "a.png.", "a.png ",
        ] {
            assert!(validate_file_name(name).is_err(), "{name:?}");
        }
        assert!(validate_file_name("作品-1.png").is_ok());
        for id in [
            "",
            "../secret",
            "a?variant=thumbnail",
            "https://bad",
            "a%2fb",
            "a\nb",
        ] {
            assert!(validate_asset_id(id).is_err());
        }
    }

    #[test]
    fn source_is_pinned_to_managed_backend_and_original() {
        let connection = KBrainBackendConnection {
            base_url: "http://127.0.0.1:1234".into(),
            token: "test".into(),
            protocol_version: "test".into(),
                storage_id: "test-storage".into(),
        };
        let mut request = ImageExportRequest {
            asset_id: "asset_123".into(),
            backend_base_url: connection.base_url.clone(),
            destination: "local_workspace".into(),
            file_name: None,
        };
        assert_eq!(
            asset_url(&connection, &request).unwrap(),
            "http://127.0.0.1:1234/v1/image/assets/asset_123/content?variant=original"
        );
        request.backend_base_url = "http://untrusted.invalid".into();
        assert_eq!(
            asset_url(&connection, &request).unwrap_err().code,
            "UNSUPPORTED"
        );
    }

    #[test]
    fn validates_headers_and_limits() {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, "image/png".parse().unwrap());
        for size in ["0", "invalid", "104857601"] {
            headers.insert(CONTENT_LENGTH, size.parse().unwrap());
            assert!(AssetHeaders::parse(&headers).is_err());
        }
        headers.insert(CONTENT_LENGTH, "100".parse().unwrap());
        assert!(AssetHeaders::parse(&headers).is_ok());
        headers.insert(CONTENT_TYPE, "text/html".parse().unwrap());
        assert!(AssetHeaders::parse(&headers).is_err());
    }

    #[test]
    fn publishes_complete_original_without_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let target = resolve_target(dir.path().join("image.png")).unwrap();
        let (bytes, headers) = fixture();
        write_original(Cursor::new(&bytes), &headers, &target).unwrap();
        assert_eq!(fs::read(&target.path).unwrap(), bytes);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    struct BrokenReader {
        read: bool,
    }
    impl Read for BrokenReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.read {
                return Err(io::Error::other("mock disconnected"));
            }
            self.read = true;
            buffer[..3].copy_from_slice(b"png");
            Ok(3)
        }
    }

    #[test]
    fn transfer_failures_leave_no_partial_file_and_preserve_existing() {
        let dir = tempfile::tempdir().unwrap();
        let selected = dir.path().join("image.png");
        let (bytes, headers) = fixture();
        let target = resolve_target(selected.clone()).unwrap();
        assert!(write_original(BrokenReader { read: false }, &headers, &target).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        fs::write(&selected, b"original user file").unwrap();
        let target = resolve_target(selected).unwrap();
        assert!(write_original(Cursor::new(&bytes[..bytes.len() - 1]), &headers, &target).is_err());
        let mut corrupt = bytes.clone();
        corrupt[0] = 0;
        assert!(write_original(Cursor::new(corrupt), &headers, &target).is_err());
        assert!(write_original(
            Cursor::new([bytes.as_slice(), b"extra"].concat()),
            &headers,
            &target
        )
        .is_err());
        assert_eq!(fs::read(&target.path).unwrap(), b"original user file");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn conflicts_do_not_silently_overwrite_and_authorized_replace_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let target = resolve_target(dir.path().join("image.png")).unwrap();
        let (bytes, headers) = fixture();
        fs::write(&target.path, b"competing file").unwrap();
        assert_eq!(
            write_original(Cursor::new(&bytes), &headers, &target)
                .unwrap_err()
                .code,
            "CONFLICT"
        );
        assert_eq!(fs::read(&target.path).unwrap(), b"competing file");
        let authorized = resolve_target(target.path.clone()).unwrap();
        write_original(Cursor::new(&bytes), &headers, &authorized).unwrap();
        assert_eq!(fs::read(&target.path).unwrap(), bytes);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn rejects_directories_and_mime_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_target(dir.path().to_path_buf()).is_err());
        let target = resolve_target(dir.path().join("image.jpg")).unwrap();
        let (bytes, mut headers) = fixture();
        headers.mime = "image/jpeg".into();
        assert_eq!(
            write_original(Cursor::new(bytes), &headers, &target)
                .unwrap_err()
                .code,
            "INVALID_ASSET"
        );
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn authenticated_http_reads_original_and_rejects_redirects() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let (bytes, metadata) = fixture();
        let served = bytes.clone();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for method in ["HEAD", "GET", "HEAD"] {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
                assert!(request.starts_with(&format!(
                    "{} /v1/image/assets/asset_1/content?variant=original ",
                    method.to_ascii_lowercase()
                )));
                assert!(request.contains("authorization: bearer mock-export-token\r\n"));
                if method == "HEAD" && request.contains("x-test-redirect: yes") {
                    socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                } else {
                    write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nETag: \"asset-hash\"\r\nConnection: close\r\n\r\n", served.len()).unwrap();
                    if method == "GET" {
                        socket.write_all(&served).unwrap();
                    }
                }
            }
        });
        let connection = KBrainBackendConnection {
            base_url: base_url.clone(),
            token: "mock-export-token".into(),
            protocol_version: "test".into(),
                storage_id: "test-storage".into(),
        };
        let url = format!("{base_url}/v1/image/assets/asset_1/content?variant=original");
        let client = http_client().unwrap();
        assert_eq!(inspect_asset(&client, &connection, &url).unwrap(), metadata);
        let dir = tempfile::tempdir().unwrap();
        let target = resolve_target(dir.path().join("original.png")).unwrap();
        download_original(&client, &connection, &url, &metadata, &target).unwrap();
        assert_eq!(fs::read(target.path).unwrap(), bytes);
        let response = client
            .head(url)
            .bearer_auth(&connection.token)
            .header("x-test-redirect", "yes")
            .send()
            .unwrap();
        assert_eq!(check_response(response).unwrap_err().status, Some(302));
        server.join().unwrap();
    }
}
