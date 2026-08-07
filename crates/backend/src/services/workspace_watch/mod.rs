//! Workspace activity watch service: watches workdirs for filesystem / git
//! state changes and pushes debounced invalidation events to the event bus
//! (`workspace:activity`). Who consumes them — the desktop webview, the
//! gateway, a future HTTP backend — is not this module's business.
//!
//! Two declarative sources feed the desired watch set — the local frontend
//! (`workspace_watch_set`) and the gateway (`GatewayEnvelope{workspace_watch}`).
//! The actual watch set is their union; each `set_desired` call replaces one
//! source's set wholesale and reconciles watchers against the new union.

mod emit;
mod watcher;

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use crate::events::EventBus;

pub const WORKSPACE_ACTIVITY_EVENT: &str = "workspace:activity";

/// Who declared interest in a workdir. The two sets are independent: dropping
/// one source's workdirs never disturbs the other's watchers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchSource {
    Local,
    Gateway,
}

#[derive(Default)]
struct WatchInner {
    local: BTreeSet<String>,
    gateway: BTreeSet<String>,
    watchers: HashMap<String, watcher::WorkdirWatcherHandle>,
}

pub struct WorkspaceWatchService {
    events: Arc<EventBus>,
    inner: Mutex<WatchInner>,
    // Per-workdir monotonic revision counters. Kept outside WatchInner so they
    // survive watcher teardown/recreation: a re-watched workdir must not
    // restart at 1 (clients treat revision regressions as forced-dirty).
    revisions: Mutex<HashMap<String, u64>>,
}

impl WorkspaceWatchService {
    pub fn new(events: Arc<EventBus>) -> Self {
        Self {
            events,
            inner: Mutex::new(WatchInner::default()),
            revisions: Mutex::new(HashMap::new()),
        }
    }

    /// Replaces one source's desired workdir set and reconciles watchers
    /// against the union of both sources.
    pub fn set_desired(self: &Arc<Self>, source: WatchSource, workdirs: Vec<String>) {
        let normalized: BTreeSet<String> = workdirs
            .into_iter()
            .map(|workdir| workdir.trim().to_string())
            .filter(|workdir| !workdir.is_empty())
            .collect();

        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        match source {
            WatchSource::Local => inner.local = normalized,
            WatchSource::Gateway => inner.gateway = normalized,
        }

        let desired: BTreeSet<String> = inner.local.union(&inner.gateway).cloned().collect();
        // Dropping a handle stops its watcher (native watcher teardown ends
        // the aggregator; the polling fallback observes the stop flag).
        inner
            .watchers
            .retain(|workdir, _| desired.contains(workdir));
        for workdir in desired {
            inner.watchers.entry(workdir.clone()).or_insert_with(move || {
                watcher::spawn_workdir_watcher(workdir, Arc::downgrade(self))
            });
        }
    }

    /// Gateway 兴趣集查询。Gateway 侧的 sink 用它决定要不要把某条活动事件转发出去——
    /// 兴趣集归本服务管（它本来就按 source 分开存），转发归 sink 管。
    pub fn workdir_in_gateway_set(&self, workdir: &str) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.gateway.contains(workdir))
            .unwrap_or(false)
    }

    /// Per-workdir monotonic revision. A poisoned lock yields 0, which clients
    /// already treat as a revision regression (forced dirty) — fail-safe.
    pub(crate) fn next_revision(&self, workdir: &str) -> u64 {
        let Ok(mut revisions) = self.revisions.lock() else {
            return 0;
        };
        let counter = revisions.entry(workdir.to_string()).or_insert(0);
        *counter += 1;
        *counter
    }
}
