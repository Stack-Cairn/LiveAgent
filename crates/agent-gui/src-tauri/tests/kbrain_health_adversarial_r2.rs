//! Adversarial review round 2: byte-level bodies (BOM, invalid UTF-8) through the
//! same decode as `wait_for_health` (`response.json::<Value>()` =
//! `serde_json::from_slice`) and the real `services/kbrain_health.rs`.

#[allow(dead_code)]
#[path = "../src/services/kbrain_health.rs"]
mod kbrain_health;

use base64::Engine;
use serde_json::Value;

const VECTORS: &str = include_str!("../../test/chat/kbrain-health-adversarial-r2-vectors.json");

#[test]
fn byte_level_health_bodies_are_not_accepted() {
    let vectors: Value = serde_json::from_str(VECTORS).expect("vectors parse");
    for vector in vectors["bodies"].as_array().expect("bodies") {
        let name = vector["name"].as_str().unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(vector["base64"].as_str().unwrap())
            .expect("base64");
        let accepted = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .map(|body| kbrain_health::parse_health(&body).is_ok())
            .unwrap_or(false);
        assert!(!accepted, "{name}: Rust accepted");
    }
}
