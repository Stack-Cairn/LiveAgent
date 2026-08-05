fn error_json(
    code: &str,
    message: &str,
    suggested_next_call: Option<Value>,
    candidates: Option<Vec<Value>>,
) -> String {
    let mut value = json!({
        "error": code,
        "message": message
    });
    if let Some(suggested_next_call) = suggested_next_call {
        value["suggested_next_call"] = suggested_next_call;
    }
    if let Some(candidates) = candidates {
        value["candidates"] = Value::Array(candidates);
    }
    serde_json::to_string(&value).unwrap_or_else(|_| message.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RiskClass {
    None,
    Soft,
    Hard,
}

fn classify_risk(body: &str) -> RiskClass {
    let hard_patterns = [
        r"-----BEGIN .* PRIVATE KEY-----",
        r"AKIA[0-9A-Z]{16}",
        r"sk-ant-api03-[0-9A-Za-z-_]{40,}",
        r"ghp_[0-9A-Za-z]{36}",
        r"xoxb-[0-9A-Za-z-]+",
        r"github_pat_[0-9A-Za-z_]{82,}",
    ];
    for pattern in hard_patterns {
        if Regex::new(pattern)
            .expect("valid hard risk regex")
            .is_match(body)
        {
            return RiskClass::Hard;
        }
    }
    let soft_patterns = [
        r"(?i)bypass\s+auth|disable\s+validation|override\s+safety|ignore\s+previous\s+instructions",
        r"(?i)\bsudo\b|\bexec\s*\(|\beval\s*\(|--no-verify",
    ];
    for pattern in soft_patterns {
        if Regex::new(pattern)
            .expect("valid soft risk regex")
            .is_match(body)
        {
            return RiskClass::Soft;
        }
    }
    RiskClass::None
}

fn apply_risk_policy(slug: &str, body: &str, options: &mut WriteOptions) -> Result<(), String> {
    match classify_risk(body) {
        RiskClass::None => Ok(()),
        RiskClass::Soft => {
            options.unreviewed = true;
            options.risk_flag = Some("low".to_string());
            Ok(())
        }
        RiskClass::Hard => Err(error_json(
            "risk_hard_blocked",
            &format!("memory '{slug}' contains high-risk secret-like content and was not stored"),
            None,
            None,
        )),
    }
}

fn truncate_chars(input: &str, max: usize) -> String {
    input.chars().take(max).collect()
}
