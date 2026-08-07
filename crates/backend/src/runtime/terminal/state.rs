use portable_pty::{Child, MasterPty};
use russh::client;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use crate::commands::settings::{
    RuntimeSshHostConfig, RuntimeSshKnownHostKey, RuntimeSshKnownHostStatus,
};

use super::*;

#[derive(Debug, Clone, Copy)]
pub(crate) struct TerminalSize {
    pub(crate) cols: u16,
    pub(crate) rows: u16,
}

pub(crate) struct TerminalSessionEntry {
    pub(crate) backend: TerminalSessionBackend,
    pub(crate) record: Mutex<TerminalSessionRecord>,
    pub(crate) output: Mutex<TerminalOutputBuffer>,
}

pub(crate) enum TerminalSessionBackend {
    Local {
        master: Mutex<Box<dyn MasterPty + Send>>,
        input_tx: mpsc::SyncSender<Vec<u8>>,
        child: Mutex<Box<dyn Child + Send + Sync>>,
    },
    Ssh {
        runtime: Arc<SshSessionRuntime>,
    },
}

pub(crate) struct SshSessionRuntime {
    // Arc so short-lived channel opens can clone the handle and release the
    // mutex before awaiting dials (forwards/exec/SFTP).
    pub(crate) handle: tokio::sync::Mutex<Option<Arc<client::Handle<LiveAgentSshClient>>>>,
    pub(crate) input_tx: Mutex<Option<tokio::sync::mpsc::Sender<SshSessionInput>>>,
    pub(crate) shutdown_tx: Mutex<Option<tokio::sync::mpsc::Sender<()>>>,
    pub(crate) connection_id: AtomicUsize,
    pub(crate) closing: AtomicBool,
    pub(crate) reconnect_runner_active: AtomicBool,
}

impl SshSessionRuntime {
    pub(crate) fn new() -> Self {
        Self {
            handle: tokio::sync::Mutex::new(None),
            input_tx: Mutex::new(None),
            shutdown_tx: Mutex::new(None),
            connection_id: AtomicUsize::new(0),
            closing: AtomicBool::new(false),
            reconnect_runner_active: AtomicBool::new(false),
        }
    }

    pub(crate) async fn install_connection(
        &self,
        handle: client::Handle<LiveAgentSshClient>,
        input_tx: tokio::sync::mpsc::Sender<SshSessionInput>,
        shutdown_tx: tokio::sync::mpsc::Sender<()>,
    ) -> usize {
        let connection_id = self.connection_id.fetch_add(1, Ordering::SeqCst) + 1;
        *self.handle.lock().await = Some(Arc::new(handle));
        if let Ok(mut slot) = self.input_tx.lock() {
            *slot = Some(input_tx);
        }
        if let Ok(mut slot) = self.shutdown_tx.lock() {
            *slot = Some(shutdown_tx);
        }
        connection_id
    }

    pub(crate) async fn clear_connection_if_current(&self, connection_id: usize) {
        if self.connection_id.load(Ordering::SeqCst) != connection_id {
            return;
        }
        *self.handle.lock().await = None;
        if let Ok(mut slot) = self.input_tx.lock() {
            *slot = None;
        }
        if let Ok(mut slot) = self.shutdown_tx.lock() {
            *slot = None;
        }
    }

    pub(crate) async fn current_handle(&self) -> Option<Arc<client::Handle<LiveAgentSshClient>>> {
        self.handle.lock().await.as_ref().map(Arc::clone)
    }

    pub(crate) fn input_sender(&self) -> Option<tokio::sync::mpsc::Sender<SshSessionInput>> {
        self.input_tx.lock().ok().and_then(|slot| slot.clone())
    }

    pub(crate) fn shutdown_sender(&self) -> Option<tokio::sync::mpsc::Sender<()>> {
        self.shutdown_tx.lock().ok().and_then(|slot| slot.clone())
    }

    pub(crate) fn close(&self) -> Option<tokio::sync::mpsc::Sender<()>> {
        self.closing.store(true, Ordering::SeqCst);
        self.shutdown_sender()
    }

    pub(crate) fn is_closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }

    pub(crate) fn current_connection_id(&self) -> usize {
        self.connection_id.load(Ordering::SeqCst)
    }

    pub(crate) fn begin_reconnect_runner(&self) -> bool {
        !self.reconnect_runner_active.swap(true, Ordering::SeqCst)
    }

    pub(crate) fn finish_reconnect_runner(&self) {
        self.reconnect_runner_active.store(false, Ordering::SeqCst);
    }
}

pub(crate) enum SshSessionInput {
    Data(Vec<u8>),
    Resize(u32, u32),
}

pub(crate) enum SshSessionIoEndReason {
    Shutdown,
    InputClosed,
    WriteFailed,
    RemoteClosed,
    RemoteExitStatus(u32),
    RemoteExitSignal(String),
    ConnectionLost,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingSshConnectRequest {
    pub(crate) cwd: String,
    pub(crate) project_path_key: String,
    pub(crate) ssh_host_id: String,
    pub(crate) title: Option<String>,
    pub(crate) cols: Option<u16>,
    pub(crate) rows: Option<u16>,
    pub(crate) sftp_enabled: bool,
}

// 连接流程里同一时刻至多一个挂起提示，Box 化只会把 match 点全部改成解引用。
#[allow(clippy::large_enum_variant)]
pub(crate) enum PendingSshPrompt {
    HostKey {
        request: PendingSshConnectRequest,
        host_key: RuntimeSshKnownHostKey,
    },
    KeyboardInteractive {
        request: PendingSshConnectRequest,
        host_config: RuntimeSshHostConfig,
        title: String,
        size: TerminalSize,
        handle: client::Handle<LiveAgentSshClient>,
        answer_mode: SshPromptAnswerMode,
    },
}

/// How the answer to an interactive SSH prompt must be submitted: as a
/// keyboard-interactive INFO_RESPONSE, or as a plain password auth request
/// (fallback for servers that reject the keyboard-interactive method).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SshPromptAnswerMode {
    KeyboardInteractive,
    Password,
}

#[derive(Debug, Clone)]
pub(crate) struct KeyboardInteractivePromptData {
    pub(crate) name: String,
    pub(crate) instructions: String,
    pub(crate) prompt: String,
    pub(crate) echo: bool,
    pub(crate) answer_mode: SshPromptAnswerMode,
}

pub(crate) enum SshAuthOutcome {
    Authenticated,
    KeyboardInteractivePrompt(KeyboardInteractivePromptData),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PasswordKbiPromptAction {
    RespondEmpty,
    SendPassword,
    PromptUser,
}

#[derive(Debug, Clone)]
pub(crate) struct CapturedHostKey {
    pub(crate) key: RuntimeSshKnownHostKey,
    pub(crate) status: RuntimeSshKnownHostStatus,
}

#[derive(Debug, Default)]
pub(crate) struct TerminalOutputDispatch {
    pub(crate) local: Vec<TerminalStreamEventPayload>,
    pub(crate) remote: Vec<TerminalStreamEventPayload>,
}

#[derive(Debug, Default)]
pub(crate) struct SshTerminalTabsState {
    pub(crate) tabs: Vec<SshTerminalTabRecord>,
    pub(crate) revision: u64,
}
