//! Per-workdir watcher: a recursive `notify` watcher whose raw events are
//! debounced (250ms window) and classified into workspace activity, with a 2s
//! mtime-sampling fallback when the native watcher cannot be created.
//!
//! The git review panel reviews the repository *containing* the workdir, which
//! is not necessarily rooted at it (monorepo subfolder opened as a workspace,
//! linked worktree with a `.git` file). The repository's bookkeeping (index,
//! HEAD, refs) then lives outside the watched subtree, so each watcher also
//! attaches to those external git metadata directories; their events raise the
//! git flag only (see `ActivityBatch::absorb`).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Weak};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::WorkspaceWatchService;

const DEBOUNCE_WINDOW: Duration = Duration::from_millis(250);
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const POLL_STOP_CHECK: Duration = Duration::from_millis(250);
const MAX_CHANGED_PATHS: usize = 64;

/// Keeps one workdir watch alive. Dropping the handle stops it: the native
/// watcher teardown disconnects the aggregator channel, and the polling
/// fallback observes the stop flag.
pub(super) struct WorkdirWatcherHandle {
    _watcher: Option<RecommendedWatcher>,
    stop: Arc<AtomicBool>,
}

impl Drop for WorkdirWatcherHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub(super) fn spawn_workdir_watcher(
    workdir: String,
    service: Weak<WorkspaceWatchService>,
) -> WorkdirWatcherHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();
    let topology = resolve_git_meta_topology(Path::new(&workdir));

    let watcher = RecommendedWatcher::new(tx, Config::default()).and_then(|mut watcher| {
        watcher
            .watch(Path::new(&workdir), RecursiveMode::Recursive)
            .map(|_| watcher)
    });

    match watcher {
        Ok(mut watcher) => {
            // Best-effort extra watches on git metadata living outside the
            // workdir subtree (monorepo subfolder / linked worktree); failing
            // to attach one must not take down the workdir watch itself.
            for root in &topology.watch_roots {
                if let Err(error) = watcher.watch(root, RecursiveMode::Recursive) {
                    eprintln!(
                        "workspace watcher: external git dir {} not watched: {error}",
                        root.display()
                    );
                }
            }
            let thread_workdir = workdir.clone();
            let spawned = thread::Builder::new()
                .name("workspace-watch".to_string())
                .spawn(move || run_aggregator(thread_workdir, topology, rx, service));
            if let Err(error) = spawned {
                eprintln!("spawn workspace watch aggregator for {workdir} failed: {error}");
            }
            WorkdirWatcherHandle {
                _watcher: Some(watcher),
                stop,
            }
        }
        Err(error) => {
            eprintln!(
                "workspace watcher for {workdir} failed ({error}); falling back to 2s sampling"
            );
            let poll_stop = Arc::clone(&stop);
            let git_dir = topology.git_dir;
            let spawned = thread::Builder::new()
                .name("workspace-watch-poll".to_string())
                .spawn(move || run_poll_fallback(workdir, git_dir, poll_stop, service));
            if let Err(error) = spawned {
                eprintln!("spawn workspace watch poll fallback failed: {error}");
            }
            WorkdirWatcherHandle {
                _watcher: None,
                stop,
            }
        }
    }
}

// ---- repository geometry ----

/// Where the git metadata for a workdir lives. Resolved once per watcher
/// spawn from pure filesystem probes (no git subprocess: `set_desired` runs on
/// command handlers and must not block on a child process).
pub(super) struct GitMetaTopology {
    /// Git metadata directories outside the workdir subtree that need their
    /// own recursive watch (deduped, none nested inside another).
    pub(super) watch_roots: Vec<PathBuf>,
    /// Prefixes used to classify out-of-subtree event paths, longest first so
    /// a linked worktree's gitdir wins over the commondir that contains it.
    /// Includes canonicalized alternates (FSEvents may report resolved paths).
    pub(super) class_roots: Vec<PathBuf>,
    /// Resolved gitdir holding this worktree's HEAD/index; defaults to
    /// `<workdir>/.git` when the workdir is not inside a repository.
    pub(super) git_dir: PathBuf,
}

pub(super) fn resolve_git_meta_topology(workdir: &Path) -> GitMetaTopology {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut git_dir = workdir.join(".git");
    if let Some(dot_git) = find_nearest_dot_git(workdir) {
        if dot_git.is_dir() {
            git_dir = dot_git.clone();
            roots.push(dot_git);
        } else if let Some(resolved) = resolve_gitdir_file(&dot_git) {
            // `.git` file (linked worktree / submodule): the gitdir holds the
            // per-worktree HEAD/index, the commondir the shared refs.
            if let Some(common) = resolve_commondir(&resolved) {
                roots.push(common);
            }
            git_dir = resolved.clone();
            roots.push(resolved);
        }
    }

    let mut class_roots: Vec<PathBuf> = Vec::new();
    for root in &roots {
        if !class_roots.contains(root) {
            class_roots.push(root.clone());
        }
        if let Ok(canonical) = std::fs::canonicalize(root) {
            if !class_roots.contains(&canonical) {
                class_roots.push(canonical);
            }
        }
    }
    class_roots.sort_by_key(|root| std::cmp::Reverse(root.as_os_str().len()));

    let canonical_workdir = std::fs::canonicalize(workdir).ok();
    let covered_by_workdir = |root: &Path| {
        root.starts_with(workdir)
            || canonical_workdir
                .as_deref()
                .is_some_and(|prefix| root.starts_with(prefix))
    };
    let mut watch_roots: Vec<PathBuf> = Vec::new();
    for root in roots {
        if covered_by_workdir(&root) {
            continue;
        }
        if watch_roots
            .iter()
            .any(|existing| root.starts_with(existing))
        {
            continue;
        }
        watch_roots.retain(|existing| !existing.starts_with(&root));
        watch_roots.push(root);
    }

    GitMetaTopology {
        watch_roots,
        class_roots,
        git_dir,
    }
}

/// Nearest `.git` entry (directory, or file for linked worktrees/submodules)
/// at the workdir or one of its ancestors. A plain filesystem approximation of
/// git's own repository discovery — good enough for deciding what to watch: a
/// false positive only costs a spurious extra watch.
fn find_nearest_dot_git(workdir: &Path) -> Option<PathBuf> {
    let mut current = Some(workdir);
    while let Some(dir) = current {
        let candidate = dir.join(".git");
        if candidate.exists() {
            return Some(candidate);
        }
        current = dir.parent();
    }
    None
}

/// Resolves a `.git` *file*'s `gitdir: <path>` pointer (relative paths are
/// anchored at the file's parent directory).
fn resolve_gitdir_file(dot_git_file: &Path) -> Option<PathBuf> {
    let content = std::fs::read_to_string(dot_git_file).ok()?;
    let target = content
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:"))?
        .trim();
    if target.is_empty() {
        return None;
    }
    let raw = Path::new(target);
    let resolved = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        dot_git_file.parent()?.join(raw)
    };
    Some(std::fs::canonicalize(&resolved).unwrap_or(resolved))
}

/// Resolves a gitdir's `commondir` pointer (relative paths are anchored at the
/// gitdir). Absent for a primary worktree's gitdir.
fn resolve_commondir(git_dir: &Path) -> Option<PathBuf> {
    let content = std::fs::read_to_string(git_dir.join("commondir")).ok()?;
    let target = content.trim();
    if target.is_empty() {
        return None;
    }
    let raw = Path::new(target);
    let resolved = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        git_dir.join(raw)
    };
    Some(std::fs::canonicalize(&resolved).unwrap_or(resolved))
}

// ---- notify event aggregation ----

/// Everything `absorb` needs to attribute an event path: the workdir prefix
/// (raw and canonical) plus the external git metadata prefixes.
struct WatchScope {
    workdir: PathBuf,
    canonical_workdir: Option<PathBuf>,
    git_class_roots: Vec<PathBuf>,
}

#[derive(Default)]
struct ActivityBatch {
    fs: bool,
    git: bool,
    changed: BTreeSet<String>,
    truncated: bool,
}

impl ActivityBatch {
    fn is_empty(&self) -> bool {
        !self.fs && !self.git
    }

    fn note_path(&mut self, rel: String) {
        if self.changed.contains(&rel) {
            return;
        }
        if self.changed.len() >= MAX_CHANGED_PATHS {
            self.truncated = true;
            return;
        }
        self.changed.insert(rel);
    }

    fn absorb(&mut self, scope: &WatchScope, event: notify::Result<Event>) {
        let event = match event {
            Ok(event) => event,
            Err(_) => {
                // Watcher-reported error (e.g. queue overflow): events may have
                // been lost, so the whole workdir must be considered dirty.
                self.fs = true;
                self.git = true;
                self.truncated = true;
                return;
            }
        };
        // Pure access notifications carry no state change.
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        for path in &event.paths {
            match relativize(&scope.workdir, scope.canonical_workdir.as_deref(), path) {
                Some(rel) => match classify_rel_path(&rel) {
                    PathClass::Worktree => {
                        self.fs = true;
                        self.git = true;
                        self.note_path(rel);
                    }
                    PathClass::GitMeta => {
                        self.git = true;
                        self.note_path(rel);
                    }
                    PathClass::Ignored => {}
                },
                None => match classify_external_git_path(&scope.git_class_roots, path) {
                    // Bookkeeping of the repository that contains this workdir
                    // (or of a linked worktree's gitdir): affects git status
                    // only. The path cannot be expressed workdir-relative and
                    // the file tree ignores fs=false batches, so only the git
                    // flag is raised and no changed path is recorded.
                    Some(PathClass::GitMeta) => self.git = true,
                    Some(_) => {}
                    None => {
                        // Cannot attribute the path: err on the dirty side.
                        self.fs = true;
                        self.git = true;
                        self.truncated = true;
                    }
                },
            }
        }
    }
}

fn run_aggregator(
    workdir: String,
    topology: GitMetaTopology,
    rx: Receiver<notify::Result<Event>>,
    service: Weak<WorkspaceWatchService>,
) {
    let workdir_path = PathBuf::from(&workdir);
    // Some backends (e.g. FSEvents behind a symlinked prefix) report resolved
    // paths; keep the canonical form as an alternate strip prefix.
    let canonical = std::fs::canonicalize(&workdir_path).ok();
    let canonical = canonical.filter(|resolved| resolved != &workdir_path);
    let scope = WatchScope {
        workdir: workdir_path,
        canonical_workdir: canonical,
        git_class_roots: topology.class_roots,
    };

    loop {
        // Block for the first event of a burst, then keep absorbing until the
        // debounce window closes.
        let first = match rx.recv() {
            Ok(event) => event,
            Err(_) => return,
        };
        let mut batch = ActivityBatch::default();
        batch.absorb(&scope, first);
        let window_end = Instant::now() + DEBOUNCE_WINDOW;
        let mut disconnected = false;
        loop {
            let now = Instant::now();
            if now >= window_end {
                break;
            }
            match rx.recv_timeout(window_end - now) {
                Ok(event) => batch.absorb(&scope, event),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }
        if !flush_batch(&service, &workdir, batch) || disconnected {
            return;
        }
    }
}

/// Emits a non-empty batch. Returns false when the service is gone and the
/// aggregator should stop.
fn flush_batch(service: &Weak<WorkspaceWatchService>, workdir: &str, batch: ActivityBatch) -> bool {
    if batch.is_empty() {
        return true;
    }
    let Some(service) = service.upgrade() else {
        return false;
    };
    service.emit_activity(
        workdir,
        batch.fs,
        batch.git,
        batch.changed.into_iter().collect(),
        batch.truncated,
    );
    true
}

fn relativize(workdir: &Path, canonical_workdir: Option<&Path>, path: &Path) -> Option<String> {
    let rel = path
        .strip_prefix(workdir)
        .ok()
        .or_else(|| canonical_workdir.and_then(|prefix| path.strip_prefix(prefix).ok()))?;
    let rel = rel.to_string_lossy().replace('\\', "/");
    if rel.is_empty() {
        return None;
    }
    Some(rel)
}

pub(super) enum PathClass {
    /// Working-tree change: invalidates both file views and git status.
    Worktree,
    /// Git bookkeeping change (HEAD, refs, index, ...): invalidates git only.
    GitMeta,
    /// Git internals (objects, locks, ...): dropped.
    Ignored,
}

pub(super) fn classify_rel_path(rel: &str) -> PathClass {
    let Some(inner) = rel.strip_prefix(".git/") else {
        if rel == ".git" {
            return PathClass::Ignored;
        }
        return PathClass::Worktree;
    };
    if is_git_meta_inner(inner) {
        PathClass::GitMeta
    } else {
        PathClass::Ignored
    }
}

/// Paths inside a git directory whose change affects `git status` output.
fn is_git_meta_inner(inner: &str) -> bool {
    const GIT_META_FILES: &[&str] = &[
        "HEAD",
        "index",
        "packed-refs",
        "MERGE_HEAD",
        "ORIG_HEAD",
        "COMMIT_EDITMSG",
    ];
    GIT_META_FILES.contains(&inner) || inner == "refs" || inner.starts_with("refs/")
}

/// Classifies an absolute event path against the out-of-subtree git metadata
/// roots (longest prefix first). Returns None when the path belongs to none of
/// them; the roots themselves and their non-meta contents are Ignored.
pub(super) fn classify_external_git_path(
    class_roots: &[PathBuf],
    path: &Path,
) -> Option<PathClass> {
    for root in class_roots {
        let Ok(inner) = path.strip_prefix(root) else {
            continue;
        };
        let inner = inner.to_string_lossy().replace('\\', "/");
        if !inner.is_empty() && is_git_meta_inner(&inner) {
            return Some(PathClass::GitMeta);
        }
        return Some(PathClass::Ignored);
    }
    None
}

// ---- polling fallback ----

#[derive(PartialEq, Eq)]
struct PollSample {
    workdir_mtime: Option<SystemTime>,
    head_mtime: Option<SystemTime>,
    index_mtime: Option<SystemTime>,
}

fn sample_workdir(workdir: &Path, git_dir: &Path) -> PollSample {
    PollSample {
        workdir_mtime: mtime_of(workdir),
        head_mtime: mtime_of(&git_dir.join("HEAD")),
        index_mtime: mtime_of(&git_dir.join("index")),
    }
}

fn mtime_of(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
}

fn run_poll_fallback(
    workdir: String,
    git_dir: PathBuf,
    stop: Arc<AtomicBool>,
    service: Weak<WorkspaceWatchService>,
) {
    let workdir_path = PathBuf::from(&workdir);
    let mut last = sample_workdir(&workdir_path, &git_dir);
    loop {
        // Sleep the poll interval in short slices so a dropped handle stops
        // the thread promptly.
        let interval_end = Instant::now() + POLL_INTERVAL;
        while Instant::now() < interval_end {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            thread::sleep(POLL_STOP_CHECK);
        }
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let Some(service) = service.upgrade() else {
            return;
        };

        let current = sample_workdir(&workdir_path, &git_dir);
        if current == last {
            continue;
        }
        let fs_changed = current.workdir_mtime != last.workdir_mtime;
        let head_changed = current.head_mtime != last.head_mtime;
        let index_changed = current.index_mtime != last.index_mtime;
        let mut changed_paths = Vec::new();
        if head_changed {
            changed_paths.push(".git/HEAD".to_string());
        }
        if index_changed {
            changed_paths.push(".git/index".to_string());
        }
        service.emit_activity(
            &workdir,
            fs_changed,
            fs_changed || head_changed || index_changed,
            changed_paths,
            // Sampling cannot enumerate worktree paths.
            fs_changed,
        );
        last = current;
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{
        classify_external_git_path, classify_rel_path, resolve_git_meta_topology, PathClass,
    };

    #[test]
    fn classify_rel_path_routes_worktree_git_meta_and_ignored() {
        for rel in ["src/main.rs", "README.md", "a/b/c.txt", ".gitignore"] {
            assert!(
                matches!(classify_rel_path(rel), PathClass::Worktree),
                "{rel}"
            );
        }
        for rel in [
            ".git/HEAD",
            ".git/index",
            ".git/packed-refs",
            ".git/MERGE_HEAD",
            ".git/ORIG_HEAD",
            ".git/COMMIT_EDITMSG",
            ".git/refs",
            ".git/refs/heads/main",
            ".git/refs/remotes/origin/main",
        ] {
            assert!(
                matches!(classify_rel_path(rel), PathClass::GitMeta),
                "{rel}"
            );
        }
        for rel in [
            ".git",
            ".git/objects/ab/cdef",
            ".git/index.lock",
            ".git/HEAD.lock",
            ".git/FETCH_HEAD",
            ".git/logs/HEAD",
            ".git/refs-backup/x",
        ] {
            assert!(
                matches!(classify_rel_path(rel), PathClass::Ignored),
                "{rel}"
            );
        }
    }

    #[test]
    fn classify_external_git_path_prefers_longest_root_and_meta_rules() {
        // Linked-worktree layout: the per-worktree gitdir nests inside the
        // shared commondir; longest-first ordering must attribute its files
        // to the gitdir, not as `worktrees/...` junk under the commondir.
        let roots = vec![
            PathBuf::from("/main/.git/worktrees/feat"),
            PathBuf::from("/main/.git"),
        ];
        for (path, expect_meta) in [
            ("/main/.git/worktrees/feat/index", true),
            ("/main/.git/worktrees/feat/HEAD", true),
            ("/main/.git/index", true),
            ("/main/.git/refs/heads/main", true),
            ("/main/.git/packed-refs", true),
            ("/main/.git/objects/ab/cdef", false),
            ("/main/.git/worktrees/feat/index.lock", false),
            ("/main/.git", false),
        ] {
            let class = classify_external_git_path(&roots, Path::new(path));
            match class {
                Some(PathClass::GitMeta) => assert!(expect_meta, "{path}"),
                Some(PathClass::Ignored) => assert!(!expect_meta, "{path}"),
                other => panic!("{path}: unexpected class {:?}", other.is_some()),
            }
        }
        assert!(classify_external_git_path(&roots, Path::new("/elsewhere/file.rs")).is_none());
    }

    #[test]
    fn topology_for_plain_repo_root_needs_no_external_watch() {
        let temp = tempfile::tempdir().expect("temp dir");
        let workdir = temp.path().join("repo");
        std::fs::create_dir_all(workdir.join(".git")).expect("create .git");
        let topology = resolve_git_meta_topology(&workdir);
        assert!(topology.watch_roots.is_empty());
        assert_eq!(topology.git_dir, workdir.join(".git"));
    }

    #[test]
    fn topology_for_subfolder_workspace_watches_ancestor_git_dir() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("repo");
        let workdir = root.join("packages").join("app");
        std::fs::create_dir_all(root.join(".git")).expect("create .git");
        std::fs::create_dir_all(&workdir).expect("create workdir");
        let topology = resolve_git_meta_topology(&workdir);
        assert_eq!(topology.watch_roots, vec![root.join(".git")]);
        assert_eq!(topology.git_dir, root.join(".git"));
        assert!(topology.class_roots.contains(&root.join(".git")));
    }

    #[test]
    fn topology_for_linked_worktree_watches_commondir_and_classifies_gitdir_first() {
        let temp = tempfile::tempdir().expect("temp dir");
        let common = temp.path().join("main").join(".git");
        let git_dir = common.join("worktrees").join("feat");
        let workdir = temp.path().join("feat-worktree");
        std::fs::create_dir_all(&git_dir).expect("create gitdir");
        std::fs::create_dir_all(&workdir).expect("create workdir");
        std::fs::write(
            workdir.join(".git"),
            format!("gitdir: {}\n", git_dir.display()),
        )
        .expect("write .git file");
        std::fs::write(git_dir.join("commondir"), "../..\n").expect("write commondir");

        let topology = resolve_git_meta_topology(&workdir);
        // Canonicalize expectations: the resolver canonicalizes targets (macOS
        // tempdirs live behind the /private symlink).
        let canonical_git_dir = std::fs::canonicalize(&git_dir).expect("canonical gitdir");
        let canonical_common = std::fs::canonicalize(&common).expect("canonical commondir");
        assert_eq!(topology.git_dir, canonical_git_dir);
        // The gitdir nests inside the commondir, so one watch covers both.
        assert_eq!(topology.watch_roots, vec![canonical_common.clone()]);
        // Classification still knows the finer gitdir prefix, ordered first.
        let gitdir_pos = topology
            .class_roots
            .iter()
            .position(|root| root == &canonical_git_dir)
            .expect("gitdir in class roots");
        let common_pos = topology
            .class_roots
            .iter()
            .position(|root| root == &canonical_common)
            .expect("commondir in class roots");
        assert!(gitdir_pos < common_pos);
        assert!(matches!(
            classify_external_git_path(&topology.class_roots, &canonical_git_dir.join("index")),
            Some(PathClass::GitMeta)
        ));
    }
}
