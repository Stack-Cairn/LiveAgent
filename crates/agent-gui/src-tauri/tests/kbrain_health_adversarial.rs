//! Adversarial review: compiles the real `services/kbrain_health.rs` and feeds it
//! the same raw bodies as the TS and Go adversarial tests
//! (`crates/agent-gui/test/chat/kbrain-health-adversarial-vectors.json`).
//! `wait_for_health` decodes the body with `response.json::<serde_json::Value>()`,
//! which is `serde_json::from_slice`, so the same call is used here.

#[allow(dead_code)]
#[path = "../src/services/kbrain_health.rs"]
mod kbrain_health;

use serde_json::Value;

const VECTORS: &str = include_str!("../../test/chat/kbrain-health-adversarial-vectors.json");

#[test]
fn adversarial_health_bodies_match_other_hosts() {
    let vectors: Value = serde_json::from_str(VECTORS).expect("vectors parse");
    let mut divergences = Vec::new();
    for vector in vectors["bodies"].as_array().expect("bodies") {
        let name = vector["name"].as_str().unwrap();
        let raw = vector["raw"].as_str().unwrap();
        // A body that is not exactly one JSON value never reaches parse_health:
        // wait_for_health keeps retrying until the deadline. That is not an accept.
        let verdict = match serde_json::from_slice::<Value>(raw.as_bytes()) {
            Err(_) => Err("not one JSON value".to_string()),
            Ok(body) => kbrain_health::parse_health(&body),
        };
        match (vector["expect"].as_str().unwrap(), &verdict) {
            ("accept", Ok(parsed)) => {
                let want = vector["minor"].as_u64().unwrap();
                if parsed.protocol_minor != want {
                    divergences.push(format!("{name}: minor {} != {want}", parsed.protocol_minor));
                }
            }
            ("accept", Err(error)) => {
                divergences.push(format!("{name}: Rust rejects what TS accepts ({error})"))
            }
            ("reject", Ok(parsed)) => divergences.push(format!(
                "{name}: Rust accepts what TS rejects ({parsed:?})"
            )),
            _ => {}
        }
    }
    assert!(
        divergences.is_empty(),
        "Rust health verdicts diverge from TS:\n{}",
        divergences.join("\n")
    );
}
