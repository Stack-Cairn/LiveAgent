use super::{
    store::{data, writable},
    types::*,
};
use serde_json::{json, Value};

/// Import a reviewed file atomically; source UID prevents duplicates even after trashing.
pub(super) fn apply(s: &mut Snapshot, m: &Mutation, now: i64) -> Result<Option<Value>, String> {
    let calendar = m.id.as_deref().ok_or("E:import_need_calendar")?;
    writable(s, calendar)?;
    let entries = m
        .data
        .get("entries")
        .and_then(Value::as_array)
        .ok_or("E:import_invalid")?;
    if entries.is_empty() || entries.len() > 200 || m.data.as_object().is_none_or(|d| d.len() != 1)
    {
        return Err("E:import_count".into());
    }
    let mut imported = 0;
    let mut skipped = 0;
    for entry in entries {
        if entry.as_object().is_none_or(|o| {
            o.keys()
                .any(|key| !["uid", "title", "notes", "time"].contains(&key.as_str()))
        }) {
            return Err("E:import_unknown_field".into());
        }
        let uid = entry["uid"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 2048)
            .ok_or("E:import_missing_uid")?;
        let external = format!("{calendar}:{uid}");
        if s.sources
            .iter()
            .any(|r| r.provider_kind == "ical" && r.external_id == external)
        {
            skipped += 1;
            continue;
        }
        let event_id = uuid::Uuid::new_v4().to_string();
        let event: Event = data(
            json!({"id":event_id,"calendarId":calendar,"title":entry["title"],"notes":entry["notes"].as_str().unwrap_or(""),"time":entry["time"],"createdAt":now,"updatedAt":now,"revision":1}),
        )?;
        let source: SourceLink = data(
            json!({"id":uuid::Uuid::new_v4().to_string(),"targetType":"event","targetId":event.id,"providerKind":"ical","externalId":external,"title":event.title,"revision":1}),
        )?;
        s.events.push(event);
        s.sources.push(source);
        imported += 1;
    }
    Ok(Some(json!({"imported":imported,"skipped":skipped})))
}
