fn validate_ssh_auth_type(value: Option<&Value>, label: &str) -> Result<String, String> {
    let auth_type = value
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("password");
    match auth_type {
        "password" | "privateKey" | "keyboardInteractive" => Ok(auth_type.to_string()),
        other => Err(format!("{label}.authType 不支持：{other}")),
    }
}

fn validate_ssh_port(value: Option<&Value>, label: &str) -> Result<i64, String> {
    let port = match value {
        Some(Value::Number(number)) => number
            .as_i64()
            .ok_or_else(|| format!("{label}.port 必须是 1-65535 的整数"))?,
        Some(Value::String(text)) if text.trim().is_empty() => 22,
        Some(Value::String(text)) => text
            .trim()
            .parse::<i64>()
            .map_err(|_| format!("{label}.port 必须是 1-65535 的整数"))?,
        Some(Value::Null) | None => 22,
        Some(_) => return Err(format!("{label}.port 必须是 1-65535 的整数")),
    };

    if (1..=65535).contains(&port) {
        Ok(port)
    } else {
        Err(format!("{label}.port 必须是 1-65535 的整数"))
    }
}

fn validate_ssh_proxy_port(value: Option<&Value>, label: &str) -> Result<i64, String> {
    let port = match value {
        Some(Value::Number(number)) => number
            .as_i64()
            .ok_or_else(|| format!("{label}.port 必须是 0 或 1-65535 的整数"))?,
        Some(Value::String(text)) if text.trim().is_empty() => 0,
        Some(Value::String(text)) => text
            .trim()
            .parse::<i64>()
            .map_err(|_| format!("{label}.port 必须是 0 或 1-65535 的整数"))?,
        Some(Value::Null) | None => 0,
        Some(_) => return Err(format!("{label}.port 必须是 0 或 1-65535 的整数")),
    };

    if port == 0 || (1..=65535).contains(&port) {
        Ok(port)
    } else {
        Err(format!("{label}.port 必须是 0 或 1-65535 的整数"))
    }
}

fn validate_ssh_proxy_type(value: Option<&Value>, label: &str) -> Result<String, String> {
    let proxy_type = match value {
        Some(Value::String(text)) if text.trim() == "http" => "http",
        Some(Value::String(text)) if text.trim().is_empty() || text.trim() == "socks5" => "socks5",
        Some(Value::Null) | None => "socks5",
        _ => return Err(format!("{label}.type 必须是 socks5 或 http")),
    };
    Ok(proxy_type.to_string())
}

fn validate_and_normalize_ssh_proxy(
    proxy: Option<&Value>,
    label: &str,
) -> Result<Map<String, Value>, String> {
    let proxy = match proxy {
        Some(Value::Object(map)) => map,
        Some(Value::Null) | None => {
            let mut payload = Map::new();
            payload.insert("type".to_string(), Value::String("socks5".to_string()));
            payload.insert("url".to_string(), Value::String(String::new()));
            payload.insert("port".to_string(), Value::Number(Number::from(0)));
            payload.insert("username".to_string(), Value::String(String::new()));
            payload.insert("password".to_string(), Value::String(String::new()));
            payload.insert("passwordConfigured".to_string(), Value::Bool(false));
            return Ok(payload);
        }
        Some(_) => return Err(format!("{label}.proxy 必须是对象")),
    };
    let proxy_label = format!("{label}.proxy");
    let proxy_type = validate_ssh_proxy_type(proxy.get("type"), &proxy_label)?;
    let url = extract_optional_string(proxy, "url");
    let port = validate_ssh_proxy_port(proxy.get("port"), &proxy_label)?;
    let username = extract_optional_string(proxy, "username");
    let password = extract_optional_string(proxy, "password");
    let password_configured =
        extract_bool_with_default(proxy, "passwordConfigured", &proxy_label, false)?
            || !password.is_empty();

    let mut payload = Map::new();
    payload.insert("type".to_string(), Value::String(proxy_type));
    payload.insert("url".to_string(), Value::String(url));
    payload.insert("port".to_string(), Value::Number(Number::from(port)));
    payload.insert("username".to_string(), Value::String(username));
    payload.insert("password".to_string(), Value::String(password));
    payload.insert(
        "passwordConfigured".to_string(),
        Value::Bool(password_configured),
    );
    Ok(payload)
}

fn validate_and_normalize_ssh_host(
    host: Map<String, Value>,
    label: &str,
) -> Result<(String, Map<String, Value>), String> {
    let host_id = extract_non_empty_string(&host, "id", label)?;
    let name = extract_non_empty_string(&host, "name", label)?;
    let hostname = extract_non_empty_string(&host, "host", label)?;
    let auth_type = validate_ssh_auth_type(host.get("authType"), label)?;
    let port = validate_ssh_port(host.get("port"), label)?;
    let username = extract_optional_string(&host, "username");
    let description = extract_optional_string(&host, "description");
    let password = extract_optional_string(&host, "password");
    let private_key = extract_optional_string(&host, "privateKey");
    let private_key_path = extract_optional_string(&host, "privateKeyPath");
    let private_key_passphrase = extract_optional_string(&host, "privateKeyPassphrase");
    let is_keyboard_interactive_auth = auth_type == "keyboardInteractive";
    let password = if is_keyboard_interactive_auth {
        String::new()
    } else {
        password
    };
    let private_key = if is_keyboard_interactive_auth {
        String::new()
    } else {
        private_key
    };
    let private_key_path = if is_keyboard_interactive_auth {
        String::new()
    } else {
        private_key_path
    };
    let private_key_passphrase = if is_keyboard_interactive_auth {
        String::new()
    } else {
        private_key_passphrase
    };
    let password_configured = !is_keyboard_interactive_auth
        && (extract_bool_with_default(&host, "passwordConfigured", label, false)?
            || !password.is_empty());
    let private_key_configured = !is_keyboard_interactive_auth
        && (extract_bool_with_default(&host, "privateKeyConfigured", label, false)?
            || !private_key.is_empty()
            || !private_key_path.is_empty());
    let private_key_passphrase_configured = !is_keyboard_interactive_auth
        && (extract_bool_with_default(&host, "privateKeyPassphraseConfigured", label, false)?
            || !private_key_passphrase.is_empty());
    let proxy = validate_and_normalize_ssh_proxy(host.get("proxy"), label)?;

    let mut payload = Map::new();
    payload.insert("name".to_string(), Value::String(name));
    payload.insert("description".to_string(), Value::String(description));
    payload.insert("host".to_string(), Value::String(hostname));
    payload.insert("port".to_string(), Value::Number(Number::from(port)));
    payload.insert("username".to_string(), Value::String(username));
    payload.insert("authType".to_string(), Value::String(auth_type));
    payload.insert("password".to_string(), Value::String(password));
    payload.insert(
        "passwordConfigured".to_string(),
        Value::Bool(password_configured),
    );
    payload.insert("privateKey".to_string(), Value::String(private_key));
    payload.insert(
        "privateKeyPath".to_string(),
        Value::String(private_key_path),
    );
    payload.insert(
        "privateKeyConfigured".to_string(),
        Value::Bool(private_key_configured),
    );
    payload.insert(
        "privateKeyPassphrase".to_string(),
        Value::String(private_key_passphrase),
    );
    payload.insert(
        "privateKeyPassphraseConfigured".to_string(),
        Value::Bool(private_key_passphrase_configured),
    );
    payload.insert("proxy".to_string(), Value::Object(proxy));

    Ok((host_id, payload))
}

