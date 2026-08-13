//! Build script for agent-gui.
//!
//! Always runs:
//!   - Version injection: reads `LIVEAGENT_APP_VERSION` (env override) or the
//!     `version` field from `../package.json` and exposes it to the crate as
//!     `env!("LIVEAGENT_APP_VERSION")`.
//!   - Gateway protobuf compilation: compiles `gateway.proto` +
//!     `gateway_ws.proto` (shared with agent-gateway) into
//!     `OUT_DIR/liveagent.gateway.v2.rs` via prost-build.
//!
//! Desktop builds (`--features desktop`) additionally run the Tauri build glue.
//!
//! Headless builds (`--no-default-features`) additionally embed the WebUI
//! static assets into `OUT_DIR/embedded_web.rs` so the headless server can
//! serve the UI without a separate `dist` directory at runtime.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    // --- Version injection -------------------------------------------------
    let package_json = manifest_dir.join("../package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());
    println!("cargo:rerun-if-env-changed=LIVEAGENT_APP_VERSION");

    let app_version = env::var("LIVEAGENT_APP_VERSION")
        .ok()
        .map(|version| version.trim().to_owned())
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| {
            let package_json_text =
                fs::read_to_string(&package_json).expect("read app package.json for version");
            let package_json_value: serde_json::Value = serde_json::from_str(&package_json_text)
                .expect("parse app package.json for version");
            package_json_value
                .get("version")
                .and_then(serde_json::Value::as_str)
                .filter(|version| !version.trim().is_empty())
                .expect("app package.json version must be a non-empty string")
                .trim()
                .to_owned()
        });
    println!("cargo:rustc-env=LIVEAGENT_APP_VERSION={app_version}");

    // --- Gateway protobuf compilation --------------------------------------
    // v2 business messages and the WS frame shell share agent-gateway as the
    // proto include root.
    let gateway_root = manifest_dir.join("../../agent-gateway");
    let proto_v2 = gateway_root.join("proto").join("v2").join("gateway.proto");
    let proto_v2_ws = gateway_root
        .join("proto")
        .join("v2")
        .join("gateway_ws.proto");

    println!("cargo:rerun-if-changed={}", proto_v2.display());
    println!("cargo:rerun-if-changed={}", proto_v2_ws.display());

    prost_build::Config::new()
        .compile_protos(&[proto_v2, proto_v2_ws], &[gateway_root])
        .expect("compile gateway protos");

    // --- Desktop: Tauri build glue -----------------------------------------
    #[cfg(feature = "desktop")]
    {
        let is_windows_msvc = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
            && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
        if is_windows_msvc {
            let manifest_path = out_dir.join("windows-app-manifest.xml");
            fs::write(
                &manifest_path,
                r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#,
            )
            .expect("write Windows app manifest");
            let attributes = tauri_build::Attributes::new()
                .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
            tauri_build::try_build(attributes).expect("run Tauri build script");
            println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
            println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest_path.display());
        } else {
            tauri_build::build();
        }
    }

    // --- Headless: embed WebUI static assets -------------------------------
    #[cfg(not(feature = "desktop"))]
    embed_webui(&manifest_dir, &out_dir);
}

/// Embed the WebUI `dist` into `OUT_DIR/embedded_web.rs` for headless builds.
///
/// Generates:
///   - `EMBEDDED_FILES: LazyLock<HashMap<&'static str, &'static [u8]>>`
///   - `fn mime_for_path(path: &str) -> &'static str`
///
/// dist resolution: `LIVEAGENT_WEB_ROOT` env > `../dist` (relative to
/// src-tauri, matching the runtime-fallback path in headless.rs).
fn embed_webui(manifest_dir: &PathBuf, out_dir: &PathBuf) {
    let web_dist = if let Ok(root) = env::var("LIVEAGENT_WEB_ROOT") {
        PathBuf::from(root)
    } else {
        manifest_dir.join("../dist")
    };

    let out_file = out_dir.join("embedded_web.rs");

    if !web_dist.is_dir() {
        eprintln!(
            "cargo:warning=WebUI dist not found at {:?}; headless will compile without embedded assets",
            web_dist
        );
        // Empty stub
        fs::write(
            &out_file,
            "use std::collections::HashMap;\n\
             use std::sync::LazyLock;\n\
             pub static EMBEDDED_FILES: LazyLock<HashMap<&'static str, &'static [u8]>> = LazyLock::new(HashMap::new);\n\
             pub fn mime_for_path(_: &str) -> &'static str { \"application/octet-stream\" }\n",
        )
        .unwrap();
        return;
    }

    // Collect all files
    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    collect_files(&web_dist, &web_dist, &mut entries);
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut code = String::with_capacity(entries.len() * 100);
    code.push_str("// AUTO-GENERATED by build.rs — do not edit.\n");
    code.push_str("use std::collections::HashMap;\n");
    code.push_str("use std::sync::LazyLock;\n\n");

    // Static byte arrays
    for (i, (_, abs)) in entries.iter().enumerate() {
        let abs_str = abs.to_str().unwrap();
        code.push_str(&format!("static FILE_{i}: &[u8] = include_bytes!(\"{abs_str}\");\n"));
    }

    // LazyLock HashMap
    code.push_str("\npub static EMBEDDED_FILES: LazyLock<HashMap<&'static str, &'static [u8]>> = LazyLock::new(|| {\n");
    code.push_str("    let mut m = HashMap::new();\n");
    for (i, (rel, _)) in entries.iter().enumerate() {
        code.push_str(&format!("    m.insert(\"{rel}\", FILE_{i} as &[u8]);\n"));
    }
    code.push_str("    m\n});\n\n");

    // MIME type helper
    code.push_str("pub fn mime_for_path(path: &str) -> &'static str {\n");
    code.push_str("    match path.rsplit('.').next() {\n");
    for (ext, mime) in [
        ("html", "text/html; charset=utf-8"),
        ("css", "text/css; charset=utf-8"),
        ("js", "application/javascript; charset=utf-8"),
        ("mjs", "application/javascript; charset=utf-8"),
        ("json", "application/json"),
        ("svg", "image/svg+xml"),
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("jpeg", "image/jpeg"),
        ("gif", "image/gif"),
        ("woff2", "font/woff2"),
        ("woff", "font/woff"),
        ("ttf", "font/ttf"),
        ("ico", "image/x-icon"),
    ] {
        code.push_str(&format!("        Some(\"{ext}\") => \"{mime}\",\n"));
    }
    code.push_str("        _ => \"application/octet-stream\",\n");
    code.push_str("    }\n}\n");

    fs::write(&out_file, &code).unwrap();

    // Rebuild when dist changes
    println!("cargo:rerun-if-changed={}", web_dist.display());
    println!("cargo:rerun-if-env-changed=LIVEAGENT_WEB_ROOT");
}

/// Recursively collect files, computing paths relative to `root`.
fn collect_files(root: &PathBuf, dir: &PathBuf, out: &mut Vec<(String, PathBuf)>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_files(root, &path, out);
            } else if path.is_file() {
                let rel = path.strip_prefix(root).unwrap().to_str().unwrap().to_string();
                out.push((rel, path));
            }
        }
    }
}
