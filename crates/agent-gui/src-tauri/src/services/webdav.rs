// WebDAV 传输层：纯 HTTP，不含任何同步编排与配置存取。
//
// 只用到 WebDAV 的四个动作：PROPFIND（探测）、MKCOL（建目录）、PUT、GET。
// 刻意不引入 WebDAV 客户端库也不解析 XML —— 各家服务器的 multistatus 响应体
// 差异极大，而本功能只需要「目录是否存在」这个布尔判断，看状态码就够了。

use std::time::Duration;

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::{Client, Method, Response, StatusCode};

use crate::services::system_proxy;

/// 元数据操作（PROPFIND / MKCOL）超时。
const WEBDAV_META_TIMEOUT: Duration = Duration::from_secs(30);
/// 传输操作（PUT / GET）超时。载荷小但用户网络可能很慢。
const WEBDAV_TRANSFER_TIMEOUT: Duration = Duration::from_secs(300);

/// 路径段需要转义的字符集。
///
/// 不能用 `NON_ALPHANUMERIC`：它会把 `-` `_` `.` `~` 也编码，虽然合法但会让
/// 远端文件名变得难认。这里只转义 RFC 3986 的分隔符与控制字符。
const PATH_SEGMENT_ESCAPE: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'/')
    .add(b'\\');

#[derive(Debug, Clone)]
pub struct WebdavCredentials {
    pub base_url: String,
    pub username: String,
    pub password: String,
}

fn method_propfind() -> Method {
    Method::from_bytes(b"PROPFIND").expect("PROPFIND is a valid HTTP method token")
}

fn method_mkcol() -> Method {
    Method::from_bytes(b"MKCOL").expect("MKCOL is a valid HTTP method token")
}

/// 构造客户端。**必须**走应用代理设置，否则用户配了代理却对 WebDAV 无效。
fn build_client(timeout: Duration) -> Result<Client, String> {
    system_proxy::async_client_builder()?
        .timeout(timeout)
        .build()
        .map_err(|_| "创建 WebDAV HTTP 客户端失败".to_string())
}

/// 拼接远端 URL：base 去尾斜杠，各段 percent-encode 后以 `/` 连接。
///
/// 空段跳过，避免用户输入 `dav//backup/` 这类路径时产生双斜杠 —— 部分服务器
/// 会把 `//` 当成不同资源，导致「上传成功但下载 404」。
pub fn join_url(base: &str, segments: &[&str]) -> String {
    let mut url = base.trim_end_matches('/').to_string();
    for segment in segments {
        for part in segment.split('/') {
            if part.is_empty() {
                continue;
            }
            url.push('/');
            url.push_str(&utf8_percent_encode(part, PATH_SEGMENT_ESCAPE).to_string());
        }
    }
    url
}

/// 目录 URL 需带尾斜杠：多数服务器据此区分 collection 与普通资源。
pub fn dir_url(base: &str, segments: &[&str]) -> String {
    format!("{}/", join_url(base, segments))
}

/// 日志脱敏：剥离 userinfo 与整个 query string。
///
/// userinfo 里可能嵌着密码（`https://user:pass@host/`），query 里可能带
/// 一次性令牌，两者都不该进日志或错误文案。
pub fn redact_url_for_log(url: &str) -> String {
    let (scheme, rest) = match url.split_once("://") {
        Some((scheme, rest)) => (Some(scheme), rest),
        None => (None, url),
    };
    // userinfo 只在第一个 '/' 之前的 authority 部分有效。
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let (authority, path) = rest.split_at(authority_end);
    let host = match authority.rsplit_once('@') {
        Some((_userinfo, host)) => host,
        None => authority,
    };
    let path = path.split('?').next().unwrap_or("");
    match scheme {
        Some(scheme) => format!("{scheme}://{host}{path}"),
        None => format!("{host}{path}"),
    }
}

/// 坚果云需要特判：它的错误码语义与通用 WebDAV 服务器不同，直接透传
/// 状态码用户完全无法自救（尤其 401 —— 真正原因是要用应用密码而非登录密码）。
///
/// 国际版用的是 `dav.jianguoyun.com` 之外的 `nutstore` 域名，同一套后端、
/// 同一套错误语义，必须一并识别，否则国际版用户只会看到通用文案。
fn is_jianguoyun(url: &str) -> bool {
    let host = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    // 只按域名边界匹配：`jianguoyun.com.evil.test` 不能命中。
    ["jianguoyun.com", "nutstore.net", "nutstore.com"]
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

/// 把状态码翻成用户能照着操作的中文文案。
fn describe_status_error(url: &str, status: StatusCode, action: &str) -> String {
    let jianguoyun = is_jianguoyun(url);
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            if jianguoyun {
                "认证失败：坚果云要求使用「第三方应用管理」中生成的应用密码，而不是账号登录密码；同时确认服务器地址为 https://dav.jianguoyun.com/dav/".to_string()
            } else {
                format!("认证失败（{status}）：请检查用户名与密码")
            }
        }
        StatusCode::NOT_FOUND => {
            if jianguoyun {
                "路径不存在：坚果云的 WebDAV 可写目录必须位于 /dav/ 之下，请确认服务器地址与远端目录".to_string()
            } else {
                format!("路径不存在（{status}）：请检查服务器地址与远端目录")
            }
        }
        StatusCode::CONFLICT => {
            if jianguoyun {
                "创建目录失败：坚果云不允许通过 WebDAV 自动创建顶层文件夹，请先在网页端手动创建该目录".to_string()
            } else {
                format!("创建目录失败（{status}）：上级目录可能不存在")
            }
        }
        StatusCode::INSUFFICIENT_STORAGE => "远端存储空间不足".to_string(),
        status if status.is_redirection() => {
            if jianguoyun {
                format!("服务器返回重定向（{status}）：坚果云的 WebDAV 地址应为 https://dav.jianguoyun.com/dav/，请勿使用网页版地址")
            } else {
                format!("服务器返回重定向（{status}）：地址可能不是 WebDAV 入口")
            }
        }
        status => format!("{action}失败：服务器返回 {status}"),
    }
}

fn map_request_error(url: &str, action: &str, error: &reqwest::Error) -> String {
    let redacted = redact_url_for_log(url);
    if error.is_timeout() {
        return format!("{action}超时：{redacted}");
    }
    if error.is_connect() {
        return format!("{action}失败：无法连接到 {redacted}");
    }
    format!("{action}失败：{redacted}")
}

/// PROPFIND Depth=0 探测资源是否可访问。
///
/// 不解析响应体 —— 只要服务器认了这个方法并返回 2xx 或 207，就说明地址、
/// 凭据、可访问性都没问题。
async fn propfind_ok(creds: &WebdavCredentials, url: &str) -> Result<bool, String> {
    let client = build_client(WEBDAV_META_TIMEOUT)?;
    let response = client
        .request(method_propfind(), url)
        .basic_auth(&creds.username, Some(&creds.password))
        .header("Depth", "0")
        .send()
        .await
        .map_err(|e| map_request_error(url, "连接 WebDAV 服务器", &e))?;

    let status = response.status();
    if status.is_success() || status == StatusCode::MULTI_STATUS {
        return Ok(true);
    }
    if status == StatusCode::NOT_FOUND {
        return Ok(false);
    }
    Err(describe_status_error(url, status, "连接 WebDAV 服务器"))
}

/// 测试连接：探测 base_url 本身可达。
pub async fn test_connection(creds: &WebdavCredentials) -> Result<(), String> {
    let url = dir_url(&creds.base_url, &[]);
    if propfind_ok(creds, &url).await? {
        Ok(())
    } else {
        Err(describe_status_error(
            &url,
            StatusCode::NOT_FOUND,
            "连接 WebDAV 服务器",
        ))
    }
}

/// 逐级创建目录。
///
/// 乐观 MKCOL：不先查存在性（多一轮 RTT），直接建，遇到「已存在」类错误就
/// 用 PROPFIND 确认。405 = 方法不允许（多为已存在），409 = 上级缺失，
/// 3xx = 服务器把已存在的 collection 重定向了 —— 三者都可能是「其实已经有了」。
pub async fn ensure_remote_dirs(
    creds: &WebdavCredentials,
    segments: &[&str],
) -> Result<(), String> {
    let client = build_client(WEBDAV_META_TIMEOUT)?;
    let mut accumulated: Vec<&str> = Vec::with_capacity(segments.len());

    for segment in segments {
        accumulated.push(segment);
        let url = dir_url(&creds.base_url, &accumulated);
        let response = client
            .request(method_mkcol(), &url)
            .basic_auth(&creds.username, Some(&creds.password))
            .send()
            .await
            .map_err(|e| map_request_error(&url, "创建远端目录", &e))?;

        let status = response.status();
        if status.is_success() {
            continue;
        }
        let may_already_exist = status == StatusCode::METHOD_NOT_ALLOWED
            || status == StatusCode::CONFLICT
            || status.is_redirection();
        if may_already_exist && propfind_ok(creds, &url).await? {
            continue;
        }
        return Err(describe_status_error(&url, status, "创建远端目录"));
    }
    Ok(())
}

/// 流式读取响应体，边累加边检查上限。
///
/// 不能只信 `Content-Length`：它可以缺失，也可以撒谎。恶意或故障的服务器
/// 用一个无限响应体就能耗尽内存。
async fn read_body_capped(
    mut response: Response,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| format!("读取{label}失败：连接中断"))?
    {
        if buffer.len() + chunk.len() > max_bytes {
            return Err(format!("{label}超过大小上限（{max_bytes} 字节）"));
        }
        buffer.extend_from_slice(&chunk);
    }
    Ok(buffer)
}

pub async fn put_bytes(
    creds: &WebdavCredentials,
    segments: &[&str],
    body: Vec<u8>,
    content_type: &str,
) -> Result<(), String> {
    let url = join_url(&creds.base_url, segments);
    let client = build_client(WEBDAV_TRANSFER_TIMEOUT)?;
    let response = client
        .put(&url)
        .basic_auth(&creds.username, Some(&creds.password))
        .header("Content-Type", content_type)
        .body(body)
        .send()
        .await
        .map_err(|e| map_request_error(&url, "上传", &e))?;

    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(describe_status_error(&url, status, "上传"))
    }
}

/// 下载。资源不存在返回 `Ok(None)`，供调用方区分「远端还没有备份」与真正的错误。
pub async fn get_bytes(
    creds: &WebdavCredentials,
    segments: &[&str],
    max_bytes: usize,
    label: &str,
) -> Result<Option<Vec<u8>>, String> {
    let url = join_url(&creds.base_url, segments);
    let client = build_client(WEBDAV_TRANSFER_TIMEOUT)?;
    let response = client
        .get(&url)
        .basic_auth(&creds.username, Some(&creds.password))
        .send()
        .await
        .map_err(|e| map_request_error(&url, "下载", &e))?;

    let status = response.status();
    if status == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(describe_status_error(&url, status, "下载"));
    }
    Ok(Some(read_body_capped(response, max_bytes, label).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_url_trims_and_skips_empty_segments() {
        assert_eq!(
            join_url("https://example.com/dav/", &["liveagent", "v1"]),
            "https://example.com/dav/liveagent/v1"
        );
        // 用户输入的重复斜杠不应产生 `//`：部分服务器视其为不同资源。
        assert_eq!(
            join_url("https://example.com/dav", &["//liveagent//", "/v1/"]),
            "https://example.com/dav/liveagent/v1"
        );
        assert_eq!(join_url("https://example.com/dav/", &[]), "https://example.com/dav");
    }

    #[test]
    fn join_url_percent_encodes_spaces_and_non_ascii() {
        assert_eq!(
            join_url("https://example.com/dav", &["my backup"]),
            "https://example.com/dav/my%20backup"
        );
        assert_eq!(
            join_url("https://example.com/dav", &["配置"]),
            "https://example.com/dav/%E9%85%8D%E7%BD%AE"
        );
        // 常见文件名字符保持可读，不被过度编码。
        assert_eq!(
            join_url("https://example.com/dav", &["config-v1.2_final~x.json"]),
            "https://example.com/dav/config-v1.2_final~x.json"
        );
        // 段内的 '?' 必须编码，否则会被当成 query 起点。
        assert_eq!(
            join_url("https://example.com/dav", &["a?b"]),
            "https://example.com/dav/a%3Fb"
        );
    }

    #[test]
    fn dir_url_keeps_trailing_slash() {
        assert_eq!(
            dir_url("https://example.com/dav/", &["v1"]),
            "https://example.com/dav/v1/"
        );
        assert_eq!(dir_url("https://example.com/dav/", &[]), "https://example.com/dav/");
    }

    #[test]
    fn redact_url_strips_userinfo_and_query() {
        assert_eq!(
            redact_url_for_log("https://alice:s3cret@example.com/dav/x?token=abc"),
            "https://example.com/dav/x"
        );
        assert_eq!(
            redact_url_for_log("https://example.com/dav/x"),
            "https://example.com/dav/x"
        );
        // '@' 出现在路径里时不该被误当成 userinfo 分隔符。
        assert_eq!(
            redact_url_for_log("https://example.com/dav/a@b"),
            "https://example.com/dav/a@b"
        );
        assert_eq!(redact_url_for_log("example.com/dav?x=1"), "example.com/dav");
    }

    #[test]
    fn detects_jianguoyun_hosts() {
        assert!(is_jianguoyun("https://dav.jianguoyun.com/dav/"));
        assert!(is_jianguoyun("https://DAV.JianGuoYun.com/dav/"));
        // 国际版走 nutstore 域名，错误语义与国内版一致。
        assert!(is_jianguoyun("https://dav.jianguoyun.com.nutstore.net/dav/"));
        assert!(is_jianguoyun("https://app.nutstore.net/dav/"));
        assert!(!is_jianguoyun("https://example.com/dav/"));
        // 后缀相似但不同域的主机不应误判。
        assert!(!is_jianguoyun("https://jianguoyun.com.evil.test/dav/"));
        assert!(!is_jianguoyun("https://nutstore.net.evil.test/dav/"));
        // 仅子串包含也不能命中。
        assert!(!is_jianguoyun("https://mynutstore.example/dav/"));
    }

    #[test]
    fn jianguoyun_errors_mention_app_password_and_manual_folder() {
        let url = "https://dav.jianguoyun.com/dav/liveagent/";
        let unauthorized = describe_status_error(url, StatusCode::UNAUTHORIZED, "连接");
        assert!(unauthorized.contains("应用密码"), "{unauthorized}");

        let conflict = describe_status_error(url, StatusCode::CONFLICT, "创建远端目录");
        assert!(conflict.contains("网页端手动创建"), "{conflict}");

        let not_found = describe_status_error(url, StatusCode::NOT_FOUND, "下载");
        assert!(not_found.contains("/dav/"), "{not_found}");

        let redirect = describe_status_error(url, StatusCode::FOUND, "连接");
        assert!(redirect.contains("dav.jianguoyun.com"), "{redirect}");
    }

    #[test]
    fn generic_errors_stay_generic() {
        let url = "https://example.com/dav/";
        let unauthorized = describe_status_error(url, StatusCode::UNAUTHORIZED, "连接");
        assert!(!unauthorized.contains("坚果云"), "{unauthorized}");
        assert!(unauthorized.contains("用户名与密码"), "{unauthorized}");

        let storage = describe_status_error(url, StatusCode::INSUFFICIENT_STORAGE, "上传");
        assert!(storage.contains("空间不足"), "{storage}");

        // 未特别处理的状态码回落到通用文案，且带上动作名。
        let teapot = describe_status_error(url, StatusCode::IM_A_TEAPOT, "上传");
        assert!(teapot.contains("上传失败"), "{teapot}");
    }

    #[test]
    fn error_text_never_leaks_credentials() {
        let url = "https://alice:s3cret@dav.jianguoyun.com/dav/x?token=abc";
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::NOT_FOUND,
            StatusCode::CONFLICT,
            StatusCode::IM_A_TEAPOT,
        ] {
            let message = describe_status_error(url, status, "上传");
            assert!(!message.contains("s3cret"), "{message}");
            assert!(!message.contains("token=abc"), "{message}");
        }
    }

    /// 真实服务器联通性测试。**默认不跑**（`#[ignore]`）。
    ///
    /// 凭据只从环境变量读，永不落进仓库：
    /// ```text
    /// LIVEAGENT_WEBDAV_URL=https://dav.jianguoyun.com/dav/ \
    /// LIVEAGENT_WEBDAV_USER=... \
    /// LIVEAGENT_WEBDAV_PASS=... \
    /// cargo test --lib services::webdav::tests::live -- --ignored --nocapture
    /// ```
    /// 三个变量缺任一即跳过，避免在 CI 上变成失败。
    ///
    /// 四段合成一个用例而不是四个：它们共用同一个远端目录，并行跑会互相踩踏
    /// （建目录/写文件/删文件的顺序不确定）。
    #[tokio::test]
    #[ignore = "需要真实 WebDAV 账号，通过 LIVEAGENT_WEBDAV_* 环境变量提供"]
    async fn live_webdav_end_to_end() {
        let (Ok(base_url), Ok(username), Ok(password)) = (
            std::env::var("LIVEAGENT_WEBDAV_URL"),
            std::env::var("LIVEAGENT_WEBDAV_USER"),
            std::env::var("LIVEAGENT_WEBDAV_PASS"),
        ) else {
            eprintln!("跳过：未设置 LIVEAGENT_WEBDAV_URL / _USER / _PASS");
            return;
        };

        let creds = WebdavCredentials {
            base_url,
            username,
            password,
        };

        // ① 测试连接成功（AC6 正向）
        test_connection(&creds).await.expect("test_connection 应成功");
        eprintln!("① test_connection: ok");

        // ② 错误密码走到坚果云特判文案（AC6 反向 + 错误映射）
        let bad = WebdavCredentials {
            password: "definitely-not-the-password".to_string(),
            ..creds.clone()
        };
        let err = test_connection(&bad)
            .await
            .expect_err("错误密码应认证失败");
        assert!(err.contains("认证失败"), "{err}");
        assert!(
            !err.contains("definitely-not-the-password"),
            "错误文案不得回显凭据：{err}"
        );
        eprintln!("② 错误密码: {err}");

        // ③ 建目录 → PUT → GET 往返（AC8/AC9 的传输基础）
        let dir = format!("liveagent-livetest-{}", std::process::id());
        ensure_remote_dirs(&creds, &[&dir])
            .await
            .expect("ensure_remote_dirs 应成功");
        // 重复调用必须幂等（走 MKCOL 405/409 → PROPFIND 回落这条分支）
        ensure_remote_dirs(&creds, &[&dir])
            .await
            .expect("ensure_remote_dirs 应幂等");
        eprintln!("③ ensure_remote_dirs（含幂等重试）: ok");

        // 载荷刻意含中文：验证 UTF-8 字节在 PUT/GET 往返中不被服务器改写。
        let body = r#"{"hello":"webdav","zh":"中文"}"#.as_bytes().to_vec();
        put_bytes(&creds, &[&dir, "probe.json"], body.clone(), "application/json")
            .await
            .expect("put_bytes 应成功");
        let fetched = get_bytes(&creds, &[&dir, "probe.json"], 1024 * 1024, "探针")
            .await
            .expect("get_bytes 应成功")
            .expect("刚上传的文件必须存在");
        assert_eq!(fetched, body, "下行字节必须与上行完全一致");
        eprintln!("④ put/get 往返 {} 字节: 一致", body.len());

        // ④ 缺失文件返回 Ok(None) 而不是 Err —— 「远端还没有备份」的判定基础
        let missing = get_bytes(&creds, &[&dir, "no-such-file.json"], 1024, "探针")
            .await
            .expect("404 不应报错");
        assert!(missing.is_none(), "缺失文件应返回 Ok(None)");
        eprintln!("⑤ 缺失文件: Ok(None)");
    }
}
