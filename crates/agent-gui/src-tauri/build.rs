fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let package_json = std::path::Path::new(&manifest_dir)
        .join("..")
        .join("package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());
    println!("cargo:rerun-if-env-changed=LIVEAGENT_APP_VERSION");

    let app_version = std::env::var("LIVEAGENT_APP_VERSION")
        .ok()
        .map(|version| version.trim().to_owned())
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| {
            let package_json_text =
                std::fs::read_to_string(&package_json).expect("read app package.json for version");
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

    // v2 业务消息与 WebSocket 帧壳共用 agent-gateway 目录为 include 根。
    let gateway_root = std::path::Path::new(&manifest_dir)
        .join("..")
        .join("..")
        .join("agent-gateway");
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

    let is_windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if is_windows_msvc {
        let manifest_path = std::path::Path::new(
            &std::env::var("OUT_DIR").expect("OUT_DIR for Windows app manifest"),
        )
        .join("windows-app-manifest.xml");
        std::fs::write(
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
        println!(
            "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
            manifest_path.display()
        );
    } else {
        tauri_build::build();
    }
}
