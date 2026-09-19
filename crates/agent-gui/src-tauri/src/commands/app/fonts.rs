use std::time::Duration;
use tokio::process::Command;

#[tauri::command]
pub async fn system_list_font_families() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("/usr/bin/osascript");
        command.args([
            "-l", "JavaScript", "-e",
            "ObjC.import('CoreText'); ObjC.deepUnwrap(ObjC.castRefToObject($.CTFontManagerCopyAvailableFontFamilyNames())).join('\\n')",
        ]);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("powershell.exe");
        command.creation_flags(0x08000000);
        command.args([
            "-NoProfile", "-NonInteractive", "-Command",
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName PresentationCore; [Windows.Media.Fonts]::SystemFontFamilies | ForEach-Object { $_.Source }",
        ]);
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut command = Command::new("fc-list");
        command.args(["-f", "%{family[0]}\n"]);
        command
    };

    command.kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| "System font enumeration timed out".to_string())?
        .map_err(|error| format!("System font enumeration failed: {error}"))?;
    if !output.status.success() {
        return Err("System font enumeration failed".into());
    }
    Ok(normalize_families(&String::from_utf8_lossy(&output.stdout)))
}

fn normalize_families(output: &str) -> Vec<String> {
    let mut families: Vec<String> = output
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty() && !name.starts_with('.'))
        .map(str::to_owned)
        .collect();
    families.sort();
    families.dedup();
    families
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excludes_hidden_families_and_deduplicates_platform_output() {
        assert_eq!(
            normalize_families("Inter\r\n.PUA Font\n 苹方 \nInter\n\nArial\n"),
            ["Arial", "Inter", "苹方"]
        );
    }
}
