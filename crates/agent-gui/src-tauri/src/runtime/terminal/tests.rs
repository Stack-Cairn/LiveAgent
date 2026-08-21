use portable_pty::CommandBuilder;
use russh::client;
use russh::MethodKind;
use std::sync::{Arc, Mutex};

use crate::commands::settings::RuntimeSshHostConfig;
use crate::runtime::project_path::project_path_key as normalize_project_path_key;

use super::*;

#[test]
fn shell_options_include_default() {
    let options = terminal_shell_options();
    assert!(!options.default_shell.trim().is_empty());
    assert!(!options.options.is_empty());
}

#[test]
fn ssh_client_config_enables_interactive_keepalive() {
    let config = ssh_client_config();

    assert_eq!(config.keepalive_interval, Some(SSH_KEEPALIVE_INTERVAL));
    assert_eq!(config.keepalive_max, SSH_KEEPALIVE_MAX_MISSES);
    assert!(config.nodelay);
}

#[test]
fn output_tail_respects_byte_limit_inside_large_chunk() {
    let mut output = TerminalOutputBuffer::default();
    output.append(b"prefix".to_vec());
    output.append(b"abcdefghijklmnopqrstuvwxyz".to_vec());

    let tail = read_output_chunks_tail(&output, 8);

    assert_eq!(tail.output, b"stuvwxyz");
    assert_eq!(tail.output_start_offset, 24);
    assert_eq!(tail.output_end_offset, 32);
    assert!(tail.truncated);
}

#[test]
fn output_tail_keeps_offsets_for_repeated_text() {
    let mut output = TerminalOutputBuffer::default();
    output.append(b"uploads\n".to_vec());
    output.append(b"uploads\n".to_vec());

    let tail = read_output_chunks_tail(&output, MAX_TAIL_BYTES);

    assert_eq!(tail.output, b"uploads\nuploads\n");
    assert_eq!(tail.output_start_offset, 0);
    assert_eq!(tail.output_end_offset, 16);
    assert!(!tail.truncated);
}

#[test]
fn remote_input_echo_is_delayed_for_local_until_enter() {
    let mut state = TerminalEchoDispatchState::default();
    state
        .pending
        .extend(b"echo hi\r".iter().copied().map(|byte| PendingEchoByte {
            byte,
            origin: TerminalInputOrigin::Remote,
        }));

    let first = state.dispatch(test_stream_payload(0, b"echo"));
    assert_eq!(collect_payload_bytes(&first.remote), b"echo");
    assert!(first.local.is_empty());

    let second = state.dispatch(test_stream_payload(4, b" hi\r\n"));
    assert_eq!(collect_payload_bytes(&second.remote), b" hi\r\n");
    assert_eq!(collect_payload_bytes(&second.local), b"echo hi\r\n");
    assert!(state.is_empty());
}

#[test]
fn local_input_echo_is_delayed_for_remote_until_enter() {
    let mut state = TerminalEchoDispatchState::default();
    state
        .pending
        .extend(b"pwd\r".iter().copied().map(|byte| PendingEchoByte {
            byte,
            origin: TerminalInputOrigin::Local,
        }));

    let first = state.dispatch(test_stream_payload(10, b"pw"));
    assert_eq!(collect_payload_bytes(&first.local), b"pw");
    assert!(first.remote.is_empty());

    let second = state.dispatch(test_stream_payload(12, b"d\r\n"));
    assert_eq!(collect_payload_bytes(&second.local), b"d\r\n");
    assert_eq!(collect_payload_bytes(&second.remote), b"pwd\r\n");
    assert!(state.is_empty());
}

#[test]
fn no_echo_password_input_does_not_leak_to_other_side() {
    let mut state = TerminalEchoDispatchState::default();
    state
        .pending
        .extend(b"secret\r".iter().copied().map(|byte| PendingEchoByte {
            byte,
            origin: TerminalInputOrigin::Remote,
        }));

    let dispatch = state.dispatch(test_stream_payload(30, b"\r\n"));

    assert_eq!(collect_payload_bytes(&dispatch.local), b"\r\n");
    assert_eq!(collect_payload_bytes(&dispatch.remote), b"\r\n");
    assert!(state.is_empty());
}

#[test]
fn non_echo_output_stays_visible_to_both_sides() {
    let mut state = TerminalEchoDispatchState::default();
    state.pending.push_back(PendingEchoByte {
        byte: b'a',
        origin: TerminalInputOrigin::Remote,
    });

    let dispatch = state.dispatch(test_stream_payload(50, b"build\n"));

    assert_eq!(collect_payload_bytes(&dispatch.local), b"build\n");
    assert_eq!(collect_payload_bytes(&dispatch.remote), b"build\n");
    assert!(!state.is_empty());
}

#[test]
fn input_echo_candidates_skip_escape_sequences() {
    let candidates =
        terminal_input_echo_candidates(b"a\x1b[A\x1b[1;5Cb\r", TerminalInputOrigin::Remote);
    let bytes = candidates
        .iter()
        .map(|candidate| candidate.byte)
        .collect::<Vec<_>>();

    assert_eq!(bytes, b"ab\r");
}

#[test]
fn failed_input_enqueue_does_not_record_pending_echo() {
    let registry = TerminalSessionRegistry::default();
    insert_test_ssh_session(
        &registry,
        "ssh-1",
        "/tmp/project",
        true,
        SSH_STATUS_CONNECTED,
    );

    let result = registry.input_bytes_from_remote("ssh-1".to_string(), b"secret\r".to_vec());

    assert!(result.is_err());
    let states = registry
        .echo_dispatch
        .lock()
        .expect("terminal echo dispatch lock");
    assert!(!states.contains_key("ssh-1"));
}

fn insert_test_ssh_session(
    registry: &TerminalSessionRegistry,
    id: &str,
    project_path_key: &str,
    sftp_enabled: bool,
    status: &str,
) {
    let now = now_ms();
    let record = TerminalSessionRecord {
        id: id.to_string(),
        project_path_key: normalize_project_path_key(project_path_key),
        cwd: project_path_key.to_string(),
        shell: "ssh".to_string(),
        title: id.to_string(),
        kind: "ssh".to_string(),
        ssh: Some(TerminalSshMetadata {
            host_id: format!("host-{id}"),
            host_name: format!("Host {id}"),
            username: "tester".to_string(),
            host: "127.0.0.1".to_string(),
            port: 22,
            auth_type: "password".to_string(),
            status: status.to_string(),
            reconnect_attempt: 0,
            reconnect_max_attempts: SSH_RECONNECT_MAX_ATTEMPTS,
            sftp_enabled,
        }),
        pid: None,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        created_at: now,
        updated_at: now,
        finished_at: None,
        exit_code: None,
        running: status == SSH_STATUS_CONNECTED,
    };
    let entry = Arc::new(TerminalSessionEntry {
        backend: TerminalSessionBackend::Ssh {
            runtime: Arc::new(SshSessionRuntime::new()),
        },
        record: Mutex::new(record),
        output: Mutex::new(TerminalOutputBuffer::default()),
    });
    registry
        .sessions
        .lock()
        .expect("terminal session registry poisoned")
        .insert(id.to_string(), entry);
}

fn block_on_test<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build test runtime")
        .block_on(future)
}

#[test]
fn ssh_local_forward_rejects_disconnected_session() {
    let registry = Arc::new(TerminalSessionRegistry::default());
    insert_test_ssh_session(
        &registry,
        "ssh-forward",
        "/tmp/project",
        false,
        SSH_STATUS_DISCONNECTED,
    );

    let error = block_on_test(registry.ssh_local_forward_start(
        "ssh-forward".to_string(),
        Some("/tmp/project".to_string()),
        "127.0.0.1".to_string(),
        5432,
        Some(0),
    ))
    .unwrap_err();

    assert_eq!(error, "SSH connection is not connected");
}

#[test]
fn ssh_local_forward_session_close_removes_registered_forwards() {
    let registry = TerminalSessionRegistry::default();
    insert_test_ssh_session(
        &registry,
        "ssh-forward",
        "/tmp/project",
        false,
        SSH_STATUS_CONNECTED,
    );
    let record = SshLocalForwardRecord {
        id: "forward-1".to_string(),
        session_id: "ssh-forward".to_string(),
        project_path_key: normalize_project_path_key("/tmp/project"),
        local_host: "127.0.0.1".to_string(),
        local_port: 43210,
        address: "127.0.0.1:43210".to_string(),
        remote_host: "127.0.0.1".to_string(),
        remote_port: 5432,
        status: "active".to_string(),
        created_at: now_ms(),
        updated_at: now_ms(),
        error: None,
    };
    let mut cancel_rx = registry.insert_test_ssh_local_forward(record);

    registry.close("ssh-forward".to_string()).unwrap();

    assert!(registry
        .ssh_local_forward_list(None, None)
        .unwrap()
        .forwards
        .is_empty());
    assert!(*cancel_rx.borrow_and_update());
}

#[test]
fn ssh_local_forward_session_close_trims_session_id() {
    let registry = TerminalSessionRegistry::default();
    insert_test_ssh_session(
        &registry,
        "ssh-forward",
        "/tmp/project",
        false,
        SSH_STATUS_CONNECTED,
    );
    let record = SshLocalForwardRecord {
        id: "forward-padded".to_string(),
        session_id: "ssh-forward".to_string(),
        project_path_key: normalize_project_path_key("/tmp/project"),
        local_host: "127.0.0.1".to_string(),
        local_port: 43211,
        address: "127.0.0.1:43211".to_string(),
        remote_host: "127.0.0.1".to_string(),
        remote_port: 5432,
        status: "active".to_string(),
        created_at: now_ms(),
        updated_at: now_ms(),
        error: None,
    };
    let mut cancel_rx = registry.insert_test_ssh_local_forward(record);

    registry
        .close("  ssh-forward  ".to_string())
        .expect("padded session close should succeed");

    assert!(registry
        .ssh_local_forward_list(None, None)
        .unwrap()
        .forwards
        .is_empty());
    assert!(*cancel_rx.borrow_and_update());
}

fn test_ssh_runtime(registry: &TerminalSessionRegistry, id: &str) -> Arc<SshSessionRuntime> {
    let entry = registry.entry(id).expect("terminal session entry");
    let TerminalSessionBackend::Ssh { runtime } = &entry.backend else {
        panic!("expected ssh backend");
    };
    Arc::clone(runtime)
}

#[test]
fn ssh_reconnect_rejects_missing_session() {
    let registry = Arc::new(TerminalSessionRegistry::default());

    let result = block_on_test(registry.ssh_reconnect("missing".to_string()));

    assert!(result.is_err());
}

#[test]
fn ssh_reconnect_rejects_closing_session() {
    let registry = Arc::new(TerminalSessionRegistry::default());
    insert_test_ssh_session(
        &registry,
        "ssh-1",
        "/tmp/project",
        false,
        SSH_STATUS_CONNECTED,
    );
    test_ssh_runtime(&registry, "ssh-1").close();

    let result = block_on_test(registry.ssh_reconnect("ssh-1".to_string()));

    assert_eq!(result.unwrap_err(), "SSH session is closing");
}

#[test]
fn ssh_reconnect_rejects_concurrent_reconnect_runner() {
    let registry = Arc::new(TerminalSessionRegistry::default());
    insert_test_ssh_session(
        &registry,
        "ssh-1",
        "/tmp/project",
        false,
        SSH_STATUS_RECONNECTING,
    );
    let runtime = test_ssh_runtime(&registry, "ssh-1");
    assert!(runtime.begin_reconnect_runner());

    let result = block_on_test(registry.ssh_reconnect("ssh-1".to_string()));

    assert_eq!(result.unwrap_err(), "SSH reconnect already in progress");
    // The rejected call must not release the flag owned by the active runner.
    runtime.finish_reconnect_runner();
    assert!(runtime.begin_reconnect_runner());
}

fn test_stream_payload(start_offset: u64, bytes: &[u8]) -> TerminalStreamEventPayload {
    TerminalStreamEventPayload {
        kind: "output".to_string(),
        session_id: "terminal-1".to_string(),
        project_path_key: "/tmp/project".to_string(),
        start_offset,
        end_offset: start_offset + bytes.len() as u64,
        bytes: bytes.to_vec(),
    }
}

fn collect_payload_bytes(payloads: &[TerminalStreamEventPayload]) -> Vec<u8> {
    payloads
        .iter()
        .flat_map(|payload| payload.bytes.iter().copied())
        .collect()
}

#[test]
fn ssh_terminal_tab_open_is_idempotent_without_shared_active() {
    let registry = TerminalSessionRegistry::default();
    insert_test_ssh_session(
        &registry,
        "ssh-1",
        "/tmp/project",
        true,
        SSH_STATUS_CONNECTED,
    );

    let first = registry
        .ssh_terminal_tab_open("ssh-1".to_string(), "bash".to_string())
        .expect("open bash tab");
    let second = registry
        .ssh_terminal_tab_open("ssh-1".to_string(), "bash".to_string())
        .expect("reopen bash tab");
    let sftp = registry
        .ssh_terminal_tab_open("ssh-1".to_string(), "sftp".to_string())
        .expect("open sftp tab");

    assert_eq!(first.tabs.len(), 1);
    assert_eq!(second.tabs.len(), 1);
    assert_eq!(sftp.tabs.len(), 2);
    assert_eq!(first.revision, second.revision);
}

#[test]
fn ssh_terminal_tab_close_is_global_without_closing_session() {
    let registry = TerminalSessionRegistry::default();
    insert_test_ssh_session(
        &registry,
        "ssh-1",
        "/tmp/project",
        true,
        SSH_STATUS_CONNECTED,
    );
    insert_test_ssh_session(
        &registry,
        "ssh-2",
        "/tmp/project",
        true,
        SSH_STATUS_CONNECTED,
    );
    registry
        .ssh_terminal_tab_open("ssh-1".to_string(), "bash".to_string())
        .expect("open first tab");
    registry
        .ssh_terminal_tab_open("ssh-2".to_string(), "bash".to_string())
        .expect("open second tab");

    let snapshot = registry
        .ssh_terminal_tab_close("bash:ssh-1".to_string())
        .expect("close first tab");

    assert_eq!(snapshot.tabs.len(), 1);
    assert!(registry.session_record("ssh-1".to_string()).is_ok());
}

#[test]
fn ssh_terminal_tab_open_rejects_disabled_sftp() {
    let registry = TerminalSessionRegistry::default();
    insert_test_ssh_session(
        &registry,
        "ssh-1",
        "/tmp/project",
        false,
        SSH_STATUS_CONNECTED,
    );

    let error = registry
        .ssh_terminal_tab_open("ssh-1".to_string(), "sftp".to_string())
        .expect_err("sftp tab should be rejected");

    assert!(error.contains("SFTP is not enabled"));
}

#[test]
fn ssh_terminal_tabs_prune_when_session_closes() {
    let registry = TerminalSessionRegistry::default();
    insert_test_ssh_session(
        &registry,
        "ssh-1",
        "/tmp/project",
        true,
        SSH_STATUS_CONNECTED,
    );
    registry
        .ssh_terminal_tab_open("ssh-1".to_string(), "bash".to_string())
        .expect("open bash tab");
    registry
        .ssh_terminal_tab_open("ssh-1".to_string(), "sftp".to_string())
        .expect("open sftp tab");

    registry
        .close("ssh-1".to_string())
        .expect("close ssh session");
    let snapshot = registry
        .ssh_terminal_tabs_list("/tmp/project".to_string())
        .expect("list tabs");

    assert!(snapshot.tabs.is_empty());
}

#[test]
fn ssh_terminal_tabs_prune_when_ssh_disconnects() {
    let registry = TerminalSessionRegistry::default();
    insert_test_ssh_session(
        &registry,
        "ssh-1",
        "/tmp/project",
        true,
        SSH_STATUS_CONNECTED,
    );
    registry
        .ssh_terminal_tab_open("ssh-1".to_string(), "bash".to_string())
        .expect("open bash tab");
    registry
        .ssh_terminal_tab_open("ssh-1".to_string(), "sftp".to_string())
        .expect("open sftp tab");
    let entry = registry
        .sessions
        .lock()
        .expect("terminal session registry poisoned")
        .get("ssh-1")
        .cloned()
        .expect("ssh session entry");

    registry.mark_ssh_disconnected(&entry);

    let snapshot = registry
        .ssh_terminal_tabs_list("/tmp/project".to_string())
        .expect("list tabs");
    assert!(snapshot.tabs.is_empty());
    let error = registry
        .ssh_terminal_tab_open("ssh-1".to_string(), "bash".to_string())
        .expect_err("disconnected ssh tab should be rejected");
    assert!(error.contains("disconnected"));
}

#[test]
fn ssh_auth_result_detects_keyboard_interactive_continuation() {
    let mut methods = russh::MethodSet::empty();
    methods.push(MethodKind::KeyboardInteractive);
    assert!(auth_result_can_continue_with_kbi(
        &client::AuthResult::Failure {
            remaining_methods: methods,
            partial_success: false,
        }
    ));

    let mut password_only = russh::MethodSet::empty();
    password_only.push(MethodKind::Password);
    assert!(!auth_result_can_continue_with_kbi(
        &client::AuthResult::Failure {
            remaining_methods: password_only,
            partial_success: false,
        },
    ));
    assert!(!auth_result_can_continue_with_kbi(
        &client::AuthResult::Success
    ));
}

#[test]
fn ssh_password_kbi_prompt_classification_uses_saved_password_once() {
    let prompts = vec![client::Prompt {
        prompt: "Password:".to_string(),
        echo: false,
    }];
    assert_eq!(
        classify_password_kbi_prompts(&prompts, false),
        PasswordKbiPromptAction::SendPassword
    );
    assert_eq!(
        classify_password_kbi_prompts(&prompts, true),
        PasswordKbiPromptAction::PromptUser
    );
    assert_eq!(
        classify_password_kbi_prompts(&[], false),
        PasswordKbiPromptAction::RespondEmpty
    );
    assert_eq!(
        classify_password_kbi_prompts(
            &[client::Prompt {
                prompt: "OTP:".to_string(),
                echo: false,
            }],
            false,
        ),
        PasswordKbiPromptAction::PromptUser
    );
}

#[test]
fn ssh_keyboard_interactive_message_combines_server_fields() {
    let message = ssh_keyboard_interactive_message(&KeyboardInteractivePromptData {
        name: "Verification".to_string(),
        instructions: "Enter code".to_string(),
        prompt: "OTP:".to_string(),
        echo: false,
        answer_mode: SshPromptAnswerMode::KeyboardInteractive,
    });

    assert_eq!(message, "Verification\nEnter code\nOTP:");
}

#[test]
fn ssh_password_fallback_prompt_targets_password_auth() {
    let host = RuntimeSshHostConfig {
        id: "prod".to_string(),
        name: "Production".to_string(),
        host: "prod.example.com".to_string(),
        port: 22,
        username: "deploy".to_string(),
        auth_type: "keyboardInteractive".to_string(),
        password: String::new(),
        private_key: String::new(),
        private_key_path: String::new(),
        private_key_passphrase: String::new(),
        proxy: crate::commands::settings::RuntimeSshProxyConfig {
            proxy_type: String::new(),
            url: String::new(),
            port: 0,
            username: String::new(),
            password: String::new(),
            password_configured: false,
            use_system_proxy: false,
        },
    };

    let first = password_fallback_prompt_data(&host, false);
    assert_eq!(first.answer_mode, SshPromptAnswerMode::Password);
    assert!(!first.echo);
    assert_eq!(
        ssh_keyboard_interactive_message(&first),
        "deploy@prod.example.com's password:"
    );

    let retry = password_fallback_prompt_data(&host, true);
    assert_eq!(retry.answer_mode, SshPromptAnswerMode::Password);
    assert_eq!(
        ssh_keyboard_interactive_message(&retry),
        "Permission denied, please try again.\ndeploy@prod.example.com's password:"
    );
}

#[test]
fn ssh_identity_path_expands_windows_profile_without_posix_rewrites() {
    let env = |key: &str| match key {
        "USERPROFILE" => Some(r"C:\Users\Alice".to_string()),
        "HOMEDRIVE" => Some("C:".to_string()),
        "HOMEPATH" => Some(r"\Users\Alice".to_string()),
        _ => None,
    };

    assert_eq!(
        expand_ssh_identity_path_for_profile_with_env(
            r"C:\Users\Alice",
            r"~\.ssh\id_ed25519",
            SshPathProfile::Windows,
            env,
        ),
        r"C:\Users\Alice\.ssh\id_ed25519"
    );
    assert_eq!(
        expand_ssh_identity_path_for_profile_with_env(
            r"C:\Users\Alice",
            r"%USERPROFILE%\.ssh\id_rsa",
            SshPathProfile::Windows,
            env,
        ),
        r"C:\Users\Alice\.ssh\id_rsa"
    );
    assert_eq!(
        expand_ssh_identity_path_for_profile_with_env(
            r"C:\Users\Alice",
            r"%HOMEDRIVE%%HOMEPATH%\.ssh\id_rsa",
            SshPathProfile::Windows,
            env,
        ),
        r"C:\Users\Alice\.ssh\id_rsa"
    );
    assert_eq!(
        expand_ssh_identity_path_for_profile_with_env(
            r"C:\Users\Alice",
            r"C:Keys\id_rsa",
            SshPathProfile::Windows,
            env,
        ),
        r"C:\Users\Alice\C:Keys\id_rsa"
    );
    assert_eq!(
        expand_ssh_identity_path_for_profile_with_env(
            r"C:\Users\Alice",
            r"\\?\C:\Keys\id_rsa",
            SshPathProfile::Windows,
            env,
        ),
        r"\\?\C:\Keys\id_rsa"
    );
}

#[test]
fn ssh_identity_path_preserves_posix_backslash_semantics() {
    assert_eq!(
        expand_ssh_identity_path_for_profile(
            "/Users/alice",
            "~/keys/id_ed25519",
            SshPathProfile::Posix
        ),
        "/Users/alice/keys/id_ed25519"
    );
    assert_eq!(
        expand_ssh_identity_path_for_profile(
            "/Users/alice",
            "$HOME/.ssh/id_rsa",
            SshPathProfile::Posix
        ),
        "/Users/alice/.ssh/id_rsa"
    );
    assert_eq!(
        expand_ssh_identity_path_for_profile(
            "/Users/alice",
            "${HOME}/.ssh/id_rsa",
            SshPathProfile::Posix
        ),
        "/Users/alice/.ssh/id_rsa"
    );
    assert_eq!(
        expand_ssh_identity_path_for_profile("/Users/alice", r"dir\key", SshPathProfile::Posix),
        r"/Users/alice/dir\key"
    );
}

#[test]
fn ssh_proxy_parser_resolves_http_and_socks5_endpoints() {
    let mut host = RuntimeSshHostConfig {
        id: "prod".to_string(),
        name: "Production".to_string(),
        host: "prod.example.com".to_string(),
        port: 22,
        username: "deploy".to_string(),
        auth_type: "keyboardInteractive".to_string(),
        password: String::new(),
        private_key: String::new(),
        private_key_path: String::new(),
        private_key_passphrase: String::new(),
        proxy: crate::commands::settings::RuntimeSshProxyConfig {
            proxy_type: "socks5".to_string(),
            url: "socks5://127.0.0.1:1081".to_string(),
            port: 0,
            username: "proxy-user".to_string(),
            password: "proxy-pass".to_string(),
            password_configured: true,
            use_system_proxy: false,
        },
    };

    let proxy = resolve_ssh_proxy(&host).expect("resolve socks proxy");
    assert_eq!(proxy.kind, SshProxyKind::Socks5);
    assert_eq!(proxy.host, "127.0.0.1");
    assert_eq!(proxy.port, 1081);
    assert_eq!(proxy.username, "proxy-user");
    assert_eq!(proxy.password, "proxy-pass");

    host.proxy.url = "http://proxy.local".to_string();
    host.proxy.port = 8080;
    let proxy = resolve_ssh_proxy(&host).expect("resolve http proxy");
    assert_eq!(proxy.kind, SshProxyKind::Http);
    assert_eq!(proxy.host, "proxy.local");
    assert_eq!(proxy.port, 8080);
}

#[test]
fn ssh_effective_proxy_resolves_manual_config_and_direct_connections() {
    let mut host = RuntimeSshHostConfig {
        id: "prod".to_string(),
        name: "Production".to_string(),
        host: "prod.example.com".to_string(),
        port: 22,
        username: "deploy".to_string(),
        auth_type: "keyboardInteractive".to_string(),
        password: String::new(),
        private_key: String::new(),
        private_key_path: String::new(),
        private_key_passphrase: String::new(),
        proxy: crate::commands::settings::RuntimeSshProxyConfig {
            proxy_type: "socks5".to_string(),
            url: String::new(),
            port: 0,
            username: String::new(),
            password: String::new(),
            password_configured: false,
            use_system_proxy: false,
        },
    };

    // No proxy configured at all → direct connection.
    assert!(resolve_effective_ssh_proxy(&host)
        .expect("resolve without proxy")
        .is_none());

    // Manual proxy fields resolve exactly like before.
    host.proxy.url = "socks5://127.0.0.1:1081".to_string();
    let proxy = resolve_effective_ssh_proxy(&host)
        .expect("resolve manual proxy")
        .expect("manual proxy should be used");
    assert_eq!(proxy.kind, SshProxyKind::Socks5);
    assert_eq!(proxy.host, "127.0.0.1");
    assert_eq!(proxy.port, 1081);
}

#[test]
fn ssh_app_proxy_reuse_maps_system_proxy_config() {
    let socks = crate::services::system_proxy::SystemProxyConfig {
        enabled: true,
        proxy_type: "socks5".to_string(),
        host: "10.0.0.1".to_string(),
        port: 1080,
        username: "user".to_string(),
        password: "pass".to_string(),
    };
    let proxy = system_proxy_to_ssh_proxy(&socks);
    assert_eq!(proxy.kind, SshProxyKind::Socks5);
    assert_eq!(proxy.host, "10.0.0.1");
    assert_eq!(proxy.port, 1080);
    assert_eq!(proxy.username, "user");
    assert_eq!(proxy.password, "pass");

    let http_ipv6 = crate::services::system_proxy::SystemProxyConfig {
        enabled: true,
        proxy_type: "http".to_string(),
        host: "[::1]".to_string(),
        port: 8080,
        username: String::new(),
        password: String::new(),
    };
    let proxy = system_proxy_to_ssh_proxy(&http_ipv6);
    assert_eq!(proxy.kind, SshProxyKind::Http);
    // Bracketed IPv6 hosts must be unwrapped for TcpStream resolution.
    assert_eq!(proxy.host, "::1");
    assert_eq!(proxy.port, 8080);
}

#[test]
fn socks5_address_writer_encodes_domain_and_ip_targets() {
    let mut domain = Vec::new();
    write_socks5_address(&mut domain, "prod.example.com").expect("domain target");
    assert_eq!(
        domain,
        [&[0x03, 16][..], b"prod.example.com".as_slice(),].concat()
    );

    let mut ipv4 = Vec::new();
    write_socks5_address(&mut ipv4, "127.0.0.1").expect("ipv4 target");
    assert_eq!(ipv4, vec![0x01, 127, 0, 0, 1]);

    assert_eq!(host_port_authority("::1", 22), "[::1]:22");
}

#[test]
fn terminal_shell_env_scrubs_npm_prefix() {
    let mut command = CommandBuilder::new("/bin/sh");
    command.env("npm_config_prefix", "/tmp/npm-prefix");
    command.env("NPM_CONFIG_PREFIX", "/tmp/npm-prefix");
    command.env("TERM", "dumb");

    configure_terminal_shell_env(&mut command, "/bin/sh");

    assert!(command.get_env("npm_config_prefix").is_none());
    assert!(command.get_env("NPM_CONFIG_PREFIX").is_none());
    assert_eq!(
        command.get_env("TERM").and_then(|value| value.to_str()),
        Some("xterm-256color")
    );
    assert_eq!(
        command
            .get_env("COLORTERM")
            .and_then(|value| value.to_str()),
        Some("truecolor")
    );
    assert!(command.get_env("PROMPT_EOL_MARK").is_none());
}

#[test]
fn zsh_terminal_shell_disables_prompt_sp() {
    assert_eq!(
        unix_shell_args("/bin/zsh"),
        vec!["-o".to_string(), "NO_PROMPT_SP".to_string()]
    );
    assert!(unix_shell_args("/bin/bash").is_empty());
}

#[test]
fn registry_creates_lists_renames_and_closes_session() {
    let registry = Arc::new(TerminalSessionRegistry::default());
    let tempdir = tempfile::tempdir().expect("tempdir");
    let cwd = tempdir.path().display().to_string();

    let created = registry
        .create(
            cwd.clone(),
            Some(cwd.clone()),
            None,
            Some("Test Terminal".to_string()),
            Some(80),
            Some(24),
        )
        .expect("create terminal session");
    assert!(created.session.running);
    assert_eq!(created.session.title, "Test Terminal");

    let listed = registry.list(Some(cwd.clone())).sessions;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, created.session.id);

    let resized = registry
        .resize(created.session.id.clone(), 100, 30)
        .expect("resize terminal session");
    assert_eq!(resized.cols, 100);
    assert_eq!(resized.rows, 30);

    let renamed = registry
        .rename(created.session.id.clone(), "Renamed Terminal".to_string())
        .expect("rename terminal session");
    assert_eq!(renamed.title, "Renamed Terminal");

    let closed = registry
        .close(created.session.id.clone())
        .expect("close terminal session");
    assert!(!closed.running);
    assert!(registry.list(Some(cwd)).sessions.is_empty());
}

#[test]
fn registry_closes_project_sessions() {
    let registry = Arc::new(TerminalSessionRegistry::default());
    let project_a = tempfile::tempdir().expect("project a");
    let project_b = tempfile::tempdir().expect("project b");
    let cwd_a = project_a.path().display().to_string();
    let cwd_b = project_b.path().display().to_string();

    registry
        .create(
            cwd_a.clone(),
            Some(cwd_a.clone()),
            None,
            Some("A".to_string()),
            Some(80),
            Some(24),
        )
        .expect("create project a terminal");
    registry
        .create(
            cwd_b.clone(),
            Some(cwd_b.clone()),
            None,
            Some("B".to_string()),
            Some(80),
            Some(24),
        )
        .expect("create project b terminal");
    assert_eq!(registry.running_session_count(), 2);

    let closed = registry
        .close_project(cwd_a.clone())
        .expect("close project a terminals");
    assert_eq!(closed.sessions.len(), 1);
    assert!(registry.list(Some(cwd_a)).sessions.is_empty());
    assert_eq!(registry.list(Some(cwd_b)).sessions.len(), 1);

    registry.close_all().expect("close remaining terminals");
    assert_eq!(registry.running_session_count(), 0);
}

#[test]
fn read_tail_requires_terminal_id_when_project_has_multiple_sessions() {
    let registry = Arc::new(TerminalSessionRegistry::default());
    let tempdir = tempfile::tempdir().expect("tempdir");
    let cwd = tempdir.path().display().to_string();

    let first = registry
        .create(
            cwd.clone(),
            Some(cwd.clone()),
            None,
            Some("First".to_string()),
            Some(80),
            Some(24),
        )
        .expect("create first terminal session");
    registry
        .create(
            cwd.clone(),
            Some(cwd.clone()),
            None,
            Some("Second".to_string()),
            Some(80),
            Some(24),
        )
        .expect("create second terminal session");

    let ambiguous = registry
        .read_tail(cwd.clone(), None, Some(1024))
        .expect("read ambiguous terminal tail");
    assert_eq!(ambiguous.sessions.len(), 2);
    assert!(ambiguous.selected_session.is_none());
    assert!(ambiguous.output.is_empty());

    let selected = registry
        .read_tail(cwd, Some(first.session.id), Some(1024))
        .expect("read selected terminal tail");
    assert!(selected.selected_session.is_some());
    assert_eq!(selected.sessions.len(), 2);

    registry.close_all().expect("close terminal sessions");
}

// Throwaway ed25519 keypair generated exclusively for these tests; it is not
// authorized on any host.
const TEST_ED25519_PRIVATE_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAhgk+uA1+13AN5TzsuvFZ6XDF0GlH9Kalc5hiRwXZqwAAAAKDyBWEV8gVh
FQAAAAtzc2gtZWQyNTUxOQAAACAhgk+uA1+13AN5TzsuvFZ6XDF0GlH9Kalc5hiRwXZqwA
AAAECRQtp7Gi2+TPkNeccdy+icQHNF/IzJfSQKpKQV2gGOYCGCT64DX7XcA3lPOy68Vnpc
MXQaUf0pqVzmGJHBdmrAAAAAFmxpdmVhZ2VudC10ZXN0LWZpeHR1cmUBAgMEBQYH
-----END OPENSSH PRIVATE KEY-----";

// Same fixture key encrypted with the passphrase "test-passphrase".
const TEST_ED25519_ENCRYPTED_PRIVATE_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABCDMU8BW1
9ccIJ7UHoiwkS7AAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIGitZyZ1OZcCXZWJ
EE8s43cVaBefHroCHgCzq+B01aK3AAAAoD4IuQwaxZi4m/hCmL4GT9kUERgxkZmQVN8noi
+OqtXHQ2+W7ykmmIJ8iwHTpK3W5WWJMmW+6tKhubShGMti7DwxpwJzL4dIkmTqs+e0wMZP
MZP6dJOnynjSTFz0RzJPHmEEOoy5kMDEXZx7UtRGNH/PYzZ5OeG5k9MhwVSp42TYs18wMI
OC6JVzVSYPJ41KjMtWIJkGFfLqqIPlNM5J2WI=
-----END OPENSSH PRIVATE KEY-----";

fn ssh_private_key_host(private_key: &str, passphrase: &str) -> RuntimeSshHostConfig {
    RuntimeSshHostConfig {
        id: "keyed".to_string(),
        name: "Keyed".to_string(),
        host: "keyed.example.com".to_string(),
        port: 22,
        username: "deploy".to_string(),
        auth_type: "privateKey".to_string(),
        password: String::new(),
        private_key: private_key.to_string(),
        private_key_path: String::new(),
        private_key_passphrase: passphrase.to_string(),
        proxy: crate::commands::settings::RuntimeSshProxyConfig {
            proxy_type: String::new(),
            url: String::new(),
            port: 0,
            username: String::new(),
            password: String::new(),
            password_configured: false,
            use_system_proxy: false,
        },
    }
}

fn resolved_private_key(host: &RuntimeSshHostConfig) -> String {
    match resolve_ssh_auth_material(host).expect("resolve private key auth") {
        ResolvedSshAuth::PrivateKey { key, .. } => key,
        _ => panic!("expected private key auth material"),
    }
}

#[test]
fn normalize_private_key_repairs_paste_artifacts() {
    let canonical = normalize_ssh_private_key_material(TEST_ED25519_PRIVATE_KEY);
    russh::keys::decode_secret_key(&canonical, None).expect("canonical key decodes");

    let crlf = TEST_ED25519_PRIVATE_KEY.replace('\n', "\r\n");
    let indented: String = TEST_ED25519_PRIVATE_KEY
        .lines()
        .map(|line| format!("  {line}\n"))
        .collect();
    let trailing_ws: String = TEST_ED25519_PRIVATE_KEY
        .lines()
        .map(|line| format!("{line} \n"))
        .collect();
    let single_line = TEST_ED25519_PRIVATE_KEY.replace('\n', " ");
    let escaped_newlines = TEST_ED25519_PRIVATE_KEY.replace('\n', "\\n");
    let with_bom = format!("\u{feff}{TEST_ED25519_PRIVATE_KEY}");
    let surrounded = format!("key material:\n{TEST_ED25519_PRIVATE_KEY}\n");

    for (label, mangled) in [
        ("crlf", crlf),
        ("indented", indented),
        ("trailing-ws", trailing_ws),
        ("single-line", single_line),
        ("escaped-newlines", escaped_newlines),
        ("bom", with_bom),
        ("surrounded", surrounded),
    ] {
        let normalized = normalize_ssh_private_key_material(&mangled);
        assert_eq!(normalized, canonical, "variant {label} normalizes");
        russh::keys::decode_secret_key(&normalized, None)
            .unwrap_or_else(|error| panic!("variant {label} decodes: {error}"));
    }
}

#[test]
fn normalize_private_key_is_idempotent() {
    let normalized = normalize_ssh_private_key_material(TEST_ED25519_PRIVATE_KEY);
    assert_eq!(normalize_ssh_private_key_material(&normalized), normalized);
}

#[test]
fn normalize_private_key_keeps_encrypted_pem_headers() {
    let legacy_encrypted = "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF\n\nAAAABBBBCCCC\n-----END RSA PRIVATE KEY-----";
    let normalized = normalize_ssh_private_key_material(legacy_encrypted);
    assert!(normalized.contains("Proc-Type: 4,ENCRYPTED\n"));
    assert!(normalized.contains("DEK-Info: AES-128-CBC,"));
    assert!(normalized.contains("\nAAAABBBBCCCC\n"));
}

#[test]
fn normalize_private_key_passes_ppk_through() {
    let ppk = "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: test\nPublic-Lines: 2\nAAAA\nBBBB";
    assert_eq!(normalize_ssh_private_key_material(ppk), ppk);
}

#[test]
fn resolve_ssh_auth_material_normalizes_pasted_private_key() {
    let mangled: String = TEST_ED25519_PRIVATE_KEY
        .lines()
        .map(|line| format!("  {line} \r\n"))
        .collect();
    let host = ssh_private_key_host(&mangled, "");

    let key = resolved_private_key(&host);
    russh::keys::decode_secret_key(&key, None).expect("normalized pasted key decodes");
}

#[test]
fn resolve_ssh_auth_material_reads_key_from_file() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let key_path = dir.path().join("fixture_ed25519");
    std::fs::write(&key_path, format!("{TEST_ED25519_PRIVATE_KEY}\n")).expect("write fixture key");

    let mut host = ssh_private_key_host("", "");
    host.private_key_path = key_path.to_string_lossy().into_owned();

    let key = resolved_private_key(&host);
    russh::keys::decode_secret_key(&key, None).expect("file-based key decodes");
}

#[test]
fn encrypted_private_key_decodes_with_passphrase() {
    let host = ssh_private_key_host(TEST_ED25519_ENCRYPTED_PRIVATE_KEY, "test-passphrase");
    match resolve_ssh_auth_material(&host).expect("resolve encrypted key auth") {
        ResolvedSshAuth::PrivateKey { key, passphrase } => {
            russh::keys::decode_secret_key(&key, passphrase.as_deref())
                .expect("encrypted key decodes with passphrase");
        }
        _ => panic!("expected private key auth material"),
    }
}

#[test]
fn private_key_decode_error_explains_missing_passphrase() {
    let key = normalize_ssh_private_key_material(TEST_ED25519_ENCRYPTED_PRIVATE_KEY);

    let missing = russh::keys::decode_secret_key(&key, None)
        .map(|_| ())
        .expect_err("encrypted key without passphrase fails");
    let message = describe_ssh_private_key_decode_error(&missing, false);
    assert!(
        message.contains("passphrase"),
        "missing-passphrase message should mention the passphrase: {message}"
    );

    let wrong = russh::keys::decode_secret_key(&key, Some("wrong"))
        .map(|_| ())
        .expect_err("encrypted key with wrong passphrase fails");
    let message = describe_ssh_private_key_decode_error(&wrong, true);
    assert!(
        message.contains("wrong passphrase"),
        "wrong-passphrase message should hint at the passphrase: {message}"
    );
}

#[test]
fn canonicalize_workdir_within_accepts_paths_inside_the_project() {
    let project = tempfile::tempdir().expect("project root");
    let nested = project.path().join("packages").join("app");
    std::fs::create_dir_all(&nested).expect("create nested workdir");
    let root = project.path().display().to_string();

    let resolved = canonicalize_workdir_within(&nested.display().to_string(), &root)
        .expect("nested workdir is inside the project");
    let canonical_root = canonicalize_workdir(&root).expect("canonical project root");
    assert!(resolved.starts_with(&canonical_root));

    let at_root =
        canonicalize_workdir_within(&root, &root).expect("project root itself is in range");
    assert_eq!(at_root, canonical_root);
}

#[test]
fn canonicalize_workdir_within_rejects_paths_outside_the_project() {
    let project = tempfile::tempdir().expect("project root");
    let outside = tempfile::tempdir().expect("outside root");
    let root = project.path().display().to_string();

    let sibling = canonicalize_workdir_within(&outside.path().display().to_string(), &root)
        .expect_err("sibling directory is rejected");
    assert!(
        sibling.contains("outside the current project"),
        "unexpected error: {sibling}"
    );

    let escaped = project.path().join("..");
    let traversal = canonicalize_workdir_within(&escaped.display().to_string(), &root)
        .expect_err("parent traversal is rejected");
    assert!(
        traversal.contains("outside the current project"),
        "unexpected error: {traversal}"
    );

    let absolute = canonicalize_workdir_within("/etc", &root)
        .expect_err("unrelated absolute path is rejected");
    assert!(
        absolute.contains("outside the current project"),
        "unexpected error: {absolute}"
    );

    let home = canonicalize_workdir_within("~", &root).expect_err("home directory is rejected");
    assert!(
        home.contains("outside the current project") || home.contains("workdir"),
        "unexpected error: {home}"
    );
}

#[cfg(unix)]
#[test]
fn canonicalize_workdir_within_rejects_symlink_escapes() {
    let project = tempfile::tempdir().expect("project root");
    let outside = tempfile::tempdir().expect("outside root");
    let link = project.path().join("escape");
    std::os::unix::fs::symlink(outside.path(), &link).expect("create escaping symlink");

    let error = canonicalize_workdir_within(
        &link.display().to_string(),
        &project.path().display().to_string(),
    )
    .expect_err("symlink pointing outside the project is rejected");
    assert!(
        error.contains("outside the current project"),
        "unexpected error: {error}"
    );
}

#[test]
fn canonicalize_workdir_within_requires_a_project_root() {
    let project = tempfile::tempdir().expect("project root");

    let error = canonicalize_workdir_within(&project.path().display().to_string(), "   ")
        .expect_err("blank project root is rejected");
    assert_eq!(error, "project_path_key is required");
}

#[test]
fn registry_create_requires_project_path_key() {
    let registry = Arc::new(TerminalSessionRegistry::default());
    let tempdir = tempfile::tempdir().expect("tempdir");

    let error = registry
        .create(
            tempdir.path().display().to_string(),
            None,
            None,
            None,
            Some(80),
            Some(24),
        )
        .expect_err("create without a project key is rejected");
    assert_eq!(error, "project_path_key is required");
    assert_eq!(registry.running_session_count(), 0);
}

#[test]
fn registry_create_rejects_cwd_outside_the_project() {
    let registry = Arc::new(TerminalSessionRegistry::default());
    let project = tempfile::tempdir().expect("project root");
    let outside = tempfile::tempdir().expect("outside root");

    let error = registry
        .create(
            outside.path().display().to_string(),
            Some(project.path().display().to_string()),
            None,
            None,
            Some(80),
            Some(24),
        )
        .expect_err("cwd outside the claimed project is rejected");
    assert!(
        error.contains("outside the current project"),
        "unexpected error: {error}"
    );
    assert_eq!(registry.running_session_count(), 0);
}

#[test]
fn mark_finished_broadcasts_exit_only_for_the_first_finisher() {
    // close() 与 PTY reader 线程在终止时都会调 mark_finished;若两次都广播
    // exit,输掉竞态的那次会在 closed 之后送达,前端将把刚关闭的会话复活成
    // 幽灵(attach 必败的 dock tab)。首个 finisher 独占广播。
    let registry = Arc::new(TerminalSessionRegistry::default());
    insert_test_ssh_session(
        &registry,
        "ssh-exit-once",
        "/tmp/project",
        false,
        SSH_STATUS_CONNECTED,
    );
    let (rx, _guard) = registry.subscribe();

    registry.mark_finished("ssh-exit-once");
    registry.mark_finished("ssh-exit-once");

    let mut exit_events = 0;
    while let Ok(event) = rx.try_recv() {
        if event.payload.kind == "exit" {
            exit_events += 1;
        }
    }
    assert_eq!(
        exit_events, 1,
        "duplicate mark_finished must not re-broadcast exit"
    );
}

#[test]
fn close_emits_exit_then_closed_without_a_trailing_exit() {
    let registry = Arc::new(TerminalSessionRegistry::default());
    insert_test_ssh_session(
        &registry,
        "ssh-close-order",
        "/tmp/project",
        false,
        SSH_STATUS_CONNECTED,
    );
    let (rx, _guard) = registry.subscribe();

    registry
        .close("ssh-close-order".to_string())
        .expect("close test session");
    // 模拟 reader 线程迟到的 mark_finished:会话已移除,必须完全静默。
    registry.mark_finished("ssh-close-order");

    let kinds: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|event| event.payload.kind)
        .collect();
    assert_eq!(kinds, vec!["exit".to_string(), "closed".to_string()]);
}
