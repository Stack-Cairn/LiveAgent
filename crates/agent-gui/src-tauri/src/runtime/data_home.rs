//! Explicit developer home for isolated native acceptance. Normal installations
//! keep the OS home. An invalid explicit override fails closed instead of using
//! personal data; release binaries do not accept the developer override.
use std::ffi::OsString;
use std::path::PathBuf;

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

#[cfg(test)]
mod tests {
    use super::*;

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
