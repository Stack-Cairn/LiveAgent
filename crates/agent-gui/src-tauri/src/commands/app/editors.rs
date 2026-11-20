//! "Open in editor": detects the code editors installed on this machine and
//! opens workspace files or folders (optionally at a line) in one of them.
//!
//! Detection is data-driven: `EDITOR_SPECS` lists every supported editor with
//! the places it installs on each platform (macOS app bundles, Windows install
//! directories and App Paths, CLI launchers on PATH). All filesystem, PATH and
//! registry lookups go through `EditorProbe`, so the detection table and the
//! command construction are unit-tested without touching the host. Results are
//! cached for the session; a refresh request re-runs detection.
//!
//! Launching never goes through a shell: the program and every argument are
//! passed to `Command` separately, so paths are never interpolated into a
//! command string.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;

use crate::commands::fs::{resolve_workspace_launch_target, FsCommandError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostOs {
    MacOs,
    Windows,
    Linux,
}

impl HostOs {
    fn current() -> Self {
        if cfg!(target_os = "macos") {
            HostOs::MacOs
        } else if cfg!(target_os = "windows") {
            HostOs::Windows
        } else {
            HostOs::Linux
        }
    }
}

/// How an editor's launcher takes a line (and column) to jump to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EditorFamily {
    /// VS Code and its forks: `--goto <path>:<line>[:<column>]`.
    VsCode,
    /// Zed and Sublime Text: `<path>:<line>[:<column>]`.
    PathSuffix,
    /// JetBrains launchers: `--line <line> [--column <column>] <path>`.
    JetBrains,
    /// Xcode through `xed`: `--line <line> <path>`.
    Xcode,
}

/// Base directory of a Windows install location.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WinBase {
    LocalAppData,
    ProgramFiles,
    ProgramFilesX86,
}

impl WinBase {
    fn env_key(self) -> &'static str {
        match self {
            WinBase::LocalAppData => "LOCALAPPDATA",
            WinBase::ProgramFiles => "ProgramFiles",
            WinBase::ProgramFilesX86 => "ProgramFiles(x86)",
        }
    }
}

struct EditorSpec {
    id: &'static str,
    name: &'static str,
    family: EditorFamily,
    /// macOS app bundle names, looked up in /Applications and ~/Applications.
    mac_apps: &'static [&'static str],
    /// Launchers that accept line arguments, relative to the app bundle
    /// (or absolute, e.g. `/usr/bin/xed`). The first existing one is used.
    mac_line_launchers: &'static [&'static str],
    /// Windows install locations, relative to their base directory.
    windows_paths: &'static [(WinBase, &'static str)],
    /// Executable names registered under the Windows "App Paths" key.
    windows_app_paths: &'static [&'static str],
    /// JetBrains installs under `%ProgramFiles%\JetBrains\<prefix> <version>\bin\<exe>`.
    windows_jetbrains: Option<(&'static str, &'static str)>,
    /// Launcher commands looked up on PATH (and the platform's extra CLI
    /// directories). Windows also tries `.exe`, `.cmd` and `.bat`.
    commands: &'static [&'static str],
}

macro_rules! jetbrains_ide {
    ($id:literal, $name:literal, [$($app:literal),+], $launcher:literal, $win_prefix:literal, $win_exe:literal, [$($cmd:literal),+]) => {
        EditorSpec {
            id: $id,
            name: $name,
            family: EditorFamily::JetBrains,
            mac_apps: &[$($app),+],
            // JetBrains IDEs are relaunched through LaunchServices with
            // `open -na <app> --args --line`, which forwards to a running IDE.
            mac_line_launchers: &[],
            windows_paths: &[],
            windows_app_paths: &[$win_exe],
            windows_jetbrains: Some(($win_prefix, $win_exe)),
            commands: &[$($cmd),+, $launcher],
        }
    };
}

/// Every supported editor, in default preference order: the first detected
/// one is the default "Open in" target until the user picks another.
static EDITOR_SPECS: &[EditorSpec] = &[
    EditorSpec {
        id: "vscode",
        name: "VS Code",
        family: EditorFamily::VsCode,
        mac_apps: &["Visual Studio Code.app"],
        mac_line_launchers: &["Contents/Resources/app/bin/code"],
        windows_paths: &[
            (
                WinBase::LocalAppData,
                r"Programs\Microsoft VS Code\Code.exe",
            ),
            (WinBase::ProgramFiles, r"Microsoft VS Code\Code.exe"),
        ],
        windows_app_paths: &["Code.exe"],
        windows_jetbrains: None,
        commands: &["code"],
    },
    EditorSpec {
        id: "cursor",
        name: "Cursor",
        family: EditorFamily::VsCode,
        mac_apps: &["Cursor.app"],
        mac_line_launchers: &[
            "Contents/Resources/app/bin/cursor",
            "Contents/Resources/app/bin/code",
        ],
        windows_paths: &[
            (WinBase::LocalAppData, r"Programs\cursor\Cursor.exe"),
            (WinBase::ProgramFiles, r"Cursor\Cursor.exe"),
        ],
        windows_app_paths: &["Cursor.exe"],
        windows_jetbrains: None,
        commands: &["cursor"],
    },
    EditorSpec {
        id: "windsurf",
        name: "Windsurf",
        family: EditorFamily::VsCode,
        mac_apps: &["Windsurf.app"],
        mac_line_launchers: &["Contents/Resources/app/bin/windsurf"],
        windows_paths: &[
            (WinBase::LocalAppData, r"Programs\Windsurf\Windsurf.exe"),
            (WinBase::ProgramFiles, r"Windsurf\Windsurf.exe"),
        ],
        windows_app_paths: &["Windsurf.exe"],
        windows_jetbrains: None,
        commands: &["windsurf"],
    },
    EditorSpec {
        id: "zed",
        name: "Zed",
        family: EditorFamily::PathSuffix,
        mac_apps: &["Zed.app"],
        mac_line_launchers: &["Contents/MacOS/cli"],
        windows_paths: &[
            (WinBase::LocalAppData, r"Programs\Zed\bin\zed.exe"),
            (WinBase::LocalAppData, r"Programs\Zed\Zed.exe"),
        ],
        windows_app_paths: &[],
        windows_jetbrains: None,
        // `zeditor` / `zedit` are the names some Linux distributions ship.
        commands: &["zed", "zeditor", "zedit"],
    },
    EditorSpec {
        id: "sublime",
        name: "Sublime Text",
        family: EditorFamily::PathSuffix,
        mac_apps: &["Sublime Text.app"],
        mac_line_launchers: &["Contents/SharedSupport/bin/subl"],
        windows_paths: &[
            (WinBase::ProgramFiles, r"Sublime Text\subl.exe"),
            (WinBase::ProgramFiles, r"Sublime Text 3\subl.exe"),
        ],
        windows_app_paths: &["sublime_text.exe"],
        windows_jetbrains: None,
        commands: &["subl"],
    },
    EditorSpec {
        id: "vscode-insiders",
        name: "VS Code Insiders",
        family: EditorFamily::VsCode,
        mac_apps: &["Visual Studio Code - Insiders.app"],
        mac_line_launchers: &[
            "Contents/Resources/app/bin/code-insiders",
            "Contents/Resources/app/bin/code",
        ],
        windows_paths: &[
            (
                WinBase::LocalAppData,
                r"Programs\Microsoft VS Code Insiders\Code - Insiders.exe",
            ),
            (
                WinBase::ProgramFiles,
                r"Microsoft VS Code Insiders\Code - Insiders.exe",
            ),
        ],
        windows_app_paths: &[],
        windows_jetbrains: None,
        commands: &["code-insiders"],
    },
    jetbrains_ide!(
        "intellij-idea",
        "IntelliJ IDEA",
        [
            "IntelliJ IDEA.app",
            "IntelliJ IDEA Ultimate.app",
            "IntelliJ IDEA CE.app",
            "IntelliJ IDEA Community Edition.app"
        ],
        "idea",
        "IntelliJ IDEA",
        "idea64.exe",
        [
            "intellij-idea-ultimate",
            "intellij-idea-community",
            "idea64"
        ]
    ),
    jetbrains_ide!(
        "webstorm",
        "WebStorm",
        ["WebStorm.app"],
        "webstorm",
        "WebStorm",
        "webstorm64.exe",
        ["webstorm64"]
    ),
    jetbrains_ide!(
        "pycharm",
        "PyCharm",
        [
            "PyCharm.app",
            "PyCharm Professional Edition.app",
            "PyCharm CE.app",
            "PyCharm Community Edition.app"
        ],
        "pycharm",
        "PyCharm",
        "pycharm64.exe",
        ["pycharm-professional", "pycharm-community", "pycharm64"]
    ),
    jetbrains_ide!(
        "goland",
        "GoLand",
        ["GoLand.app"],
        "goland",
        "GoLand",
        "goland64.exe",
        ["goland64"]
    ),
    jetbrains_ide!(
        "clion",
        "CLion",
        ["CLion.app"],
        "clion",
        "CLion",
        "clion64.exe",
        ["clion64"]
    ),
    jetbrains_ide!(
        "rustrover",
        "RustRover",
        ["RustRover.app"],
        "rustrover",
        "RustRover",
        "rustrover64.exe",
        ["rustrover64"]
    ),
    EditorSpec {
        id: "xcode",
        name: "Xcode",
        family: EditorFamily::Xcode,
        mac_apps: &["Xcode.app"],
        mac_line_launchers: &["/usr/bin/xed"],
        windows_paths: &[],
        windows_app_paths: &[],
        windows_jetbrains: None,
        // Xcode is macOS-only; `xed` alone (Command Line Tools) is no editor.
        commands: &[],
    },
];

fn spec_by_id(id: &str) -> Option<&'static EditorSpec> {
    EDITOR_SPECS.iter().find(|spec| spec.id == id)
}

/// Host lookups used by detection; the real implementation reads the
/// filesystem, environment and (on Windows) the registry.
pub(crate) trait EditorProbe {
    fn is_dir(&self, path: &Path) -> bool;
    fn is_file(&self, path: &Path) -> bool;
    /// Entry names of a directory (empty when it is missing).
    fn list_dir(&self, path: &Path) -> Vec<String>;
    fn home_dir(&self) -> Option<PathBuf>;
    /// A directory-valued environment variable such as `LOCALAPPDATA`.
    fn env_dir(&self, key: &str) -> Option<PathBuf>;
    /// Absolute PATH entries (relative entries are dropped by the caller).
    fn path_dirs(&self) -> Vec<PathBuf>;
    /// Windows "App Paths" registration of an executable name.
    fn windows_app_path(&self, exe: &str) -> Option<PathBuf>;
}

/// How a detected editor is started.
#[derive(Clone, Debug, PartialEq, Eq)]
enum EditorInstall {
    /// A macOS app bundle, opened through LaunchServices (`open -a`). The
    /// optional launcher accepts line arguments.
    MacApp {
        app: PathBuf,
        line_launcher: Option<PathBuf>,
    },
    /// An executable or launcher script started directly.
    Executable(PathBuf),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DetectedEditor {
    spec: &'static EditorSpec,
    install: EditorInstall,
}

impl PartialEq for EditorSpec {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}
impl Eq for EditorSpec {}
impl std::fmt::Debug for EditorSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorInfo {
    pub id: String,
    pub name: String,
}

impl DetectedEditor {
    fn info(&self) -> EditorInfo {
        EditorInfo {
            id: self.spec.id.to_string(),
            name: self.spec.name.to_string(),
        }
    }
}

/// Joins a backslash-separated Windows relative path segment by segment, so
/// the table reads naturally and the detection logic is testable anywhere.
fn join_windows_relative(base: &Path, relative: &str) -> PathBuf {
    relative
        .split('\\')
        .filter(|segment| !segment.is_empty())
        .fold(base.to_path_buf(), |path, segment| path.join(segment))
}

/// Extra CLI directories a GUI-launched process may not have on PATH
/// (macOS apps started from Finder get launchd's minimal PATH).
fn extra_command_dirs(os: HostOs, probe: &dyn EditorProbe) -> Vec<PathBuf> {
    let home = probe.home_dir();
    let mut dirs = Vec::new();
    match os {
        HostOs::MacOs => {
            dirs.push(PathBuf::from("/opt/homebrew/bin"));
            dirs.push(PathBuf::from("/usr/local/bin"));
            if let Some(home) = &home {
                dirs.push(home.join(".local/bin"));
                dirs.push(home.join("Library/Application Support/JetBrains/Toolbox/scripts"));
            }
        }
        HostOs::Linux => {
            dirs.push(PathBuf::from("/usr/local/bin"));
            dirs.push(PathBuf::from("/usr/bin"));
            dirs.push(PathBuf::from("/snap/bin"));
            if let Some(home) = &home {
                dirs.push(home.join(".local/bin"));
                dirs.push(home.join(".local/share/JetBrains/Toolbox/scripts"));
            }
        }
        HostOs::Windows => {
            if let Some(local) = probe.env_dir(WinBase::LocalAppData.env_key()) {
                dirs.push(join_windows_relative(&local, r"JetBrains\Toolbox\scripts"));
            }
        }
    }
    dirs
}

fn command_dirs(os: HostOs, probe: &dyn EditorProbe) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in probe
        .path_dirs()
        .into_iter()
        .chain(extra_command_dirs(os, probe))
    {
        // Never resolve launchers relative to the current directory.
        if dir.is_absolute() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

fn command_file_names(os: HostOs, command: &str) -> Vec<String> {
    match os {
        HostOs::Windows => [".exe", ".cmd", ".bat"]
            .iter()
            .map(|ext| format!("{command}{ext}"))
            .collect(),
        HostOs::MacOs | HostOs::Linux => vec![command.to_string()],
    }
}

fn find_command(
    os: HostOs,
    probe: &dyn EditorProbe,
    dirs: &[PathBuf],
    commands: &[&str],
) -> Option<PathBuf> {
    for command in commands {
        for dir in dirs {
            for file_name in command_file_names(os, command) {
                let candidate = dir.join(file_name);
                if probe.is_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn detect_mac_app(probe: &dyn EditorProbe, spec: &EditorSpec) -> Option<EditorInstall> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = probe.home_dir() {
        roots.push(home.join("Applications"));
    }
    let app = roots
        .iter()
        .flat_map(|root| spec.mac_apps.iter().map(move |name| root.join(name)))
        .find(|candidate| probe.is_dir(candidate))?;
    let line_launcher = spec
        .mac_line_launchers
        .iter()
        .map(|launcher| {
            let launcher = Path::new(launcher);
            if launcher.is_absolute() {
                launcher.to_path_buf()
            } else {
                app.join(launcher)
            }
        })
        .find(|candidate| probe.is_file(candidate));
    Some(EditorInstall::MacApp { app, line_launcher })
}

fn detect_windows_install(probe: &dyn EditorProbe, spec: &EditorSpec) -> Option<PathBuf> {
    for (base, relative) in spec.windows_paths {
        if let Some(base_dir) = probe.env_dir(base.env_key()) {
            let candidate = join_windows_relative(&base_dir, relative);
            if probe.is_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    for exe in spec.windows_app_paths {
        if let Some(candidate) = probe.windows_app_path(exe) {
            if probe.is_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    let (prefix, exe) = spec.windows_jetbrains?;
    for base in [WinBase::ProgramFiles, WinBase::ProgramFilesX86] {
        let Some(base_dir) = probe.env_dir(base.env_key()) else {
            continue;
        };
        let vendor_dir = base_dir.join("JetBrains");
        let mut installs: Vec<String> = probe
            .list_dir(&vendor_dir)
            .into_iter()
            .filter(|name| name.starts_with(prefix))
            .collect();
        // "<Product> 2024.3" sorts after "<Product> 2023.1": newest first.
        installs.sort_by(|a, b| b.cmp(a));
        for install in installs {
            let candidate = vendor_dir.join(install).join("bin").join(exe);
            if probe.is_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Detects the installed editors, in `EDITOR_SPECS` order.
pub(crate) fn detect_editors(os: HostOs, probe: &dyn EditorProbe) -> Vec<DetectedEditor> {
    let dirs = command_dirs(os, probe);
    EDITOR_SPECS
        .iter()
        .filter_map(|spec| {
            let install = match os {
                HostOs::MacOs => detect_mac_app(probe, spec),
                HostOs::Windows => {
                    detect_windows_install(probe, spec).map(EditorInstall::Executable)
                }
                HostOs::Linux => None,
            }
            .or_else(|| {
                find_command(os, probe, &dirs, spec.commands).map(EditorInstall::Executable)
            })?;
            Some(DetectedEditor { spec, install })
        })
        .collect()
}

/// Program plus argument vector for one launch; never a shell string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LaunchPlan {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct EditorLocation {
    pub line: Option<u32>,
    pub column: Option<u32>,
}

fn path_with_suffix(target: &Path, line: u32, column: Option<u32>) -> OsString {
    let mut value = target.as_os_str().to_os_string();
    value.push(format!(":{line}"));
    if let Some(column) = column {
        value.push(format!(":{column}"));
    }
    value
}

fn editor_args(family: EditorFamily, target: &Path, location: EditorLocation) -> Vec<OsString> {
    let Some(line) = location.line else {
        return vec![target.as_os_str().to_os_string()];
    };
    let column = location.column;
    match family {
        EditorFamily::VsCode => vec!["--goto".into(), path_with_suffix(target, line, column)],
        EditorFamily::PathSuffix => vec![path_with_suffix(target, line, column)],
        EditorFamily::JetBrains => {
            let mut args: Vec<OsString> = vec!["--line".into(), line.to_string().into()];
            if let Some(column) = column {
                args.push("--column".into());
                args.push(column.to_string().into());
            }
            args.push(target.as_os_str().to_os_string());
            args
        }
        EditorFamily::Xcode => vec![
            "--line".into(),
            line.to_string().into(),
            target.as_os_str().to_os_string(),
        ],
    }
}

const MAC_OPEN: &str = "/usr/bin/open";

/// Builds the command that opens `target` in `editor`. Folders never carry a
/// line; a zero line or column is treated as absent.
pub(crate) fn build_launch_plan(
    editor: &DetectedEditor,
    target: &Path,
    is_dir: bool,
    location: EditorLocation,
) -> LaunchPlan {
    let line = location.line.filter(|line| *line > 0 && !is_dir);
    let location = EditorLocation {
        line,
        column: line.and(location.column.filter(|column| *column > 0)),
    };
    let family = editor.spec.family;
    match &editor.install {
        EditorInstall::Executable(program) => LaunchPlan {
            program: program.clone(),
            args: editor_args(family, target, location),
        },
        EditorInstall::MacApp { app, line_launcher } => {
            match (location.line, line_launcher, family) {
                (Some(_), Some(launcher), _) => LaunchPlan {
                    program: launcher.clone(),
                    args: editor_args(family, target, location),
                },
                // JetBrains documents `open -na <app> --args ...` for passing
                // command-line options to an IDE bundle.
                (Some(_), None, EditorFamily::JetBrains) => {
                    let mut args: Vec<OsString> = vec![
                        "-na".into(),
                        app.as_os_str().to_os_string(),
                        "--args".into(),
                    ];
                    args.extend(editor_args(family, target, location));
                    LaunchPlan {
                        program: PathBuf::from(MAC_OPEN),
                        args,
                    }
                }
                _ => LaunchPlan {
                    program: PathBuf::from(MAC_OPEN),
                    args: vec![
                        "-a".into(),
                        app.as_os_str().to_os_string(),
                        target.as_os_str().to_os_string(),
                    ],
                },
            }
        }
    }
}

struct SystemProbe;

impl EditorProbe for SystemProbe {
    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }

    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }

    fn list_dir(&self, path: &Path) -> Vec<String> {
        std::fs::read_dir(path)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn home_dir(&self) -> Option<PathBuf> {
        dirs::home_dir()
    }

    fn env_dir(&self, key: &str) -> Option<PathBuf> {
        std::env::var_os(key)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    }

    fn path_dirs(&self) -> Vec<PathBuf> {
        std::env::var_os("PATH")
            .map(|value| std::env::split_paths(&value).collect())
            .unwrap_or_default()
    }

    fn windows_app_path(&self, exe: &str) -> Option<PathBuf> {
        #[cfg(windows)]
        {
            windows_registry::app_path(exe)
        }
        #[cfg(not(windows))]
        {
            let _ = exe;
            None
        }
    }
}

#[cfg(windows)]
mod windows_registry {
    use std::path::PathBuf;
    use windows_sys::Win32::Foundation::NO_ERROR;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn read_default_value(root: HKEY, key: &str) -> Option<String> {
        let key = wide(key);
        let mut buffer = vec![0u16; 1024];
        let mut size = (buffer.len() * 2) as u32;
        // A null value name reads the key's default value; RRF_RT_REG_SZ
        // also accepts REG_EXPAND_SZ and expands it.
        let status = unsafe {
            RegGetValueW(
                root,
                key.as_ptr(),
                std::ptr::null(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != NO_ERROR {
            return None;
        }
        let length = (size as usize / 2).min(buffer.len());
        let text = String::from_utf16_lossy(&buffer[..length]);
        Some(
            text.trim_end_matches('\0')
                .trim()
                .trim_matches('"')
                .to_string(),
        )
    }

    pub(super) fn app_path(exe: &str) -> Option<PathBuf> {
        let key = format!(r"Software\Microsoft\Windows\CurrentVersion\App Paths\{exe}");
        [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
            .into_iter()
            .find_map(|root| read_default_value(root, &key))
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    }
}

type EditorCache = Mutex<Option<Arc<Vec<DetectedEditor>>>>;

static DETECTED_EDITORS: OnceLock<EditorCache> = OnceLock::new();

fn detected_editors(refresh: bool) -> Arc<Vec<DetectedEditor>> {
    let cache = DETECTED_EDITORS.get_or_init(|| Mutex::new(None));
    if !refresh {
        if let Some(editors) = cache.lock().ok().and_then(|guard| guard.clone()) {
            return editors;
        }
    }
    // Detect outside the lock; a concurrent first call at worst detects twice.
    let editors = Arc::new(detect_editors(HostOs::current(), &SystemProbe));
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(editors.clone());
    }
    editors
}

fn spawn_launch_plan(plan: &LaunchPlan) -> Result<(), String> {
    let mut command = Command::new(&plan.program);
    command
        .args(&plan.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Own process group on Unix (an editor started here must not share our
    // signals); no console window for `.cmd` launchers on Windows.
    crate::runtime::process::configure_child_process_group(&mut command);
    crate::runtime::process::spawn_and_reap(&mut command)
        .map(|_| ())
        .map_err(|error| format!("Failed to start the editor: {error}"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorOpenResponse {
    pub editor_id: String,
    pub kind: String,
}

fn editor_open_path_sync(
    editor_id: &str,
    workdir: &str,
    path: &str,
    location: EditorLocation,
) -> Result<EditorOpenResponse, FsCommandError> {
    if spec_by_id(editor_id).is_none() {
        return Err(FsCommandError::other(format!(
            "Unknown editor: {editor_id}"
        )));
    }
    let target = resolve_workspace_launch_target(workdir, path)?;
    let editors = detected_editors(false);
    let editor = editors
        .iter()
        .find(|editor| editor.spec.id == editor_id)
        .ok_or_else(|| {
            FsCommandError::other(format!(
                "{} is not installed on this device",
                spec_by_id(editor_id).map_or(editor_id, |spec| spec.name)
            ))
        })?;
    // Editors do not understand `\\?\` verbatim paths from canonicalize.
    let target_path = crate::runtime::platform::strip_windows_verbatim_prefix(target.path);
    let plan = build_launch_plan(editor, &target_path, target.is_dir, location);
    spawn_launch_plan(&plan).map_err(FsCommandError::other)?;
    Ok(EditorOpenResponse {
        editor_id: editor_id.to_string(),
        kind: if target.is_dir { "dir" } else { "file" }.to_string(),
    })
}

/// Lists the editors installed on this device, in default preference order.
/// Detection runs once per session on a blocking thread; `refresh` re-runs it.
#[tauri::command(rename_all = "snake_case")]
pub async fn editor_list(refresh: Option<bool>) -> Result<Vec<EditorInfo>, String> {
    let refresh = refresh.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        detected_editors(refresh)
            .iter()
            .map(DetectedEditor::info)
            .collect()
    })
    .await
    .map_err(|e| format!("editor_list join failed: {e}"))
}

/// Opens a workspace file or folder (`path` relative to `workdir`; empty for
/// the workspace root) in the given editor, optionally at a line and column.
#[tauri::command(rename_all = "snake_case")]
pub async fn editor_open_path(
    editor_id: String,
    workdir: String,
    path: String,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<EditorOpenResponse, FsCommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        editor_open_path_sync(&editor_id, &workdir, &path, EditorLocation { line, column })
    })
    .await
    .map_err(|e| FsCommandError::other(format!("editor_open_path join failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    /// In-memory host: the listed files and directories exist, nothing else.
    #[derive(Default)]
    struct FakeProbe {
        files: BTreeSet<PathBuf>,
        dirs: BTreeSet<PathBuf>,
        env: BTreeMap<String, PathBuf>,
        path: Vec<PathBuf>,
        app_paths: BTreeMap<String, PathBuf>,
        home: Option<PathBuf>,
    }

    impl FakeProbe {
        fn file(mut self, path: &str) -> Self {
            self.files.insert(PathBuf::from(path));
            self
        }
        fn dir(mut self, path: &str) -> Self {
            self.dirs.insert(PathBuf::from(path));
            self
        }
        fn env(mut self, key: &str, value: &str) -> Self {
            self.env.insert(key.to_string(), PathBuf::from(value));
            self
        }
        fn path_dir(mut self, dir: &str) -> Self {
            self.path.push(PathBuf::from(dir));
            self
        }
        fn home(mut self, home: &str) -> Self {
            self.home = Some(PathBuf::from(home));
            self
        }
        fn app_path(mut self, exe: &str, path: &str) -> Self {
            self.app_paths.insert(exe.to_string(), PathBuf::from(path));
            self
        }
    }

    impl EditorProbe for FakeProbe {
        fn is_dir(&self, path: &Path) -> bool {
            self.dirs.contains(path)
        }
        fn is_file(&self, path: &Path) -> bool {
            self.files.contains(path)
        }
        fn list_dir(&self, path: &Path) -> Vec<String> {
            self.dirs
                .iter()
                .filter(|dir| dir.parent() == Some(path))
                .filter_map(|dir| dir.file_name())
                .map(|name| name.to_string_lossy().into_owned())
                .collect()
        }
        fn home_dir(&self) -> Option<PathBuf> {
            self.home.clone()
        }
        fn env_dir(&self, key: &str) -> Option<PathBuf> {
            self.env.get(key).cloned()
        }
        fn path_dirs(&self) -> Vec<PathBuf> {
            self.path.clone()
        }
        fn windows_app_path(&self, exe: &str) -> Option<PathBuf> {
            self.app_paths.get(exe).cloned()
        }
    }

    fn ids(editors: &[DetectedEditor]) -> Vec<&'static str> {
        editors.iter().map(|editor| editor.spec.id).collect()
    }

    fn find<'a>(editors: &'a [DetectedEditor], id: &str) -> &'a DetectedEditor {
        editors
            .iter()
            .find(|editor| editor.spec.id == id)
            .unwrap_or_else(|| panic!("{id} not detected"))
    }

    fn os_args(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn spec_table_has_unique_ids_and_covers_required_editors() {
        let mut seen = BTreeSet::new();
        for spec in EDITOR_SPECS {
            assert!(seen.insert(spec.id), "duplicate editor id {}", spec.id);
            assert!(!spec.name.is_empty());
            assert!(
                !spec.mac_apps.is_empty() || !spec.commands.is_empty(),
                "{} is undetectable",
                spec.id
            );
        }
        for required in [
            "vscode",
            "vscode-insiders",
            "cursor",
            "windsurf",
            "zed",
            "sublime",
            "intellij-idea",
            "webstorm",
            "pycharm",
            "goland",
            "clion",
            "rustrover",
            "xcode",
        ] {
            assert!(seen.contains(required), "missing {required}");
        }
    }

    #[test]
    fn nothing_installed_detects_nothing() {
        for os in [HostOs::MacOs, HostOs::Windows, HostOs::Linux] {
            assert!(detect_editors(os, &FakeProbe::default().home("/home/u")).is_empty());
        }
    }

    #[test]
    fn macos_detects_bundles_in_both_application_dirs_in_table_order() {
        let probe = FakeProbe::default()
            .home("/Users/u")
            .dir("/Applications/Zed.app")
            .file("/Applications/Zed.app/Contents/MacOS/cli")
            .dir("/Applications/Visual Studio Code.app")
            .file("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")
            .dir("/Users/u/Applications/PyCharm CE.app")
            .dir("/Applications/Xcode.app");
        let editors = detect_editors(HostOs::MacOs, &probe);
        assert_eq!(ids(&editors), ["vscode", "zed", "pycharm", "xcode"]);
        assert_eq!(
            find(&editors, "pycharm").install,
            EditorInstall::MacApp {
                app: PathBuf::from("/Users/u/Applications/PyCharm CE.app"),
                line_launcher: None,
            }
        );
        assert_eq!(
            find(&editors, "vscode").install,
            EditorInstall::MacApp {
                app: PathBuf::from("/Applications/Visual Studio Code.app"),
                line_launcher: Some(PathBuf::from(
                    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
                )),
            }
        );
        // No /usr/bin/xed: Xcode still opens, just without a line launcher.
        assert_eq!(
            find(&editors, "xcode").install,
            EditorInstall::MacApp {
                app: PathBuf::from("/Applications/Xcode.app"),
                line_launcher: None,
            }
        );
    }

    #[test]
    fn macos_falls_back_to_cli_in_extra_dirs_when_no_bundle_exists() {
        // GUI apps get launchd's PATH; Homebrew and Toolbox dirs are added.
        let probe = FakeProbe::default()
            .home("/Users/u")
            .path_dir("/usr/bin")
            .file("/opt/homebrew/bin/subl")
            .file("/Users/u/Library/Application Support/JetBrains/Toolbox/scripts/goland");
        let editors = detect_editors(HostOs::MacOs, &probe);
        assert_eq!(ids(&editors), ["sublime", "goland"]);
        assert_eq!(
            find(&editors, "goland").install,
            EditorInstall::Executable(PathBuf::from(
                "/Users/u/Library/Application Support/JetBrains/Toolbox/scripts/goland"
            ))
        );
    }

    #[test]
    fn xcode_is_not_detected_from_xed_alone() {
        let probe = FakeProbe::default()
            .home("/Users/u")
            .path_dir("/usr/bin")
            .file("/usr/bin/xed");
        assert!(detect_editors(HostOs::MacOs, &probe).is_empty());
    }

    #[test]
    fn linux_detects_cli_launchers_and_ignores_relative_path_entries() {
        let probe = FakeProbe::default()
            .home("/home/u")
            .path_dir(".")
            .path_dir("node_modules/.bin")
            .path_dir("/usr/bin")
            .file("./code")
            .file("node_modules/.bin/cursor")
            .file("/usr/bin/zeditor")
            .file("/snap/bin/intellij-idea-community")
            .file("/home/u/.local/share/JetBrains/Toolbox/scripts/rustrover")
            .file("/home/u/.local/bin/windsurf");
        let editors = detect_editors(HostOs::Linux, &probe);
        assert_eq!(
            ids(&editors),
            ["windsurf", "zed", "intellij-idea", "rustrover"]
        );
        assert_eq!(
            find(&editors, "zed").install,
            EditorInstall::Executable(PathBuf::from("/usr/bin/zeditor"))
        );
    }

    #[test]
    fn linux_never_reports_xcode_or_mac_bundles() {
        let probe = FakeProbe::default()
            .home("/home/u")
            .dir("/Applications/Xcode.app")
            .dir("/Applications/Visual Studio Code.app");
        assert!(detect_editors(HostOs::Linux, &probe).is_empty());
    }

    #[test]
    fn windows_detects_install_dirs_app_paths_jetbrains_and_path() {
        // Drive paths are spelled Unix-style so the test runs on every host;
        // the table's backslash paths are joined segment by segment.
        let probe = FakeProbe::default()
            .env("LOCALAPPDATA", "/c/Users/u/AppData/Local")
            .env("ProgramFiles", "/c/Program Files")
            .path_dir("/c/bin")
            .file("/c/Users/u/AppData/Local/Programs/Microsoft VS Code/Code.exe")
            .app_path("sublime_text.exe", "/d/Apps/Sublime/sublime_text.exe")
            .file("/d/Apps/Sublime/sublime_text.exe")
            .dir("/c/Program Files/JetBrains")
            .dir("/c/Program Files/JetBrains/WebStorm 2023.3")
            .file("/c/Program Files/JetBrains/WebStorm 2023.3/bin/webstorm64.exe")
            .dir("/c/Program Files/JetBrains/WebStorm 2024.2")
            .file("/c/Program Files/JetBrains/WebStorm 2024.2/bin/webstorm64.exe")
            .file("/c/bin/cursor.cmd")
            .file("/c/Users/u/AppData/Local/JetBrains/Toolbox/scripts/clion.cmd");
        let editors = detect_editors(HostOs::Windows, &probe);
        assert_eq!(
            ids(&editors),
            ["vscode", "cursor", "sublime", "webstorm", "clion"]
        );
        let path = |editor: &DetectedEditor| match &editor.install {
            EditorInstall::Executable(path) => path.clone(),
            other => panic!("unexpected install {other:?}"),
        };
        assert_eq!(
            path(find(&editors, "vscode")),
            PathBuf::from("/c/Users/u/AppData/Local/Programs/Microsoft VS Code/Code.exe")
        );
        assert_eq!(
            path(find(&editors, "webstorm")),
            PathBuf::from("/c/Program Files/JetBrains/WebStorm 2024.2/bin/webstorm64.exe")
        );
        assert_eq!(
            path(find(&editors, "sublime")),
            PathBuf::from("/d/Apps/Sublime/sublime_text.exe")
        );
        assert_eq!(
            path(find(&editors, "cursor")),
            PathBuf::from("/c/bin/cursor.cmd")
        );
        assert_eq!(
            path(find(&editors, "clion")),
            PathBuf::from("/c/Users/u/AppData/Local/JetBrains/Toolbox/scripts/clion.cmd")
        );
    }

    #[test]
    fn windows_ignores_stale_app_path_registrations() {
        let probe = FakeProbe::default().app_path("Code.exe", "/c/gone/Code.exe");
        assert!(detect_editors(HostOs::Windows, &probe).is_empty());
    }

    fn mac_editor(id: &str, app: &str, launcher: Option<&str>) -> DetectedEditor {
        DetectedEditor {
            spec: spec_by_id(id).unwrap(),
            install: EditorInstall::MacApp {
                app: PathBuf::from(app),
                line_launcher: launcher.map(PathBuf::from),
            },
        }
    }

    fn exe_editor(id: &str, program: &str) -> DetectedEditor {
        DetectedEditor {
            spec: spec_by_id(id).unwrap(),
            install: EditorInstall::Executable(PathBuf::from(program)),
        }
    }

    fn at(line: u32, column: Option<u32>) -> EditorLocation {
        EditorLocation {
            line: Some(line),
            column,
        }
    }

    #[test]
    fn mac_bundle_without_line_opens_through_launch_services() {
        let editor = mac_editor(
            "vscode",
            "/Applications/Visual Studio Code.app",
            Some("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
        );
        let plan = build_launch_plan(
            &editor,
            Path::new("/work/my project/a b.ts"),
            false,
            EditorLocation::default(),
        );
        assert_eq!(plan.program, PathBuf::from("/usr/bin/open"));
        assert_eq!(
            plan.args,
            os_args(&[
                "-a",
                "/Applications/Visual Studio Code.app",
                "/work/my project/a b.ts"
            ])
        );
    }

    #[test]
    fn mac_bundle_with_line_uses_the_bundled_launcher() {
        let launcher = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
        let editor = mac_editor(
            "vscode",
            "/Applications/Visual Studio Code.app",
            Some(launcher),
        );
        let plan = build_launch_plan(&editor, Path::new("/w/a.ts"), false, at(12, Some(3)));
        assert_eq!(plan.program, PathBuf::from(launcher));
        assert_eq!(plan.args, os_args(&["--goto", "/w/a.ts:12:3"]));
    }

    #[test]
    fn mac_jetbrains_line_goes_through_open_args() {
        let editor = mac_editor("intellij-idea", "/Applications/IntelliJ IDEA.app", None);
        let plan = build_launch_plan(&editor, Path::new("/w/A.java"), false, at(7, None));
        assert_eq!(plan.program, PathBuf::from("/usr/bin/open"));
        assert_eq!(
            plan.args,
            os_args(&[
                "-na",
                "/Applications/IntelliJ IDEA.app",
                "--args",
                "--line",
                "7",
                "/w/A.java"
            ])
        );
    }

    #[test]
    fn xcode_uses_xed_for_lines_and_drops_unsupported_columns() {
        let editor = mac_editor("xcode", "/Applications/Xcode.app", Some("/usr/bin/xed"));
        let plan = build_launch_plan(&editor, Path::new("/w/main.swift"), false, at(4, Some(9)));
        assert_eq!(plan.program, PathBuf::from("/usr/bin/xed"));
        assert_eq!(plan.args, os_args(&["--line", "4", "/w/main.swift"]));

        let without_xed = mac_editor("xcode", "/Applications/Xcode.app", None);
        let plan = build_launch_plan(&without_xed, Path::new("/w/main.swift"), false, at(4, None));
        assert_eq!(plan.program, PathBuf::from("/usr/bin/open"));
        assert_eq!(
            plan.args,
            os_args(&["-a", "/Applications/Xcode.app", "/w/main.swift"])
        );
    }

    #[test]
    fn executable_line_arguments_follow_each_family() {
        let target = Path::new("/w/src/lib.rs");
        let cases: [(&str, &str, Vec<OsString>); 4] = [
            (
                "cursor",
                "/usr/bin/cursor",
                os_args(&["--goto", "/w/src/lib.rs:5:2"]),
            ),
            ("zed", "/usr/bin/zed", os_args(&["/w/src/lib.rs:5:2"])),
            ("sublime", "/usr/bin/subl", os_args(&["/w/src/lib.rs:5:2"])),
            (
                "rustrover",
                "/usr/bin/rustrover",
                os_args(&["--line", "5", "--column", "2", "/w/src/lib.rs"]),
            ),
        ];
        for (id, program, expected) in cases {
            let plan = build_launch_plan(&exe_editor(id, program), target, false, at(5, Some(2)));
            assert_eq!(plan.program, PathBuf::from(program), "{id}");
            assert_eq!(plan.args, expected, "{id}");
        }
    }

    #[test]
    fn folders_and_zero_lines_open_without_location() {
        let editor = exe_editor("vscode", "/usr/bin/code");
        let folder = build_launch_plan(&editor, Path::new("/w"), true, at(10, Some(1)));
        assert_eq!(folder.args, os_args(&["/w"]));
        let zero = build_launch_plan(&editor, Path::new("/w/a.ts"), false, at(0, Some(4)));
        assert_eq!(zero.args, os_args(&["/w/a.ts"]));
        let no_column = build_launch_plan(&editor, Path::new("/w/a.ts"), false, at(3, Some(0)));
        assert_eq!(no_column.args, os_args(&["--goto", "/w/a.ts:3"]));
    }

    #[test]
    fn hostile_file_names_stay_single_arguments() {
        let editor = exe_editor("sublime", "/usr/bin/subl");
        let target = Path::new("/w/$(touch pwned); rm -rf ~ `x`.txt");
        let plan = build_launch_plan(&editor, target, false, EditorLocation::default());
        assert_eq!(plan.args, vec![target.as_os_str().to_os_string()]);
    }

    #[test]
    fn open_path_rejects_unknown_editor_ids_before_touching_the_host() {
        let error = editor_open_path_sync("not-an-editor", "/nonexistent", "", Default::default())
            .expect_err("unknown editor");
        assert!(error.message.contains("Unknown editor"));
    }

    #[test]
    fn open_path_rejects_paths_escaping_the_workspace() {
        let dir = tempfile::tempdir().expect("tempdir");
        let error = editor_open_path_sync(
            "vscode",
            &dir.path().to_string_lossy(),
            "../outside.txt",
            Default::default(),
        )
        .expect_err("escaping path");
        assert!(matches!(
            error.code,
            crate::commands::fs::FsErrorCode::InvalidPath
        ));
    }
}
