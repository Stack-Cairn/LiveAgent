#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open_memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        initialize_schema(&conn).expect("initialize schema");
        conn
    }

    fn table_columns(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table info");
        stmt.query_map([], |row| row.get::<_, String>(1))
            .expect("query table info")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect table columns")
    }

    #[test]
    fn initialize_schema_creates_all_tables() {
        let conn = open_memory_db();

        for table in [
            PROVIDER_SETTINGS_TABLE,
            SYSTEM_SETTINGS_TABLE,
            MCP_SETTINGS_TABLE,
            AGENT_PROMPT_TEMPLATES_TABLE,
            SSH_SETTINGS_TABLE,
            REMOTE_SETTINGS_TABLE,
            MEMORY_SETTINGS_TABLE,
            MODEL_FAILOVER_SETTINGS_TABLE,
            SSH_PROJECT_HOST_ASSOCIATIONS_TABLE,
            SSH_KNOWN_HOSTS_TABLE,
            BACKUP_SYNC_SETTINGS_TABLE,
        ] {
            let exists = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |row| row.get::<_, i64>(0),
                )
                .expect("query sqlite_master");
            assert_eq!(exists, 1, "table {table} should exist");
        }
    }

    #[test]
    fn ssh_patch_conflict_gateway_message_is_a_stable_code() {
        assert_eq!(
            SshPatchConflictCode::SettingsChanged.gateway_message(),
            "settings_changed"
        );
    }

    #[test]
    fn initialize_schema_creates_columnar_ssh_settings_table() {
        let conn = open_memory_db();
        let columns = table_columns(&conn, SSH_SETTINGS_TABLE);

        for column in [
            "host_id",
            "name",
            "description",
            "host",
            "port",
            "username",
            "auth_type",
            "password",
            "password_configured",
            "private_key",
            "private_key_path",
            "private_key_configured",
            "private_key_passphrase",
            "private_key_passphrase_configured",
            "proxy_json",
            "sort_index",
            "updated_at",
        ] {
            assert!(
                columns.iter().any(|item| item == column),
                "{SSH_SETTINGS_TABLE}.{column} should exist"
            );
        }
        assert!(
            !columns.iter().any(|item| item == "payload_json"),
            "{SSH_SETTINGS_TABLE}.payload_json should not exist"
        );
    }

    #[test]
    fn save_memory_persists_default_payload_and_sync_snapshot() {
        let mut conn = open_memory_db();
        let payload = json!({
            "organizerModel": {
                "customProviderId": "provider-a",
                "model": "gpt-5"
            },
            "summaryModel": {
                "customProviderId": "provider-a",
                "model": "gpt-5.4"
            }
        });

        save_memory(&mut conn, payload.clone()).expect("save memory settings");

        assert_eq!(
            load_memory(&conn).expect("load memory settings"),
            Some(payload.clone())
        );
        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["memory"], payload);
    }

    #[test]
    fn normalize_remote_settings_repairs_single_slash_gateway_url() {
        let normalized = normalize_remote_settings_payload(RemoteSettingsPayload {
            enabled: true,
            gateway_url: " https:/agent.cnweb.org/ ".to_string(),
            gateway_port: 443,
            token: " agent-token-dev ".to_string(),
            agent_id: " mac-mini ".to_string(),
            auto_reconnect: true,
            heartbeat_interval: 30,
            enable_web_terminal: false,
            enable_web_ssh_terminal: false,
            enable_web_git: false,
            enable_web_tunnels: false,
        });

        assert_eq!(normalized.gateway_url, "https://agent.cnweb.org");
        assert_eq!(normalized.token, "agent-token-dev");
        assert_eq!(normalized.agent_id, "mac-mini");
    }

    #[test]
    fn ensure_remote_agent_id_migrates_legacy_grpc_port() {
        let mut conn = open_memory_db();
        let legacy = json!({
            "enabled": true,
            "gatewayUrl": "https://gateway.example.com",
            "grpcPort": 8443,
            "token": "gateway-token"
        });
        conn.execute(
            &format!(
                "INSERT INTO {REMOTE_SETTINGS_TABLE} (config_id, payload_json, updated_at)
                 VALUES ('default', ?1, ?2)"
            ),
            params![legacy.to_string(), now_ms()],
        )
        .expect("seed legacy remote settings");

        ensure_remote_agent_id(&mut conn).expect("migrate legacy remote settings");
        let migrated = load_remote_settings(&conn).expect("load migrated remote settings");
        let stored_json = conn
            .query_row(
                &format!(
                    "SELECT payload_json FROM {REMOTE_SETTINGS_TABLE} WHERE config_id = 'default'"
                ),
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("load stored remote payload");

        assert_eq!(migrated.gateway_port, 8443);
        assert!(is_generated_agent_id(&migrated.agent_id));
        assert!(stored_json.contains("\"gatewayPort\":8443"));
        assert!(!stored_json.contains("grpcPort"));
    }

    #[test]
    fn ensure_remote_agent_id_generates_once_and_survives_reopen() {
        let mut conn = open_memory_db();

        let first = ensure_remote_agent_id(&mut conn).expect("generate Agent ID");
        let second = ensure_remote_agent_id(&mut conn).expect("reload Agent ID");
        let stored = load_remote_settings(&conn).expect("load remote settings");

        assert!(is_generated_agent_id(&first), "generated id = {first}");
        assert_eq!(second, first);
        assert_eq!(stored.agent_id, first);
    }

    #[test]
    fn ensure_remote_agent_id_replaces_manual_id_and_preserves_remote_settings() {
        let mut conn = open_memory_db();
        persist_remote_settings(
            &conn,
            &RemoteSettingsPayload {
                enabled: true,
                gateway_url: "https://gateway.example.com".to_string(),
                gateway_port: 8443,
                token: "gateway-token".to_string(),
                agent_id: "liveagent".to_string(),
                auto_reconnect: false,
                heartbeat_interval: 45,
                enable_web_terminal: true,
                enable_web_ssh_terminal: true,
                enable_web_git: true,
                enable_web_tunnels: true,
            },
        )
        .expect("seed manual Agent ID");

        let generated = ensure_remote_agent_id(&mut conn).expect("replace manual Agent ID");
        let stored = load_remote_settings(&conn).expect("load remote settings");

        assert!(is_generated_agent_id(&generated));
        assert_eq!(stored.agent_id, generated);
        assert_eq!(stored.gateway_url, "https://gateway.example.com");
        assert_eq!(stored.gateway_port, 8443);
        assert_eq!(stored.token, "gateway-token");
        assert!(!stored.auto_reconnect);
        assert_eq!(stored.heartbeat_interval, 45);
        assert!(stored.enable_web_terminal);
        assert!(stored.enable_web_ssh_terminal);
        assert!(stored.enable_web_git);
        assert!(stored.enable_web_tunnels);
    }

    #[test]
    fn save_remote_cannot_override_persisted_agent_id() {
        let mut conn = open_memory_db();
        let generated = ensure_remote_agent_id(&mut conn).expect("generate Agent ID");

        let saved = save_remote(
            &mut conn,
            json!({
                "enabled": true,
                "gatewayUrl": "https://gateway.example.com",
                "gatewayPort": 443,
                "token": "gateway-token",
                "agentId": "attacker-controlled",
                "autoReconnect": true,
                "heartbeatInterval": 30
            }),
        )
        .expect("save remote settings");
        let stored = load_remote_settings(&conn).expect("load remote settings");

        assert_eq!(saved.agent_id, generated);
        assert_eq!(stored.agent_id, generated);
    }

    #[test]
    fn independent_installations_generate_different_agent_ids() {
        let mut first = open_memory_db();
        let mut second = open_memory_db();

        let first_id = ensure_remote_agent_id(&mut first).expect("generate first Agent ID");
        let second_id = ensure_remote_agent_id(&mut second).expect("generate second Agent ID");

        assert_ne!(first_id, second_id);
    }

    #[test]
    fn concurrent_initialization_keeps_one_agent_id() {
        let dir = tempfile::tempdir().expect("create temp directory");
        let path = dir.path().join("settings.sqlite");
        let conn = Connection::open(&path).expect("open shared settings db");
        initialize_schema(&conn).expect("initialize schema");
        drop(conn);

        let workers = (0..8)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let mut conn = Connection::open(path).expect("open shared settings db");
                    conn.busy_timeout(Duration::from_secs(5))
                        .expect("configure busy timeout");
                    ensure_remote_agent_id(&mut conn).expect("initialize Agent ID")
                })
            })
            .collect::<Vec<_>>();
        let ids = workers
            .into_iter()
            .map(|worker| worker.join().expect("join Agent ID initializer"))
            .collect::<Vec<_>>();

        assert!(ids.iter().all(|agent_id| agent_id == &ids[0]));
        assert!(is_generated_agent_id(&ids[0]));
    }

    #[test]
    fn save_providers_persists_one_row_per_provider_and_preserves_order() {
        let mut conn = open_memory_db();
        save_providers(
            &mut conn,
            json!([
                { "id": "provider-b", "name": "B" },
                { "id": "provider-a", "name": "A" }
            ]),
        )
        .expect("save providers");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM provider_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count provider rows");
        let loaded = load_providers(&conn).expect("load providers");

        assert_eq!(row_count, 2);
        assert_eq!(
            loaded,
            Some(json!([
                { "id": "provider-b", "name": "B" },
                { "id": "provider-a", "name": "A" }
            ]))
        );
    }

    #[test]
    fn gateway_settings_snapshot_redacts_provider_api_keys() {
        let mut conn = open_memory_db();
        save_providers(
            &mut conn,
            json!([
                {
                    "id": "provider-a",
                    "name": "A",
                    "apiKey": "secret-key",
                    "usageQuery": {
                        "apiKey": "usage-key",
                        "accessToken": "usage-token",
                        "secretAccessKey": "usage-secret"
                    },
                    "apiKeyConfigured": false
                },
                {
                    "id": "provider-b",
                    "name": "B",
                    "apiKey": "",
                    "apiKeyConfigured": true
                }
            ]),
        )
        .expect("save providers");

        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["customProviders"][0]["apiKey"], Value::Null);
        assert_eq!(snapshot["customProviders"][0]["apiKeyConfigured"], true);
        assert_eq!(snapshot["customProviders"][0]["usageQuery"]["apiKey"], Value::Null);
        assert_eq!(
            snapshot["customProviders"][0]["usageQuery"]["apiKeyConfigured"],
            true
        );
        assert_eq!(snapshot["customProviders"][0]["usageQuery"]["accessToken"], Value::Null);
        assert_eq!(
            snapshot["customProviders"][0]["usageQuery"]["accessTokenConfigured"],
            true
        );
        assert_eq!(
            snapshot["customProviders"][0]["usageQuery"]["secretAccessKey"],
            Value::Null
        );
        assert_eq!(
            snapshot["customProviders"][0]["usageQuery"]["secretAccessKeyConfigured"],
            true
        );
        assert_eq!(snapshot["customProviders"][1]["apiKey"], Value::Null);
        assert_eq!(snapshot["customProviders"][1]["apiKeyConfigured"], true);
    }

    #[test]
    fn gateway_settings_payload_removes_usage_query_secret_sidecar() {
        let redacted = redact_gateway_settings_sync_payload(json!({
            "providerUsageQuerySecretUpdates": {
                "provider-a": {
                    "accessToken": "usage-token",
                    "secretAccessKey": "usage-secret"
                }
            }
        }))
        .expect("redact gateway settings payload");

        assert_eq!(redacted.get("providerUsageQuerySecretUpdates"), None);
    }

    #[test]
    fn gateway_settings_snapshot_redacts_stt_and_private_sync_field() {
        let mut conn = open_memory_db();
        save_stt(
            &mut conn,
            json!({
                "provider": "aliyun_dashscope",
                "providers": {
                    "aliyun_dashscope": {
                        "id": "aliyun_dashscope",
                        "websocketUrl": "wss://example.com/stt",
                        "model": "paraformer-realtime-v2",
                        "apiKey": "desktop-only-secret"
                    }
                }
            }),
        )
        .expect("save STT settings");

        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["stt"]["provider"], "aliyun_dashscope");
        assert_eq!(
            snapshot["stt"]["providers"]["aliyun_dashscope"]["configured"],
            true
        );
        assert_eq!(
            snapshot["stt"]["providers"]["aliyun_dashscope"]["apiKey"],
            ""
        );
        assert_eq!(
            load_stt_secret(&conn, "aliyun_dashscope", "apiKey")
                .expect("reveal local STT secret"),
            "desktop-only-secret"
        );
        assert!(load_stt_secret(&conn, "aliyun_dashscope", "websocketUrl").is_err());

        let redacted = redact_gateway_settings_sync_payload(json!({
            "sttSecretSync": {
                "providers": {"aliyun_dashscope": {"apiKey": "must-not-leak"}}
            },
            "stt": load_stt_raw(&conn).expect("load raw STT settings")
        }))
        .expect("redact gateway STT payload");
        assert_eq!(redacted.get(STT_SECRET_SYNC_FIELD), None);
        assert_eq!(
            redacted["stt"]["providers"]["aliyun_dashscope"]["apiKey"],
            ""
        );
    }

    #[test]
    fn save_ssh_persists_hosts_and_redacts_sync_snapshot() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [
                    {
                        "id": "prod",
                        "name": "Production",
                        "description": "Primary production host",
                        "host": "prod.example.com",
                        "port": "2222",
                        "username": "deploy",
                        "authType": "privateKey",
                        "password": "ssh-password",
                        "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----",
                        "privateKeyPath": "~/.ssh/id_ed25519",
                        "privateKeyPassphrase": "key-passphrase",
                        "proxy": {
                            "type": "http",
                            "url": "http://127.0.0.1",
                            "port": "1080",
                            "username": "proxy-user",
                            "password": "proxy-password",
                            "useSystemProxy": true
                        }
                    },
                    {
                        "id": "staging",
                        "name": "Staging",
                        "description": "",
                        "host": "staging.example.com",
                        "username": "ubuntu",
                        "authType": "password",
                        "passwordConfigured": true
                    }
                ],
                "projectHostAssociations": {
                    " /repo/project ": ["prod", "missing", "prod", "staging"],
                    "empty": ["missing"],
                    "  ": ["prod"]
                }
            }),
        )
        .expect("save ssh settings");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM ssh_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count ssh rows");
        let loaded = load_ssh(&conn).expect("load ssh settings");

        assert_eq!(row_count, 2);
        let stored = conn
            .query_row(
                "
                SELECT name, host, port, auth_type, private_key, private_key_passphrase, proxy_json
                FROM ssh_settings
                WHERE host_id = 'prod'
                ",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .expect("load stored ssh columns");
        assert_eq!(stored.0, "Production");
        assert_eq!(stored.1, "prod.example.com");
        assert_eq!(stored.2, 2222);
        assert_eq!(stored.3, "privateKey");
        assert_eq!(
            stored.4,
            "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----"
        );
        assert_eq!(stored.5, "key-passphrase");
        assert_eq!(
            parse_json(&stored.6, SSH_SETTINGS_TABLE).expect("parse proxy json"),
            json!({
                "type": "http",
                "url": "http://127.0.0.1",
                "port": 1080,
                "username": "proxy-user",
                "password": "proxy-password",
                "passwordConfigured": true,
                "useSystemProxy": true
            })
        );
        assert_eq!(
            loaded,
            Some(json!({
                "hosts": [
                    {
                        "id": "prod",
                        "name": "Production",
                        "description": "Primary production host",
                        "host": "prod.example.com",
                        "port": 2222,
                        "username": "deploy",
                        "authType": "privateKey",
                        "password": "ssh-password",
                        "passwordConfigured": true,
                        "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----",
                        "privateKeyPath": "~/.ssh/id_ed25519",
                        "privateKeyConfigured": true,
                        "privateKeyPassphrase": "key-passphrase",
                        "privateKeyPassphraseConfigured": true,
                        "proxy": {
                            "type": "http",
                            "url": "http://127.0.0.1",
                            "port": 1080,
                            "username": "proxy-user",
                            "password": "proxy-password",
                            "passwordConfigured": true,
                            "useSystemProxy": true
                        }
                    },
                    {
                        "id": "staging",
                        "name": "Staging",
                        "description": "",
                        "host": "staging.example.com",
                        "port": 22,
                        "username": "ubuntu",
                        "authType": "password",
                        "password": "",
                        "passwordConfigured": true,
                        "privateKey": "",
                        "privateKeyPath": "",
                        "privateKeyConfigured": false,
                        "privateKeyPassphrase": "",
                        "privateKeyPassphraseConfigured": false,
                        "proxy": {
                            "type": "socks5",
                            "url": "",
                            "port": 0,
                            "username": "",
                            "password": "",
                            "passwordConfigured": false,
                            "useSystemProxy": false
                        }
                    }
                ],
                "projectHostAssociations": {
                    "/repo/project": ["prod", "staging"]
                }
            }))
        );

        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["ssh"]["hosts"][0]["password"], Value::Null);
        assert_eq!(snapshot["ssh"]["hosts"][0]["privateKey"], Value::Null);
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["privateKeyPassphrase"],
            Value::Null
        );
        assert_eq!(snapshot["ssh"]["hosts"][0]["passwordConfigured"], true);
        assert_eq!(snapshot["ssh"]["hosts"][0]["privateKeyConfigured"], true);
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["privateKeyPassphraseConfigured"],
            true
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["proxy"]["password"],
            Value::Null
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["proxy"]["passwordConfigured"],
            true
        );
        assert_eq!(snapshot["ssh"]["hosts"][1]["password"], Value::Null);
        assert_eq!(snapshot["ssh"]["hosts"][1]["privateKey"], Value::Null);
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["privateKeyPassphrase"],
            Value::Null
        );
        assert_eq!(snapshot["ssh"]["hosts"][1]["passwordConfigured"], true);
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["privateKeyPassphraseConfigured"],
            false
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["proxy"]["password"],
            Value::Null
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["proxy"]["passwordConfigured"],
            false
        );
        assert_eq!(
            snapshot["ssh"]["projectHostAssociations"],
            json!({
                "/repo/project": ["prod", "staging"]
            })
        );
    }

    #[test]
    fn save_ssh_keyboard_interactive_host_clears_credential_secret_state() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [
                    {
                        "id": "kbi-prod",
                        "name": "Keyboard Interactive Production",
                        "host": "prod.example.com",
                        "username": "deploy",
                        "authType": "keyboardInteractive",
                        "password": "old-password",
                        "passwordConfigured": true,
                        "privateKey": "old-key",
                        "privateKeyPath": "~/.ssh/id_rsa",
                        "privateKeyConfigured": true,
                        "privateKeyPassphrase": "old-passphrase",
                        "privateKeyPassphraseConfigured": true,
                        "proxy": {
                            "type": "http",
                            "url": "http://127.0.0.1",
                            "port": 8080,
                            "username": "proxy-user",
                            "password": "proxy-password"
                        }
                    }
                ]
            }),
        )
        .expect("save keyboard-interactive ssh settings");

        let loaded = load_ssh(&conn)
            .expect("load ssh settings")
            .expect("ssh settings should exist");
        let host = &loaded["hosts"][0];
        assert_eq!(host["authType"], "keyboardInteractive");
        assert_eq!(host["password"], "");
        assert_eq!(host["passwordConfigured"], false);
        assert_eq!(host["privateKey"], "");
        assert_eq!(host["privateKeyPath"], "");
        assert_eq!(host["privateKeyConfigured"], false);
        assert_eq!(host["privateKeyPassphrase"], "");
        assert_eq!(host["privateKeyPassphraseConfigured"], false);
        assert_eq!(host["proxy"]["passwordConfigured"], true);

        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["ssh"]["hosts"][0]["password"], Value::Null);
        assert_eq!(snapshot["ssh"]["hosts"][0]["passwordConfigured"], false);
        assert_eq!(snapshot["ssh"]["hosts"][0]["privateKeyConfigured"], false);
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["privateKeyPassphraseConfigured"],
            false
        );
    }

    #[test]
    fn initialize_schema_migrates_legacy_agent_auth_to_password() {
        let conn = open_memory_db();
        conn.execute(
            "
            INSERT INTO ssh_settings (
                host_id, name, description, host, port, username, auth_type,
                password, password_configured, private_key, private_key_path,
                private_key_configured, private_key_passphrase,
                private_key_passphrase_configured, proxy_json, sort_index, updated_at
            )
            VALUES ('legacy', 'Legacy', '', 'legacy.example.com', 22, 'deploy', 'agent',
                '', 0, '', '', 0, '', 0, '{}', 0, 0)
            ",
            [],
        )
        .expect("insert legacy agent host");

        initialize_schema(&conn).expect("re-run schema initialization");

        let auth_type: String = conn
            .query_row(
                "SELECT auth_type FROM ssh_settings WHERE host_id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .expect("read migrated auth type");
        assert_eq!(auth_type, "password");
    }

    #[test]
    fn ssh_patch_delete_preserves_concurrent_hosts_and_associations() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [
                    {
                        "id": "prod",
                        "name": "Prod",
                        "host": "prod.example.com",
                        "username": "deploy",
                        "authType": "password"
                    },
                    {
                        "id": "staging",
                        "name": "Staging",
                        "host": "staging.example.com",
                        "username": "deploy",
                        "authType": "keyboardInteractive"
                    }
                ],
                "projectHostAssociations": {
                    "/repo": ["prod", "staging"]
                }
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        },
                        "after": null
                    }],
                    "projectAssociationChanges": [{
                        "pathKey": "/repo",
                        "before": ["prod"],
                        "after": []
                    }]
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(response.conflict, None);
        assert_eq!(response.ssh["hosts"][0]["id"], "staging");
        assert_eq!(
            response.ssh["projectHostAssociations"],
            json!({
                "/repo": ["staging"]
            })
        );
    }

    #[test]
    fn ssh_patch_rejects_same_field_conflict() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod New",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "password"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        },
                        "after": {
                            "id": "prod",
                            "name": "Prod Web",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        }
                    }]
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(
            response.conflict,
            Some(SshPatchConflictCode::SettingsChanged)
        );
        assert_eq!(response.ssh["hosts"][0]["name"], "Prod New");
    }

    #[test]
    fn ssh_patch_merges_different_host_fields() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod Desktop",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "password"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        },
                        "after": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.internal",
                            "username": "deploy",
                            "authType": "password"
                        }
                    }]
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(response.conflict, None);
        assert_eq!(response.ssh["hosts"][0]["name"], "Prod Desktop");
        assert_eq!(response.ssh["hosts"][0]["host"], "prod.internal");
    }

    #[test]
    fn ssh_patch_rejects_auth_type_secret_conflict() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "keyboardInteractive"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {},
                "sshSecretUpdates": {
                    "prod": {
                        "password": "secret"
                    }
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(
            response.conflict,
            Some(SshPatchConflictCode::SettingsChanged)
        );
    }

    #[test]
    fn ssh_patch_clears_empty_secret_updates() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "password",
                    "password": "old-password"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password",
                            "passwordConfigured": true
                        },
                        "after": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password",
                            "passwordConfigured": false
                        }
                    }]
                },
                "sshSecretUpdates": {
                    "prod": {
                        "password": ""
                    }
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(response.conflict, None);
        assert_eq!(response.ssh["hosts"][0]["password"], "");
        assert_eq!(response.ssh["hosts"][0]["passwordConfigured"], false);
    }

    #[test]
    fn ssh_known_hosts_tracks_unknown_known_and_changed_keys() {
        let conn = open_memory_db();
        let key = RuntimeSshKnownHostKey {
            host: "example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            key_base64: "known-key".to_string(),
            fingerprint_sha256: "SHA256:known".to_string(),
        };

        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &key).expect("check unknown host key"),
            RuntimeSshKnownHostStatus::Unknown
        );

        trust_runtime_ssh_known_host_with_conn(&conn, &key).expect("trust host key");
        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &key).expect("check trusted host key"),
            RuntimeSshKnownHostStatus::Known
        );

        let changed = RuntimeSshKnownHostKey {
            key_base64: "changed-key".to_string(),
            fingerprint_sha256: "SHA256:changed".to_string(),
            ..key.clone()
        };
        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &changed)
                .expect("check changed host key"),
            RuntimeSshKnownHostStatus::Changed {
                stored_fingerprint: "SHA256:known".to_string()
            }
        );

        assert_eq!(
            reset_runtime_ssh_known_host_with_conn(&conn, "example.com", 22)
                .expect("reset host key"),
            1
        );
        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &key).expect("check reset host key"),
            RuntimeSshKnownHostStatus::Unknown
        );
        assert_eq!(
            reset_runtime_ssh_known_host_with_conn(&conn, "example.com", 22)
                .expect("reset missing host key"),
            0
        );
    }

    #[test]
    fn save_mcp_persists_one_row_per_server_and_restores_selection() {
        let mut conn = open_memory_db();
        save_mcp(
            &mut conn,
            json!({
                "servers": [
                    { "id": "alpha", "enabled": true, "transport": "stdio" },
                    { "id": "beta", "enabled": false, "transport": "http" }
                ],
                "selected": ["beta"]
            }),
        )
        .expect("save mcp");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM mcp_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count mcp rows");
        let selected_flag = conn
            .query_row(
                "SELECT payload_json FROM mcp_settings WHERE server_id = 'beta'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("query beta payload");
        let loaded = load_mcp(&conn).expect("load mcp");

        assert_eq!(row_count, 2);
        assert!(
            selected_flag.contains("\"selected\":true"),
            "selected flag should be stored inline"
        );
        assert_eq!(
            loaded,
            Some(json!({
                "servers": [
                    { "id": "alpha", "enabled": true, "transport": "stdio" },
                    { "id": "beta", "enabled": false, "transport": "http" }
                ],
                "selected": ["beta"]
            }))
        );
    }

    #[test]
    fn save_agents_persists_one_row_per_template_and_restores_columns() {
        let mut conn = open_memory_db();
        save_agents(
            &mut conn,
            json!([
                {
                    "id": "reviewer",
                    "name": "代码审查",
                    "description": "用于审查 PR 和补测试缺口",
                    "prompt": "你是一个严格的代码审查助手。",
                    "enabled": true
                },
                {
                    "id": "planner",
                    "name": "任务规划",
                    "description": "",
                    "prompt": "先拆任务，再执行。",
                    "enabled": false
                }
            ]),
        )
        .expect("save agents");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM agent_prompt_templates", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count agent rows");
        let stored_enabled = conn
            .query_row(
                "SELECT enabled FROM agent_prompt_templates WHERE template_id = 'reviewer'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("query reviewer enabled");
        let loaded = load_agents(&conn).expect("load agents");

        assert_eq!(row_count, 2);
        assert_eq!(stored_enabled, 1);
        assert_eq!(
            loaded,
            Some(json!([
                {
                    "id": "reviewer",
                    "name": "代码审查",
                    "description": "用于审查 PR 和补测试缺口",
                    "prompt": "你是一个严格的代码审查助手。",
                    "enabled": true
                },
                {
                    "id": "planner",
                    "name": "任务规划",
                    "description": "",
                    "prompt": "先拆任务，再执行。",
                    "enabled": false
                }
            ]))
        );
    }

    /// 归一后的 systemProxy 默认值（save/load 全量断言共用）。
    fn default_system_proxy_json() -> Value {
        json!({
            "enabled": false,
            "type": "http",
            "host": "",
            "port": 0,
            "username": "",
            "password": "",
            "passwordConfigured": false
        })
    }

    #[test]
    fn save_system_persists_project_setting_rows() {
        let mut conn = open_memory_db();
        let default_workdir = default_project_workdir().expect("default workdir");
        save_system(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "E:/Code/test_directory/003",
                "toolPolicies": { "Bash": "ask", "server:docs-mcp": "deny" }
            }),
        )
        .expect("save system");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM system_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count system rows");
        let keys = {
            let mut stmt = conn
                .prepare("SELECT setting_key FROM system_settings ORDER BY setting_key ASC")
                .expect("prepare key query");
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .expect("query keys");
            rows.into_iter()
                .map(|row| row.expect("key row"))
                .collect::<Vec<_>>()
        };
        let loaded = load_system(&conn).expect("load system");

        assert_eq!(row_count, 13);
        assert_eq!(
            keys,
            vec![
                SYSTEM_ACTIVE_WORKSPACE_PROJECT_ID_KEY.to_string(),
                SYSTEM_ARCHIVED_WORKSPACE_PROJECT_PATHS_KEY.to_string(),
                SYSTEM_BROWSER_AUTOMATION_MODE_KEY.to_string(),
                SYSTEM_COMMAND_SAFETY_MODE_KEY.to_string(),
                SYSTEM_EXECUTION_MODE_KEY.to_string(),
                SYSTEM_HIDDEN_WORKSPACE_PROJECT_PATHS_KEY.to_string(),
                SYSTEM_MISSING_WORKSPACE_PROJECT_PATHS_KEY.to_string(),
                SYSTEM_SYSTEM_PROXY_KEY.to_string(),
                SYSTEM_TOOL_POLICIES_KEY.to_string(),
                SYSTEM_WORKDIR_KEY.to_string(),
                SYSTEM_WORKSPACE_PROJECT_GROUPS_KEY.to_string(),
                SYSTEM_WORKSPACE_PROJECTS_KEY.to_string(),
                SYSTEM_WORKSPACE_RESOURCE_SETTINGS_KEY.to_string(),
            ]
        );
        assert_eq!(
            loaded,
            Some(json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "archivedWorkspaceProjectPaths": [],
                "workspaceResourceSettings": {},
                "commandSafetyMode": "auto",
                "browserAutomationMode": "auto",
                "systemProxy": default_system_proxy_json(),
                "workdir": default_workdir.clone(),
                "toolPolicies": { "Bash": "ask", "server:docs-mcp": "deny" },
                "workspaceProjectGroups": null,
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": default_workdir.clone(),
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                ]
            }))
        );
    }

    #[test]
    fn save_system_round_trips_archived_workspace_project_paths() {
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "/tmp/liveagent-default-project",
                "archivedWorkspaceProjectPaths": [
                    " /tmp/project-a ",
                    "/tmp/project-a",
                    "",
                    42
                ]
            }),
            "/tmp/liveagent-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn)
            .expect("load system")
            .expect("system settings");
        assert_eq!(
            loaded.get(SYSTEM_ARCHIVED_WORKSPACE_PROJECT_PATHS_KEY),
            Some(&json!(["/tmp/project-a"]))
        );
    }

    #[test]
    fn save_system_round_trips_workspace_project_groups() {
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "/tmp/liveagent-default-project",
                "workspaceProjectGroups": [
                    {
                        "id": "g1",
                        "name": "LiveAgent",
                        "projectPaths": ["/tmp/repo", "/tmp/wt"],
                        "sourceProjectPath": "/tmp/repo",
                        "collapsed": true,
                        "createdAt": 100,
                        "updatedAt": 100
                    }
                ]
            }),
            "/tmp/liveagent-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn)
            .expect("load system")
            .expect("system settings");
        assert_eq!(
            loaded.get(SYSTEM_WORKSPACE_PROJECT_GROUPS_KEY),
            Some(&json!([
                {
                    "id": "g1",
                    "name": "LiveAgent",
                    "projectPaths": ["/tmp/repo", "/tmp/wt"],
                    "sourceProjectPath": "/tmp/repo",
                    "collapsed": true,
                    "createdAt": 100,
                    "updatedAt": 100
                }
            ]))
        );
    }

    #[test]
    fn save_system_normalizes_workspace_resource_settings() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_millis() as u64;
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "/tmp/liveagent-default-project",
                "workspaceResourceSettings": {
                    "/tmp/project-a/": {
                        "mode": "custom",
                        "skillNames": ["review", "review", ""],
                        "mcpServerIds": ["github", "github", 42],
                        "stateVersion": 3,
                        "writerId": " client-a ",
                        "updatedAt": 100
                    },
                    "/tmp/project-b": {
                        "mode": "inherit",
                        "skillNames": ["ignored"],
                        "mcpServerIds": ["ignored"],
                        "stateVersion": 4,
                        "writerId": "client-b",
                        "updatedAt": now
                    }
                }
            }),
            "/tmp/liveagent-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn)
            .expect("load system")
            .expect("system settings");
        assert_eq!(
            loaded.get(SYSTEM_WORKSPACE_RESOURCE_SETTINGS_KEY),
            Some(&json!({
                "/tmp/project-a": {
                    "mode": "custom",
                    "skillNames": ["review"],
                    "mcpServerIds": ["github"],
                    "stateVersion": 3,
                    "writerId": "client-a",
                    "updatedAt": 100
                },
                "/tmp/project-b": {
                    "mode": "inherit",
                    "skillNames": [],
                    "mcpServerIds": [],
                    "stateVersion": 4,
                    "writerId": "client-b",
                    "updatedAt": now
                }
            }))
        );
    }

    #[test]
    fn workspace_resource_settings_are_not_truncated_after_one_hundred_paths() {
        let entries = (0..150)
            .map(|index| {
                (
                    format!("/tmp/project-{index}"),
                    json!({
                        "mode": "custom",
                        "skillNames": [format!("skill-{index}")],
                        "mcpServerIds": [],
                        "stateVersion": 1,
                        "writerId": "test",
                        "updatedAt": index + 1
                    }),
                )
            })
            .collect::<Map<String, Value>>();
        let normalized = normalize_workspace_resource_settings(Some(&Value::Object(entries)));
        let normalized = normalized.as_object().expect("normalized workspace resources");
        assert_eq!(normalized.len(), 150);
        assert_eq!(
            normalized["/tmp/project-149"]["skillNames"],
            json!(["skill-149"])
        );
    }

    #[test]
    fn workspace_resource_settings_expire_only_old_inherit_tombstones() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_millis() as u64;
        let old = now - WORKSPACE_RESOURCE_TOMBSTONE_TTL_MS - 1;
        let normalized = normalize_workspace_resource_settings(Some(&json!({
            "/tmp/old-tombstone": {
                "mode": "inherit",
                "stateVersion": 1,
                "updatedAt": old
            },
            "/tmp/custom": {
                "mode": "custom",
                "skillNames": ["kept"],
                "stateVersion": 1,
                "updatedAt": old
            },
            "/tmp/off": {
                "mode": "off",
                "stateVersion": 1,
                "updatedAt": old
            },
            "/tmp/recent-tombstone": {
                "mode": "inherit",
                "stateVersion": 1,
                "updatedAt": now
            }
        })));
        let normalized = normalized.as_object().expect("normalized workspace resources");
        assert!(!normalized.contains_key("/tmp/old-tombstone"));
        assert_eq!(normalized["/tmp/custom"]["mode"], "custom");
        assert_eq!(normalized["/tmp/off"]["mode"], "off");
        assert_eq!(normalized["/tmp/recent-tombstone"]["mode"], "inherit");
    }

    #[test]
    fn workspace_resource_overflow_prefers_active_entries_and_newest_tombstones() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_millis() as u64;
        let mut entries = Map::new();
        for index in 0..250_u64 {
            entries.insert(
                format!("/tmp/tombstone-{index:03}"),
                json!({
                    "mode": "inherit",
                    "stateVersion": 1,
                    "updatedAt": now - index
                }),
            );
        }
        for index in 0..20_u64 {
            entries.insert(
                format!("/tmp/custom-{index:02}"),
                json!({
                    "mode": if index % 2 == 0 { "custom" } else { "off" },
                    "skillNames": [format!("skill-{index}")],
                    "stateVersion": 1,
                    "updatedAt": now - 1_000_000 - index
                }),
            );
        }
        let normalized = normalize_workspace_resource_settings(Some(&Value::Object(entries)));
        let normalized = normalized.as_object().expect("normalized workspace resources");
        assert_eq!(normalized.len(), MAX_WORKSPACE_RESOURCE_SETTINGS);
        for index in 0..20 {
            assert!(normalized.contains_key(&format!("/tmp/custom-{index:02}")));
        }
        assert!(normalized.contains_key("/tmp/tombstone-235"));
        assert!(!normalized.contains_key("/tmp/tombstone-236"));
    }

    #[test]
    fn workspace_resource_overflow_uses_unicode_code_point_ordering() {
        let mut entries = Map::new();
        for index in 0..253 {
            entries.insert(
                format!("/tmp/{index:03}"),
                json!({ "mode": "off", "stateVersion": 1, "updatedAt": 1 }),
            );
        }
        for suffix in ["A", "_", "a", "ä"] {
            entries.insert(
                format!("/tmp/{suffix}"),
                json!({ "mode": "off", "stateVersion": 1, "updatedAt": 1 }),
            );
        }
        let normalized = normalize_workspace_resource_settings(Some(&Value::Object(entries)));
        let normalized = normalized.as_object().expect("normalized workspace resources");
        assert_eq!(normalized.len(), MAX_WORKSPACE_RESOURCE_SETTINGS);
        assert!(normalized.contains_key("/tmp/A"));
        assert!(normalized.contains_key("/tmp/_"));
        assert!(normalized.contains_key("/tmp/a"));
        assert!(!normalized.contains_key("/tmp/ä"));
    }

    #[test]
    fn save_system_backfills_empty_workdir_with_default_project() {
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "",
            }),
            "/tmp/liveagent-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn).expect("load system");
        assert_eq!(
            loaded,
            Some(json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "archivedWorkspaceProjectPaths": [],
                "workspaceResourceSettings": {},
                "commandSafetyMode": "auto",
                "browserAutomationMode": "auto",
                "systemProxy": default_system_proxy_json(),
                "workdir": "/tmp/liveagent-default-project",
                "toolPolicies": null,
                "workspaceProjectGroups": null,
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/liveagent-default-project",
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                ]
            }))
        );
    }

    #[test]
    fn save_system_preserves_default_project_pin_metadata() {
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "/tmp/liveagent-default-project",
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/liveagent-default-project",
                        "kind": "managed",
                        "createdAt": 10,
                        "updatedAt": 20,
                        "isPinned": true,
                        "pinnedAt": 30
                    }
                ]
            }),
            "/tmp/liveagent-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn).expect("load system");
        assert_eq!(
            loaded,
            Some(json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "archivedWorkspaceProjectPaths": [],
                "workspaceResourceSettings": {},
                "commandSafetyMode": "auto",
                "browserAutomationMode": "auto",
                "systemProxy": default_system_proxy_json(),
                "workdir": "/tmp/liveagent-default-project",
                "toolPolicies": null,
                "workspaceProjectGroups": null,
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/liveagent-default-project",
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1,
                        "isPinned": true,
                        "pinnedAt": 30
                    }
                ]
            }))
        );
    }

    // P2#6:未识别的命令安全模式必须向严格侧(ask)收敛,不能静默降级成 auto ——
    // save_system 会把归一结果破坏性地写回磁盘。
    #[test]
    fn command_safety_mode_unrecognized_value_fails_closed_to_ask() {
        // 缺失 / null / 空串:正常缺省形态,沿用 auto。
        assert_eq!(normalize_command_safety_mode_value(None), json!("auto"));
        assert_eq!(
            normalize_command_safety_mode_value(Some(&Value::Null)),
            json!("auto")
        );
        assert_eq!(
            normalize_command_safety_mode_value(Some(&json!("   "))),
            json!("auto")
        );
        // 合法值原样保留(含空白裁剪)。
        for mode in ["ask", "auto", "sandbox", "sandboxOffline"] {
            assert_eq!(
                normalize_command_safety_mode_value(Some(&json!(format!(" {mode} ")))),
                json!(mode)
            );
        }
        // 未来新增的模式值 / 回退旧版本 / 手改笔误 / 类型错误:一律收敛到 ask。
        assert_eq!(
            normalize_command_safety_mode_value(Some(&json!("sandboxStrictest"))),
            json!("ask")
        );
        assert_eq!(
            normalize_command_safety_mode_value(Some(&json!("Auto"))),
            json!("ask")
        );
        assert_eq!(
            normalize_command_safety_mode_value(Some(&json!(1))),
            json!("ask")
        );
    }

    #[test]
    fn load_system_with_defaults_returns_agent_mode_and_default_project() {        let conn = open_memory_db();
        let loaded = load_system_with_defaults(&conn, "/tmp/liveagent-default-project")
            .expect("load system");

        assert_eq!(
            loaded,
            json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "archivedWorkspaceProjectPaths": [],
                "workspaceResourceSettings": {},
                "commandSafetyMode": "auto",
                "browserAutomationMode": "auto",
                "systemProxy": default_system_proxy_json(),
                "workdir": "/tmp/liveagent-default-project",
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/liveagent-default-project",
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                ]
            })
        );
    }

    #[test]
    fn expand_home_prefix_supports_bare_tilde() {
        let home = dirs::home_dir().expect("home dir available in tests");
        assert_eq!(expand_home_prefix("~"), home);
    }

    #[test]
    fn expand_home_prefix_supports_forward_slash() {
        let home = dirs::home_dir().expect("home dir available in tests");
        assert_eq!(
            expand_home_prefix("~/OneDrive/ccswitch"),
            home.join("OneDrive/ccswitch")
        );
    }

    #[test]
    fn expand_home_prefix_supports_windows_backslash() {
        let home = dirs::home_dir().expect("home dir available in tests");
        assert_eq!(
            expand_home_prefix("~\\OneDrive\\ccswitch"),
            home.join("OneDrive\\ccswitch")
        );
    }

    #[test]
    fn expand_home_prefix_passes_through_absolute_paths() {
        assert_eq!(
            expand_home_prefix("/data/ccswitch"),
            PathBuf::from("/data/ccswitch")
        );
        assert_eq!(
            expand_home_prefix("C:\\Users\\Alice\\ccswitch"),
            PathBuf::from("C:\\Users\\Alice\\ccswitch")
        );
    }

    #[cfg(windows)]
    #[test]
    fn ccswitch_db_candidates_include_home_env_fallback_on_windows() {
        // 候选列表必须覆盖 ccswitch v3.10.3 在 `%HOME%\.cc-switch\` 的遗留库位置。
        let previous = std::env::var("HOME").ok();
        std::env::set_var("HOME", "C:\\legacy-home");
        let candidates = ccswitch_db_candidates();
        match previous {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }

        let expected = PathBuf::from("C:\\legacy-home")
            .join(".cc-switch")
            .join("cc-switch.db");
        assert!(candidates.contains(&expected));
    }

    #[test]
    fn cherry_split_v1_api_keys_handles_escaped_commas() {
        assert_eq!(
            cherry_split_v1_api_keys(r"first\,part, second, ,third"),
            vec!["first,part", "second", "third"]
        );
    }

    #[test]
    fn cherry_manual_data_candidates_support_portable_and_nested_directories() {
        let root = tempfile::tempdir().expect("tempdir");
        let portable = root.path().join("CherryStudioPortable");
        let data = portable.join("data");
        let local_storage = data.join("Local Storage");
        let leveldb = local_storage.join("leveldb");

        let portable_candidates = cherry_manual_data_candidates(&portable);
        assert!(portable_candidates.contains(&portable));
        assert!(portable_candidates.contains(&data));

        let local_storage_candidates = cherry_manual_data_candidates(&local_storage);
        assert!(local_storage_candidates.contains(&data));

        let leveldb_candidates = cherry_manual_data_candidates(&leveldb);
        assert!(leveldb_candidates.contains(&data));
    }

    #[test]
    fn cherry_normalize_routed_base_url_removes_endpoint_marker() {
        assert_eq!(
            cherry_normalize_routed_base_url("https://example.test/v1/chat/completions#"),
            "https://example.test/v1"
        );
        assert_eq!(
            cherry_normalize_routed_base_url(
                "https://generativelanguage.googleapis.com/v1beta/models/demo:generateContent#"
            ),
            "https://generativelanguage.googleapis.com/v1beta/models/demo"
        );
    }

    #[test]
    fn cherry_v1_new_api_splits_chat_protocols_and_filters_non_chat_models() {
        let provider = json!({
            "id": "mixed-provider",
            "name": "Mixed API",
            "type": "new-api",
            "apiKey": "secret",
            "apiHost": "https://example.test/v1",
            "enabled": true,
            "models": [
                { "id": "gpt-chat", "endpoint_type": "openai-chat-completions", "type": ["text"] },
                { "id": "claude-chat", "endpoint_type": "anthropic-messages", "type": ["text"] },
                { "id": "text-embedding-3-small", "endpoint_type": "openai-chat-completions", "type": ["embedding"] }
            ]
        });
        let mut imported = Vec::new();

        cherry_append_v1_provider(&provider, "1.9.9", &mut imported);

        assert_eq!(imported.len(), 2);
        assert!(imported.iter().all(|item| item.importable));
        assert!(imported.iter().all(|item| item.api_key == "secret"));
        assert!(imported.iter().all(|item| item.excluded_model_count == 1));
        assert!(!cherry_model_is_chat_compatible(
            &json!({"type": ["image_generation"]}),
            "nano-banana"
        ));
        assert!(imported.iter().any(|item| {
            item.provider_type == "codex" && item.request_format == "openai-completions"
        }));
        assert!(imported
            .iter()
            .any(|item| item.provider_type == "claude_code"));
    }

    #[test]
    fn cherry_v1_routes_official_deepseek_chat_to_deepseek_provider() {
        let provider = json!({
            "id": "official-deepseek",
            "name": "DeepSeek Official",
            "type": "openai",
            "apiKey": "secret",
            "apiHost": "https://api.deepseek.com/v1/chat/completions#",
            "models": [
                { "id": "deepseek-chat", "endpoint_type": "openai-chat-completions", "type": ["text"] }
            ]
        });
        let mut imported = Vec::new();

        cherry_append_v1_provider(&provider, "1.9.9", &mut imported);

        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].provider_type, "deepseek");
        assert_eq!(imported[0].request_format, "openai-completions");
        assert_eq!(imported[0].base_url, "https://api.deepseek.com/v1");
    }

    #[test]
    fn cherry_v1_keeps_third_party_deepseek_model_in_codex_provider() {
        let provider = json!({
            "id": "aggregate-gateway",
            "name": "Aggregate Gateway",
            "type": "openai",
            "apiKey": "secret",
            "apiHost": "https://relay.example.test/v1",
            "models": [
                { "id": "deepseek-chat", "endpoint_type": "openai-chat-completions", "type": ["text"] }
            ]
        });
        let mut imported = Vec::new();

        cherry_append_v1_provider(&provider, "1.9.9", &mut imported);

        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].provider_type, "codex");
        assert_eq!(imported[0].request_format, "openai-completions");
    }

    #[test]
    fn ccs_maps_grokbuild_app_type_to_xai() {
        assert_eq!(
            ccs_provider_type_from_app_type("grokbuild"),
            Some("xai")
        );
        assert_eq!(ccs_provider_type_from_app_type("grok"), Some("xai"));
        assert_eq!(ccs_provider_type_from_app_type("xai"), Some("xai"));
        assert_eq!(ccs_provider_type_from_app_type("Grok-Build"), Some("xai"));
    }

    #[test]
    fn ccs_imports_deepseek_app_type_and_environment_fields() {
        let config = json!({
            "env": {
                "DEEPSEEK_BASE_URL": "https://api.deepseek.com/v1/",
                "DEEPSEEK_API_KEY": "sk-deepseek",
                "DEEPSEEK_MODEL": "deepseek-chat",
                "DEEPSEEK_REASONER_MODEL": "deepseek-reasoner"
            }
        });
        let item = ccs_provider_from_value(
            "deepseek-official",
            "deepseek",
            "DeepSeek Official",
            &config,
        )
        .expect("deepseek provider should import");

        assert_eq!(item.provider_type, "deepseek");
        assert_eq!(item.base_url, "https://api.deepseek.com/v1");
        assert_eq!(item.api_key, "sk-deepseek");
        assert_eq!(item.request_format, "openai-completions");
        assert_eq!(item.models, vec!["deepseek-chat", "deepseek-reasoner"]);
    }

    #[test]
    fn ccs_reclassifies_only_official_deepseek_codex_chat_configs() {
        let official = json!({
            "auth": { "OPENAI_API_KEY": "sk-official" },
            "config": "model = \"deepseek-chat\"\nmodel_provider = \"deepseek\"\n\n[model_providers.deepseek]\nbase_url = \"https://api.deepseek.com/v1\"\nwire_api = \"chat\"\n"
        });
        let aggregate = json!({
            "auth": { "OPENAI_API_KEY": "sk-relay" },
            "config": "model = \"deepseek-chat\"\nmodel_provider = \"relay\"\n\n[model_providers.relay]\nbase_url = \"https://relay.example.test/v1\"\nwire_api = \"chat\"\n"
        });

        let official_item =
            ccs_provider_from_value("official", "codex", "Official", &official)
                .expect("official config should import");
        let aggregate_item =
            ccs_provider_from_value("aggregate", "codex", "Aggregate", &aggregate)
                .expect("aggregate config should import");

        assert_eq!(official_item.provider_type, "deepseek");
        assert_eq!(official_item.request_format, "openai-completions");
        assert_eq!(aggregate_item.provider_type, "codex");
        assert_eq!(aggregate_item.request_format, "openai-completions");
    }

    #[test]
    fn ccs_imports_grokbuild_toml_config_fields() {
        // 与 CC-Switch Grok Build 写入 providers.settings_config 的形状对齐：
        // config 是 TOML 文本，含 [models].default 与 [model."<id>"] 表。
        let config = json!({
            "config": "[models]\ndefault = \"grok-4.5\"\n\n[model]\n[model.\"grok-4.5\"]\nmodel = \"grok-4.5\"\nbase_url = \"https://api.x.ai/v1\"\nname = \"packy\"\napi_backend = \"responses\"\ncontext_window = 500000\napi_key = \"sk-test-key\"\n"
        });
        let item = ccs_provider_from_value(
            "d262e762-test",
            "grokbuild",
            "PackyCode",
            &config,
        )
        .expect("grokbuild provider should import");

        assert_eq!(item.provider_type, "xai");
        assert_eq!(item.app_type, "grokbuild");
        assert_eq!(item.base_url, "https://api.x.ai/v1");
        assert_eq!(item.api_key, "sk-test-key");
        assert_eq!(item.request_format, "openai-responses");
        assert!(item.models.iter().any(|m| m == "grok-4.5"));
    }

    #[test]
    fn ccs_imports_empty_official_grokbuild_seed() {
        let config = json!({ "config": "" });
        let item = ccs_provider_from_value(
            "grokbuild-official",
            "grokbuild",
            "Grok Official",
            &config,
        )
        .expect("official grok seed should still map");
        assert_eq!(item.provider_type, "xai");
        assert_eq!(item.base_url, "");
        assert_eq!(item.api_key, "");
        assert_eq!(item.request_format, "openai-responses");
    }

    // ===== 配置备份：采集 / 校验 / 应用 =====

    fn sample_backup_document() -> String {
        let snapshot = BackupSnapshot {
            providers: Some(json!([{ "id": "p-1", "name": "P1", "apiKey": "sk-plain" }])),
            mcp: Some(json!({ "servers": [{ "id": "s-1" }], "selected": ["s-1"] })),
            system: Some(json!({ "executionMode": "tools" })),
            skills: Some(json!({ "enabled": true, "selected": ["skill-a"] })),
        };
        let manifest = build_backup_manifest(&snapshot);
        serialize_backup_document(&snapshot, &manifest).expect("serialize document")
    }

    #[test]
    fn backup_document_round_trips_all_four_domains() {
        let raw = sample_backup_document();
        let (snapshot, manifest) = parse_backup_document(&raw).expect("parse document");

        assert_eq!(manifest.protocol_version, BACKUP_PROTOCOL_VERSION);
        assert_eq!(manifest.schema_version, BACKUP_SCHEMA_VERSION);
        assert_eq!(manifest.encryption, "none");
        // 计数用于 UI 摘要：mcp 数服务器条目，skills 数选中项。
        assert_eq!(manifest.domains.providers, 1);
        assert_eq!(manifest.domains.mcp, 1);
        assert_eq!(manifest.domains.skills, 1);
        assert_eq!(
            snapshot.skills,
            Some(json!({ "enabled": true, "selected": ["skill-a"] }))
        );
    }

    #[test]
    fn parse_backup_document_rejects_future_versions() {
        // 高版本必须拒绝，而不是把读不懂的域当成「空配置」写入而静默清库。
        for field in ["protocolVersion", "schemaVersion"] {
            let mut document: Value =
                serde_json::from_str(&sample_backup_document()).expect("parse json");
            document["_manifest"][field] = json!(99);
            let err = parse_backup_document(&document.to_string())
                .expect_err("future version must be rejected");
            assert!(err.contains("99"), "错误信息应含版本号：{err}");
        }
    }

    #[test]
    fn parse_backup_document_rejects_unknown_encryption() {
        let mut document: Value =
            serde_json::from_str(&sample_backup_document()).expect("parse json");
        document["_manifest"]["encryption"] = json!("aes-256-gcm");

        let err = parse_backup_document(&document.to_string())
            .expect_err("unknown encryption must be rejected");
        assert!(err.contains("aes-256-gcm"), "错误信息应含加密方式：{err}");
    }

    #[test]
    fn parse_backup_document_rejects_missing_manifest_and_malformed_domains() {
        // 缺 manifest：可能是随便一个 JSON 文件，不是我们导出的备份。
        let err = parse_backup_document(r#"{"providers": []}"#).expect_err("manifest required");
        assert!(err.contains("元信息"), "应提示缺少元信息：{err}");

        // 域结构不符：providers 必须是数组。
        let mut document: Value =
            serde_json::from_str(&sample_backup_document()).expect("parse json");
        document["providers"] = json!({ "not": "an array" });
        let err =
            parse_backup_document(&document.to_string()).expect_err("providers must be an array");
        assert!(err.contains("providers"), "应指出出错的域：{err}");
    }

    #[test]
    fn backup_snapshot_excludes_device_level_sync_config() {
        // 同步配置（WebDAV 地址/凭据）是设备级的，若随快照流转会让 A 机器的
        // 凭据覆盖 B 机器。它刻意存放在独立表，因此采集时天然取不到。
        //
        // 这条断言只有在库里**确实存着**一份凭据、且快照本身非空时才有意义：
        // 对着空库采集，快照里当然搜不到密码，字段真被塞进去也照样通过。
        let conn = open_memory_db();
        let credentials = BackupSyncConfig {
            url: "https://dav.example.com/dav/".to_string(),
            username: "sentinel-user@example.com".to_string(),
            password: "sentinel-password-must-not-leak".to_string(),
            remote_dir: "liveagent".to_string(),
            profile: "default".to_string(),
            auto_sync: true,
            last_sync_at: Some(1_700_000_000_000),
            last_error: Some("sentinel-error".to_string()),
        };
        persist_backup_sync_config(&conn, &credentials).expect("persist sync config");
        // 前提自检：凭据确实进了库，否则下面的断言又变回空转。
        assert_eq!(
            load_backup_sync_config(&conn)
                .expect("reload sync config")
                .password,
            "sentinel-password-must-not-leak"
        );

        let mut conn = conn;
        save_providers(&mut conn, json!([{ "id": "p-1", "name": "P1" }])).expect("seed providers");
        save_mcp(&mut conn, json!({ "servers": [], "selected": [] })).expect("seed mcp");

        let snapshot = collect_backup_snapshot(&conn, None).expect("collect snapshot");
        let serialized = serde_json::to_string(&snapshot).expect("serialize snapshot");
        assert!(snapshot.providers.is_some(), "前提：快照非空");

        assert!(!serialized.contains("backupSync"), "快照不应含同步配置");
        for leaked in [
            "sentinel-password-must-not-leak",
            "sentinel-user@example.com",
            "dav.example.com",
            "sentinel-error",
        ] {
            assert!(
                !serialized.contains(leaked),
                "快照泄漏了设备级同步配置字段 {leaked}：{serialized}"
            );
        }
        assert!(snapshot.skills.is_none(), "skills 只能由前端传入");
    }

    #[test]
    fn normalize_sync_config_strips_dot_segments() {
        // `..` 不在 `join_url` 的 percent-encode 集合里，会原样留在 URL 路径中
        // 由服务器解析为上级目录，请求因此可以打到 WebDAV 根之外。
        let normalized = normalize_backup_sync_config(BackupSyncConfig {
            remote_dir: "../../etc".to_string(),
            profile: "a/../../b".to_string(),
            ..BackupSyncConfig::default()
        });
        assert_eq!(normalized.remote_dir, "etc");
        assert_eq!(normalized.profile, "a/b");

        // 全被剥掉时回落默认值，而不是留空拼出畸形 URL。
        let emptied = normalize_backup_sync_config(BackupSyncConfig {
            remote_dir: "..".to_string(),
            profile: "./.".to_string(),
            ..BackupSyncConfig::default()
        });
        assert_eq!(emptied.remote_dir, WEBDAV_DEFAULT_REMOTE_DIR);
        assert_eq!(emptied.profile, WEBDAV_DEFAULT_PROFILE);
    }

    #[test]
    fn apply_backup_snapshot_to_db_overwrites_all_domains() {
        let mut conn = open_memory_db();
        save_providers(&mut conn, json!([{ "id": "stale", "name": "Stale" }]))
            .expect("seed providers");

        let snapshot = BackupSnapshot {
            providers: Some(json!([{ "id": "p-1", "name": "P1" }])),
            mcp: Some(json!({ "servers": [{ "id": "s-1" }], "selected": ["s-1"] })),
            system: None,
            skills: None,
        };
        apply_backup_snapshot_to_db(&mut conn, &snapshot).expect("apply snapshot");

        // 整域覆盖：导入侧原有的 stale provider 必须消失。
        assert_eq!(
            load_providers(&conn).expect("load providers"),
            Some(json!([{ "id": "p-1", "name": "P1" }]))
        );
        let mcp = load_mcp(&conn).expect("load mcp").expect("mcp present");
        assert_eq!(mcp["selected"], json!(["s-1"]));
    }

    #[test]
    fn apply_backup_snapshot_to_db_leaves_config_intact_when_domain_absent() {
        // 某域为 None 表示导出侧没有该配置，不应被当成「清空」。
        let mut conn = open_memory_db();
        save_providers(&mut conn, json!([{ "id": "keep", "name": "Keep" }]))
            .expect("seed providers");

        apply_backup_snapshot_to_db(&mut conn, &BackupSnapshot::default()).expect("apply empty");

        assert_eq!(
            load_providers(&conn).expect("load providers"),
            Some(json!([{ "id": "keep", "name": "Keep" }]))
        );
    }

    #[test]
    fn validate_backup_snapshot_rejects_malformed_domains() {
        let cases = [
            (
                BackupSnapshot {
                    providers: Some(json!({})),
                    ..Default::default()
                },
                "providers",
            ),
            (
                BackupSnapshot {
                    mcp: Some(json!({ "servers": "nope" })),
                    ..Default::default()
                },
                "mcp.servers",
            ),
            (
                BackupSnapshot {
                    system: Some(json!([])),
                    ..Default::default()
                },
                "system",
            ),
            (
                BackupSnapshot {
                    skills: Some(json!("nope")),
                    ..Default::default()
                },
                "skills",
            ),
        ];

        for (snapshot, expected) in cases {
            let err =
                validate_backup_snapshot(&snapshot).expect_err("malformed domain must be rejected");
            assert!(err.contains(expected), "错误信息应含 {expected}：{err}");
        }
    }

    // ===== WebDAV 同步：配置解析 / 远端路径 / 完整性校验 =====

    fn sample_sync_config() -> BackupSyncConfig {
        BackupSyncConfig {
            url: "https://dav.example.com/dav".to_string(),
            username: "alice".to_string(),
            password: "stored-secret".to_string(),
            remote_dir: "liveagent".to_string(),
            profile: "work".to_string(),
            auto_sync: false,
            last_sync_at: Some(1_700_000_000_000),
            last_error: None,
        }
    }

    fn sync_request(password: &str, password_touched: bool) -> BackupSyncConfigRequest {
        BackupSyncConfigRequest {
            url: "https://dav.example.com/dav".to_string(),
            username: "alice".to_string(),
            password: password.to_string(),
            password_touched,
            remote_dir: "liveagent".to_string(),
            profile: "work".to_string(),
            auto_sync: true,
        }
    }

    #[test]
    fn sync_config_keeps_stored_password_when_untouched() {
        let persisted = sample_sync_config();
        // UI 用掩码占位符回填密码框；用户没动它时不能当成新密码写库。
        let resolved = resolve_backup_sync_config(sync_request("••••••••", false), &persisted);
        assert_eq!(resolved.password, "stored-secret");
        assert!(resolved.auto_sync);
        // 保存配置不应改动同步时间。
        assert_eq!(resolved.last_sync_at, persisted.last_sync_at);
    }

    #[test]
    fn sync_config_takes_new_password_when_touched() {
        let persisted = sample_sync_config();
        let resolved = resolve_backup_sync_config(sync_request("fresh-secret", true), &persisted);
        assert_eq!(resolved.password, "fresh-secret");
    }

    #[test]
    fn sync_config_clearing_password_is_honored() {
        let persisted = sample_sync_config();
        // 用户主动清空密码框 —— 必须真的清掉，不能回退到旧值，否则无法换账号。
        let resolved = resolve_backup_sync_config(sync_request("", true), &persisted);
        assert!(resolved.password.is_empty());
    }

    /// 保存配置必须清掉遗留的自动同步错误。
    ///
    /// 那条错误描述的是改动**之前**的配置状态；继续挂在界面上，用户会以为
    /// 刚填好的新地址也是坏的，从而反复折腾一个已经修好的问题。
    #[test]
    fn sync_config_save_clears_stale_auto_sync_error() {
        let mut persisted = sample_sync_config();
        persisted.last_error = Some("认证失败（401）：请检查用户名与密码".to_string());

        let resolved = resolve_backup_sync_config(sync_request("fresh-secret", true), &persisted);
        assert!(resolved.last_error.is_none(), "保存后不应残留旧错误");
        // 同步时间是既成事实，不能跟着一起清掉。
        assert_eq!(resolved.last_sync_at, persisted.last_sync_at);
    }

    #[test]
    fn sync_config_normalizes_paths_and_falls_back_to_defaults() {
        let persisted = BackupSyncConfig::default();
        let mut request = sync_request("x", true);
        request.url = "  https://dav.example.com/dav/  ".to_string();
        request.remote_dir = "  /backups/  ".to_string();
        request.profile = "   ".to_string();

        let resolved = resolve_backup_sync_config(request, &persisted);
        assert_eq!(resolved.url, "https://dav.example.com/dav");
        assert_eq!(resolved.remote_dir, "backups");
        // 空 profile 回落默认值，否则远端路径会出现空段。
        assert_eq!(resolved.profile, "default");
    }

    #[test]
    fn remote_segments_are_versioned_and_profile_scoped() {
        let config = sample_sync_config();
        assert_eq!(
            backup_remote_segments(&config),
            vec!["liveagent", "v1", "work"]
        );
        assert_eq!(
            backup_remote_file_segments(&config, "config.json"),
            vec!["liveagent", "v1", "work", "config.json"]
        );
        // 不同 profile 必须落在不同远端目录，否则两套配置会互相覆盖。
        let mut other = sample_sync_config();
        other.profile = "personal".to_string();
        assert_ne!(
            backup_remote_segments(&config),
            backup_remote_segments(&other)
        );
    }

    #[test]
    fn verify_payload_accepts_matching_size_and_hash() {
        let body = b"{\"providers\":[]}";
        let sha = backup_sha256_hex(body);
        assert!(verify_backup_payload(body, body.len(), &sha).is_ok());
    }

    #[test]
    fn verify_payload_rejects_truncated_or_corrupted_body() {
        let body = b"{\"providers\":[]}";
        let sha = backup_sha256_hex(body);

        // PUT 中断留下的截断文件。
        let truncated = verify_backup_payload(body, body.len() + 8, &sha)
            .expect_err("size mismatch must be rejected");
        assert!(truncated.contains("大小校验失败"), "{truncated}");

        let corrupted = verify_backup_payload(body, body.len(), &"0".repeat(64))
            .expect_err("hash mismatch must be rejected");
        assert!(corrupted.contains("校验和不匹配"), "{corrupted}");
    }

    #[test]
    fn verify_payload_rejects_manifest_without_size_or_hash() {
        // 缺 size/sha256 不能当「无需校验」放行。`v1/` 布局随本功能一起引入，
        // 没有写过无摘要 manifest 的历史版本，会命中这里的只有异常数据。
        let err = verify_backup_payload(b"anything", 0, "")
            .expect_err("manifest without size/sha256 must be rejected");
        assert!(err.contains("缺少大小或校验和"), "{err}");

        assert!(verify_backup_payload(b"anything", 8, "").is_err());
        assert!(verify_backup_payload(b"anything", 0, "abc").is_err());
    }

    #[test]
    fn remote_manifest_carries_size_and_hash_and_validates_version() {
        let snapshot = BackupSnapshot {
            providers: Some(json!([{ "id": "p-1" }])),
            ..Default::default()
        };
        let manifest = build_backup_manifest(&snapshot);
        let body = json!({
            "protocolVersion": manifest.protocol_version,
            "schemaVersion": manifest.schema_version,
            "snapshotId": manifest.snapshot_id,
            "createdAt": manifest.created_at,
            "deviceName": "box-a",
            "appVersion": manifest.app_version,
            "encryption": "none",
            "domains": { "providers": 1, "mcp": 0, "system": 0, "skills": 0 },
            "size": 42,
            "sha256": "abc123",
        })
        .to_string();

        let parsed = parse_backup_remote_manifest(body.as_bytes()).expect("parse remote manifest");
        assert_eq!(parsed.size, 42);
        assert_eq!(parsed.sha256, "abc123");
        assert_eq!(parsed.manifest.device_name, "box-a");
    }

    #[test]
    fn remote_manifest_rejects_future_protocol_version() {
        let body = json!({
            "protocolVersion": 99,
            "schemaVersion": 1,
            "snapshotId": "s-1",
            "createdAt": "2026-08-17T00:00:00Z",
            "deviceName": "box-a",
            "appVersion": "1.0.0",
            "encryption": "none",
            "size": 1,
            "sha256": "ab",
        })
        .to_string();

        let err = parse_backup_remote_manifest(body.as_bytes())
            .expect_err("future protocol version must be rejected");
        assert!(err.contains("升级应用"), "{err}");
    }

    #[test]
    fn sync_config_view_never_exposes_password() {
        let view: BackupSyncConfigView = sample_sync_config().into();
        let serialized = serde_json::to_string(&view).expect("serialize view");
        assert!(!serialized.contains("stored-secret"), "{serialized}");
        assert!(!serialized.contains("password\":"), "{serialized}");
        assert!(view.has_password);

        let empty = BackupSyncConfigView::from(BackupSyncConfig::default());
        assert!(!empty.has_password);
    }

    /// `last_error` 要能穿过「序列化落库 → 反序列化读回」这条来回。
    ///
    /// 它是自动同步失败在页面卸载后唯一的留存处，序列化时丢掉就等于没做。
    #[test]
    fn sync_config_persists_auto_sync_error_across_serialization() {
        let mut config = sample_sync_config();
        config.last_error = Some("远端存储空间不足".to_string());

        let json = serde_json::to_string(&config).expect("serialize config");
        let restored: BackupSyncConfig = serde_json::from_str(&json).expect("deserialize config");
        assert_eq!(restored.last_error.as_deref(), Some("远端存储空间不足"));

        // 旧版本写入的记录没有这个字段，读回时必须回落 None 而不是解析失败。
        let legacy = r#"{"url":"https://dav.example.com/dav","username":"alice",
            "password":"s","remoteDir":"liveagent","profile":"work","autoSync":true}"#;
        let parsed: BackupSyncConfig = serde_json::from_str(legacy).expect("parse legacy payload");
        assert!(parsed.last_error.is_none());
        assert!(parsed.last_sync_at.is_none());

        // 错误必须随视图送到前端，否则 UI 仍然看不到。
        let view: BackupSyncConfigView = config.into();
        assert_eq!(view.last_error.as_deref(), Some("远端存储空间不足"));
    }

    /// 真实服务器上的「两台设备」往返。**默认不跑**（`#[ignore]`）。
    ///
    /// ```text
    /// LIVEAGENT_WEBDAV_URL=... LIVEAGENT_WEBDAV_USER=... LIVEAGENT_WEBDAV_PASS=... \
    /// cargo test --lib settings::tests::live -- --ignored --nocapture
    /// ```
    ///
    /// 为什么不直接调 `settings_backup_upload` / `settings_backup_download`：
    /// 那两个命令读写真实的 `~/.liveagent/config.sqlite`，跑测试会改掉开发者
    /// 自己的配置。这里用两个内存库扮演设备 A / B，复用同一套采集、序列化、
    /// manifest 构造与校验函数，网络部分则完全走真实 `services::webdav`。
    /// 因此覆盖的是 AC7（跨设备一致）与 AC9（校验和把关），而非命令壳。
    #[tokio::test]
    #[ignore = "需要真实 WebDAV 账号，通过 LIVEAGENT_WEBDAV_* 环境变量提供"]
    async fn live_cross_device_snapshot_round_trip() {
        let (Ok(url), Ok(username), Ok(password)) = (
            std::env::var("LIVEAGENT_WEBDAV_URL"),
            std::env::var("LIVEAGENT_WEBDAV_USER"),
            std::env::var("LIVEAGENT_WEBDAV_PASS"),
        ) else {
            eprintln!("跳过：未设置 LIVEAGENT_WEBDAV_URL / _USER / _PASS");
            return;
        };

        let config = BackupSyncConfig {
            url,
            username,
            password,
            remote_dir: format!("liveagent-livetest-{}", std::process::id()),
            profile: "default".to_string(),
            auto_sync: false,
            last_sync_at: None,
            last_error: None,
        };
        let creds = backup_credentials(&config).expect("credentials");

        // —— 设备 A：采集并上传 ——
        let mut device_a = open_memory_db();
        save_providers(
            &mut device_a,
            json!([{ "id": "p-live", "name": "实机 Provider", "apiKey": "sk-live-probe" }]),
        )
        .expect("seed providers on device A");
        save_mcp(
            &mut device_a,
            json!({ "servers": [{ "id": "s-live" }], "selected": ["s-live"] }),
        )
        .expect("seed mcp on device A");

        let snapshot = collect_backup_snapshot(&device_a, Some(json!({ "enabled": ["skill-x"] })))
            .expect("collect snapshot");
        let manifest = build_backup_manifest(&snapshot);
        let document = serialize_backup_document(&snapshot, &manifest).expect("serialize");
        let body = document.into_bytes();

        let remote_manifest_body = serde_json::to_vec_pretty(&json!({
            "protocolVersion": manifest.protocol_version,
            "schemaVersion": manifest.schema_version,
            "snapshotId": manifest.snapshot_id,
            "createdAt": manifest.created_at,
            "deviceName": manifest.device_name,
            "appVersion": manifest.app_version,
            "encryption": "none",
            "domains": {
                "providers": 1, "mcp": 1, "system": 0, "skills": 1,
            },
            "size": body.len(),
            "sha256": backup_sha256_hex(&body),
        }))
        .expect("serialize remote manifest");

        crate::services::webdav::ensure_remote_dirs(&creds, &backup_remote_segments(&config))
            .await
            .expect("ensure remote dirs");
        // 与生产同序：先 config 再 manifest。
        crate::services::webdav::put_bytes(
            &creds,
            &backup_remote_file_segments(&config, WEBDAV_CONFIG_FILENAME),
            body.clone(),
            "application/json",
        )
        .await
        .expect("put config.json");
        crate::services::webdav::put_bytes(
            &creds,
            &backup_remote_file_segments(&config, WEBDAV_MANIFEST_FILENAME),
            remote_manifest_body,
            "application/json",
        )
        .await
        .expect("put manifest.json");
        eprintln!("上传完成：config {} 字节", body.len());

        // —— 设备 B：拉 manifest → 拉 config → 校验 → 应用 ——
        let manifest_bytes = crate::services::webdav::get_bytes(
            &creds,
            &backup_remote_file_segments(&config, WEBDAV_MANIFEST_FILENAME),
            WEBDAV_MANIFEST_MAX_BYTES,
            "远端备份元信息",
        )
        .await
        .expect("get manifest")
        .expect("manifest 必须存在");
        let remote = parse_backup_remote_manifest(&manifest_bytes).expect("parse remote manifest");
        eprintln!(
            "远端 manifest：设备 {} / {} 字节",
            remote.manifest.device_name, remote.size
        );

        let config_bytes = crate::services::webdav::get_bytes(
            &creds,
            &backup_remote_file_segments(&config, WEBDAV_CONFIG_FILENAME),
            WEBDAV_CONFIG_MAX_BYTES,
            "远端配置",
        )
        .await
        .expect("get config")
        .expect("config 必须存在");

        // AC9 正向：真实服务器往返后校验和必须仍然吻合。
        verify_backup_payload(&config_bytes, remote.size, &remote.sha256)
            .expect("真实往返后校验和应吻合");
        eprintln!("校验通过：sha256 {}", &remote.sha256[..16]);

        // AC9 反向：篡改一个字节必须被拦下。
        let mut tampered = config_bytes.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        let err = verify_backup_payload(&tampered, remote.size, &remote.sha256)
            .expect_err("篡改后必须校验失败");
        assert!(err.contains("校验和不匹配"), "{err}");

        // AC7：应用到设备 B，四域应与设备 A 一致。
        let text = String::from_utf8(config_bytes).expect("utf-8 config");
        let (parsed_snapshot, _) = parse_backup_document(&text).expect("parse document");
        let mut device_b = open_memory_db();
        save_providers(&mut device_b, json!([{ "id": "stale-b", "name": "旧配置" }]))
            .expect("seed providers on device B");
        apply_backup_snapshot_to_db(&mut device_b, &parsed_snapshot).expect("apply on device B");

        assert_eq!(
            load_providers(&device_b).expect("load providers on B"),
            load_providers(&device_a).expect("load providers on A"),
            "设备 B 的 providers 应与设备 A 一致"
        );
        assert_eq!(
            load_mcp(&device_b).expect("load mcp on B"),
            load_mcp(&device_a).expect("load mcp on A"),
            "设备 B 的 mcp 应与设备 A 一致"
        );
        // 技能启用态不落库，只随快照回传给前端。
        assert_eq!(
            parsed_snapshot.skills,
            Some(json!({ "enabled": ["skill-x"] })),
            "skills 应原样往返"
        );
        // 设备级凭据绝不能随快照流转（S2）。
        assert!(
            !text.contains(&config.username),
            "快照不得含 WebDAV 用户名"
        );
        assert!(!text.contains("backupSync"), "快照不得含同步配置");
        eprintln!("设备 B 还原一致，且快照不含 WebDAV 凭据");
    }
}
