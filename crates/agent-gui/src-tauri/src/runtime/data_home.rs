//! Explicit developer home for isolated native acceptance. Normal installations
//! keep the OS home. An invalid explicit override fails closed instead of using
//! personal data; release binaries do not accept the developer override.
//!
//! The data root (`~/.liveagent` by default) can be relocated from settings:
//! the chosen directory is recorded in a pointer file inside the default root
//! and resolved once per process, so a relocation takes effect after restart.
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub(crate) const DATA_DIR_NAME: &str = ".liveagent";
pub(crate) const POINTER_FILE_NAME: &str = "data-dir.json";

fn select_home(
    override_home: Option<OsString>,
    system_home: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    match override_home {
        Some(raw) => {
            let path = PathBuf::from(raw);
            path.is_absolute().then_some(path)
        }
        None => system_home(),
    }
}

pub(crate) fn isolation_requested() -> bool {
    cfg!(debug_assertions) && std::env::var_os("LIVEAGENT_DEV_HOME").is_some()
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    let explicit = std::env::var_os("LIVEAGENT_DEV_HOME");
    #[cfg(not(debug_assertions))]
    let explicit = None;
    select_home(explicit, dirs::home_dir)
}

/// Default data root: `<home>/.liveagent`. Holds the relocation pointer and the
/// entries that never move (browser extension, git worktrees).
pub(crate) fn default_data_root() -> Option<PathBuf> {
    home_dir().map(|home| home.join(DATA_DIR_NAME))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct DataDirPointer {
    path: PathBuf,
}

/// Reads the relocation pointer stored in `default_root`. Missing, unreadable or
/// non-absolute pointers resolve to `None` (the default root stays in use).
pub(crate) fn read_pointer(default_root: &Path) -> Option<PathBuf> {
    let raw = std::fs::read(default_root.join(POINTER_FILE_NAME)).ok()?;
    let pointer = match serde_json::from_slice::<DataDirPointer>(&raw) {
        Ok(pointer) => pointer,
        Err(error) => {
            eprintln!("ignoring invalid {POINTER_FILE_NAME}: {error}");
            return None;
        }
    };
    (pointer.path.is_absolute() && pointer.path != default_root).then_some(pointer.path)
}

/// Records `target` as the data root; `None` (or the default root itself)
/// removes the pointer. Written via a temp file + rename so a crash never
/// leaves a truncated pointer behind.
pub(crate) fn write_pointer(default_root: &Path, target: Option<&Path>) -> std::io::Result<()> {
    let path = default_root.join(POINTER_FILE_NAME);
    match target.filter(|target| *target != default_root) {
        None => match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        },
        Some(target) => {
            std::fs::create_dir_all(default_root)?;
            let body = serde_json::to_vec_pretty(&DataDirPointer {
                path: target.to_path_buf(),
            })
            .map_err(std::io::Error::other)?;
            let tmp = default_root.join(format!("{POINTER_FILE_NAME}.tmp"));
            std::fs::write(&tmp, body)?;
            std::fs::rename(&tmp, &path)
        }
    }
}

static DATA_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Effective data root for this process: the relocation pointer when present,
/// otherwise `<home>/.liveagent`. Cached so every subsystem agrees on one
/// location until the app restarts. Environment overrides
/// (`LIVEAGENT_CONFIG_DIR`, `LIVEAGENT_HOME`, `K_BRAIN_HOME`) are applied by
/// the individual callers and still take priority.
pub(crate) fn data_root() -> Option<PathBuf> {
    DATA_ROOT
        .get_or_init(|| {
            let default_root = default_data_root()?;
            Some(read_pointer(&default_root).unwrap_or(default_root))
        })
        .clone()
}

/// Environment variables that pin the data location and therefore disable
/// relocation from settings.
pub(crate) fn data_root_env_override() -> Option<&'static str> {
    ["LIVEAGENT_CONFIG_DIR", "LIVEAGENT_HOME", "K_BRAIN_HOME"]
        .into_iter()
        .find(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_round_trips_and_default_target_removes_it() {
        let temp = tempfile::tempdir().unwrap();
        let default_root = temp.path().join(".liveagent");
        assert_eq!(read_pointer(&default_root), None);

        let target = temp.path().join("elsewhere");
        write_pointer(&default_root, Some(&target)).unwrap();
        assert_eq!(read_pointer(&default_root), Some(target));

        write_pointer(&default_root, Some(&default_root)).unwrap();
        assert!(!default_root.join(POINTER_FILE_NAME).exists());
        write_pointer(&default_root, None).unwrap();
    }

    #[test]
    fn invalid_pointer_keeps_default_root() {
        let temp = tempfile::tempdir().unwrap();
        let default_root = temp.path().to_path_buf();
        for body in ["not json", r#"{"path":"relative/dir"}"#] {
            std::fs::write(default_root.join(POINTER_FILE_NAME), body).unwrap();
            assert_eq!(read_pointer(&default_root), None);
        }
    }

    #[test]
    fn isolated_home_never_resolves_personal_home() {
        let directory = std::env::temp_dir().join("liveagent-isolated-home-test");
        let selected = select_home(Some(directory.clone().into_os_string()), || {
            panic!("personal home lookup")
        });
        assert_eq!(selected, Some(directory));
    }

    #[test]
    fn invalid_override_does_not_fall_back_to_personal_data() {
        for raw in ["", "relative/home"] {
            assert_eq!(
                select_home(Some(OsString::from(raw)), || panic!("personal fallback")),
                None
            );
        }
    }

    #[test]
    fn ordinary_launch_retains_system_home() {
        let directory = std::env::temp_dir().join("normal-home-test");
        assert_eq!(
            select_home(None, || Some(directory.clone())),
            Some(directory)
        );
    }
}
