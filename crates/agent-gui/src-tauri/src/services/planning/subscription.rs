//! Read-only calendars mirrored from an iCal URL (Google "secret address", Outlook, Apple…).
//!
//! The URL is a credential: it lives only in `planning_subscriptions` and is never part of a
//! snapshot, so it does not reach WebUI clients or Agent tools. The desktop frontend fetches
//! through [`PlanningStore::subscription_url`] (backend HTTP, no CORS), parses with the same
//! ICS importer as file imports, then hands the entries to [`PlanningStore::sync_subscription`].

use super::{
    store::{data, persist, reconcile_reminders, snapshot, sql_error, validate},
    types::*,
    PlanningStore,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(super) const SOURCE_KIND: &str = "subscription";
const PROVIDER: &str = "ics-subscription";
pub const REFRESH_CHOICES: [i64; 7] = [15, 30, 60, 180, 360, 720, 1440];
/// A claimed refresh is retried after this lease if the desktop never reports back.
const CLAIM_LEASE_MS: i64 = 10 * 60_000;
const MAX_ENTRIES: usize = 5000;

pub(super) fn create_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS planning_subscriptions(
            id TEXT PRIMARY KEY, url TEXT NOT NULL, refresh_minutes INTEGER NOT NULL,
            next_at INTEGER NOT NULL, last_synced_at INTEGER, last_error TEXT);",
    )
    .map_err(sql_error)
}

/// Status rows for existing subscription calendars (never includes the URL).
pub(super) fn statuses(conn: &Connection) -> Result<Vec<SubscriptionStatus>, String> {
    let mut stmt = conn
        .prepare("SELECT id,url,refresh_minutes,next_at,last_synced_at,last_error FROM planning_subscriptions ORDER BY id")
        .map_err(sql_error)?;
    let rows = stmt
        .query_map([], |r| {
            let url: String = r.get(1)?;
            Ok(SubscriptionStatus {
                calendar_id: r.get(0)?,
                host: reqwest::Url::parse(&url)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_owned))
                    .unwrap_or_default(),
                refresh_minutes: r.get(2)?,
                next_at: r.get(3)?,
                last_synced_at: r.get(4)?,
                last_error: r.get(5)?,
            })
        })
        .map_err(sql_error)?;
    rows.collect::<Result<_, _>>().map_err(sql_error)
}

/// `webcal://` is the same feed over HTTPS; only http(s) URLs with a host are accepted.
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let candidate = match trimmed.split_once("://") {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("webcal") => format!("https://{rest}"),
        _ => trimmed.to_string(),
    };
    let url = reqwest::Url::parse(&candidate).map_err(|_| "E:subscription_url_invalid")?;
    if !["https", "http"].contains(&url.scheme())
        || url.host_str().is_none()
        || candidate.len() > 4096
    {
        return Err("E:subscription_url_invalid".into());
    }
    Ok(url.to_string())
}

fn refresh_minutes(value: &Value) -> Result<i64, String> {
    let minutes = value.as_i64().unwrap_or(60);
    if REFRESH_CHOICES.contains(&minutes) {
        Ok(minutes)
    } else {
        Err("E:subscription_interval_invalid".into())
    }
}

fn subscription_calendar<'a>(s: &'a mut Snapshot, id: &str) -> Result<&'a mut Calendar, String> {
    s.calendars
        .iter_mut()
        .find(|c| c.id == id && c.source_kind == SOURCE_KIND)
        .ok_or_else(|| "E:subscription_missing".into())
}

impl PlanningStore {
    fn write<T>(
        &self,
        run: impl FnOnce(&Connection, &mut Snapshot, i64) -> Result<T, String>,
    ) -> Result<(T, u64), String> {
        let mut conn = self.conn.lock().map_err(sql_error)?;
        let tx = conn.transaction().map_err(sql_error)?;
        let mut s = snapshot(&tx)?;
        let now = super::store::now();
        let result = run(&tx, &mut s, now)?;
        s.reminders
            .retain(|r| r.target_type != "event" || s.events.iter().any(|e| e.id == r.target_id));
        validate(&s)?;
        reconcile_reminders(&mut s, now, false)?;
        s.seq += 1;
        persist(&tx, &s)?;
        tx.commit().map_err(sql_error)?;
        Ok((result, s.seq))
    }

    /// Management actions shared by desktop and WebUI (`subscription.*`).
    pub fn subscription(&self, action: &str, input: &Value) -> Result<(Value, u64), String> {
        let id = input["id"].as_str().unwrap_or("");
        match action {
            "subscription.create" => {
                let url = normalize_url(input["url"].as_str().unwrap_or(""))?;
                let minutes = refresh_minutes(&input["refreshMinutes"])?;
                let name: String = input["name"].as_str().unwrap_or("").trim().chars().take(60).collect();
                if name.is_empty() {
                    return Err("E:title_length".into());
                }
                self.write(|tx, s, _| {
                    let calendar: Calendar = data(json!({
                        "id": uuid::Uuid::new_v4().to_string(),
                        "name": name,
                        "color": input["color"].as_str().unwrap_or("#0F766E"),
                        "sortOrder": s.calendars.len(),
                        "isDefault": false,
                        "reminderMinutes": null,
                        "sourceKind": SOURCE_KIND,
                        "readOnly": true,
                        "revision": 1,
                    }))?;
                    tx.execute(
                        "INSERT INTO planning_subscriptions(id,url,refresh_minutes,next_at) VALUES(?1,?2,?3,0)",
                        params![calendar.id, url, minutes],
                    )
                    .map_err(sql_error)?;
                    let value = json!(calendar);
                    s.calendars.push(calendar);
                    Ok(value)
                })
            }
            "subscription.update" => self.write(|tx, s, _| {
                let calendar = subscription_calendar(s, id)?;
                if let Some(name) = input["name"].as_str() {
                    let name: String = name.trim().chars().take(60).collect();
                    if name.is_empty() {
                        return Err("E:title_length".into());
                    }
                    calendar.name = name;
                }
                if let Some(color) = input["color"].as_str() {
                    super::store::valid_color(&input["color"])?;
                    calendar.color = color.into();
                }
                calendar.revision += 1;
                let value = json!(calendar);
                if !input["refreshMinutes"].is_null() {
                    tx.execute(
                        "UPDATE planning_subscriptions SET refresh_minutes=?2 WHERE id=?1",
                        params![id, refresh_minutes(&input["refreshMinutes"])?],
                    )
                    .map_err(sql_error)?;
                }
                if let Some(url) = input["url"].as_str() {
                    tx.execute(
                        "UPDATE planning_subscriptions SET url=?2,next_at=0,last_error=NULL WHERE id=?1",
                        params![id, normalize_url(url)?],
                    )
                    .map_err(sql_error)?;
                }
                Ok(value)
            }),
            "subscription.refresh" => self.write(|tx, s, _| {
                subscription_calendar(s, id)?;
                tx.execute("UPDATE planning_subscriptions SET next_at=0 WHERE id=?1", [id])
                    .map_err(sql_error)?;
                Ok(Value::Null)
            }),
            "subscription.delete" => self.write(|tx, s, _| {
                subscription_calendar(s, id)?;
                let removed: Vec<String> = s
                    .events
                    .iter()
                    .filter(|e| e.calendar_id == id)
                    .map(|e| e.id.clone())
                    .collect();
                s.events.retain(|e| e.calendar_id != id);
                s.sources
                    .retain(|r| !(r.target_type == "event" && removed.contains(&r.target_id)));
                s.calendars.retain(|c| c.id != id);
                tx.execute("DELETE FROM planning_subscriptions WHERE id=?1", [id])
                    .map_err(sql_error)?;
                Ok(Value::Null)
            }),
            _ => Err("E:unknown_request".into()),
        }
    }

    /// Claim subscriptions whose refresh is due; each claim holds a short lease.
    pub fn due_subscriptions(&self, at: i64) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(sql_error)?;
        let calendars: Vec<String> = snapshot(&conn)?
            .calendars
            .into_iter()
            .filter(|c| c.source_kind == SOURCE_KIND)
            .map(|c| c.id)
            .collect();
        // Rows whose calendar vanished (e.g. restored from a backup) are dropped here.
        let mut stmt = conn
            .prepare("SELECT id FROM planning_subscriptions WHERE next_at<=?1")
            .map_err(sql_error)?;
        let ids: Vec<String> = stmt
            .query_map([at], |r| r.get(0))
            .map_err(sql_error)?
            .collect::<Result<_, _>>()
            .map_err(sql_error)?;
        let mut due = vec![];
        for id in ids {
            if calendars.contains(&id) {
                conn.execute(
                    "UPDATE planning_subscriptions SET next_at=?2 WHERE id=?1",
                    params![id, at + CLAIM_LEASE_MS],
                )
                .map_err(sql_error)?;
                due.push(id);
            } else {
                conn.execute("DELETE FROM planning_subscriptions WHERE id=?1", [&id])
                    .map_err(sql_error)?;
            }
        }
        Ok(due)
    }

    pub fn subscription_url(&self, id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(sql_error)?;
        conn.query_row(
            "SELECT url FROM planning_subscriptions WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql_error)?
        .ok_or_else(|| "E:subscription_missing".into())
    }

    /// Mirror the parsed feed: upsert by UID, drop events that left the feed.
    pub fn sync_subscription(&self, id: &str, entries: &[Value]) -> Result<(Value, u64), String> {
        if entries.len() > MAX_ENTRIES {
            return Err("E:import_count".into());
        }
        self.write(|tx, s, now| {
            subscription_calendar(s, id)?;
            let prefix = format!("{id}:");
            let mut seen = std::collections::HashSet::new();
            let (mut added, mut updated) = (0, 0);
            for entry in entries {
                let uid = entry["uid"]
                    .as_str()
                    .filter(|u| !u.is_empty() && u.len() <= 2048)
                    .ok_or("E:import_missing_uid")?;
                let external = format!("{prefix}{uid}");
                if !seen.insert(external.clone()) {
                    continue;
                }
                let title: String = entry["title"].as_str().unwrap_or("").chars().take(500).collect();
                let notes: String = entry["notes"].as_str().unwrap_or("").chars().take(20_000).collect();
                let existing = s
                    .sources
                    .iter()
                    .find(|r| r.provider_kind == PROVIDER && r.external_id == external)
                    .map(|r| r.target_id.clone());
                if let Some(event) = existing
                    .as_ref()
                    .and_then(|event_id| s.events.iter_mut().find(|e| &e.id == event_id))
                {
                    let time = data(entry["time"].clone())?;
                    if event.title != title || event.notes != notes || json!(event.time) != json!(time) {
                        event.title = title;
                        event.notes = notes;
                        event.time = time;
                        event.revision += 1;
                        event.updated_at = now;
                        updated += 1;
                    }
                    continue;
                }
                let event: Event = data(json!({
                    "id": uuid::Uuid::new_v4().to_string(),
                    "calendarId": id,
                    "title": title,
                    "notes": notes,
                    "time": entry["time"],
                    "createdAt": now,
                    "updatedAt": now,
                    "revision": 1,
                }))?;
                s.sources.retain(|r| !(r.provider_kind == PROVIDER && r.external_id == external));
                s.sources.push(data(json!({
                    "id": uuid::Uuid::new_v4().to_string(),
                    "targetType": "event",
                    "targetId": event.id,
                    "providerKind": PROVIDER,
                    "externalId": external,
                    "title": event.title,
                    "revision": 1,
                }))?);
                s.events.push(event);
                added += 1;
            }
            let stale: Vec<String> = s
                .sources
                .iter()
                .filter(|r| {
                    r.provider_kind == PROVIDER
                        && r.external_id.starts_with(&prefix)
                        && !seen.contains(&r.external_id)
                })
                .map(|r| r.target_id.clone())
                .collect();
            let removed = stale.len();
            s.events.retain(|e| !stale.contains(&e.id));
            s.sources.retain(|r| {
                !(r.provider_kind == PROVIDER && r.external_id.starts_with(&prefix))
                    || seen.contains(&r.external_id)
            });
            let refresh: i64 = tx
                .query_row(
                    "SELECT refresh_minutes FROM planning_subscriptions WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .map_err(sql_error)?;
            tx.execute(
                "UPDATE planning_subscriptions SET last_synced_at=?2,last_error=NULL,next_at=?3 WHERE id=?1",
                params![id, now, now + refresh * 60_000],
            )
            .map_err(sql_error)?;
            Ok(json!({"added":added,"updated":updated,"removed":removed}))
        })
    }

    /// Record a failed refresh; the calendar keeps its last good copy.
    pub fn fail_subscription(&self, id: &str, error: &str) -> Result<u64, String> {
        let (_, seq) = self.write(|tx, s, now| {
            subscription_calendar(s, id)?;
            let refresh: i64 = tx
                .query_row(
                    "SELECT refresh_minutes FROM planning_subscriptions WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .map_err(sql_error)?;
            let error: String = error.chars().take(500).collect();
            tx.execute(
                "UPDATE planning_subscriptions SET last_error=?2,next_at=?3 WHERE id=?1",
                params![id, error, now + refresh.min(60) * 60_000],
            )
            .map_err(sql_error)?;
            Ok(())
        })?;
        Ok(seq)
    }
}
