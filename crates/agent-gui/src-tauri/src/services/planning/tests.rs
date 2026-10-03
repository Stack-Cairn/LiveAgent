use super::*;
use serde_json::{json, Value};
fn store() -> PlanningStore {
    PlanningStore::with_connection(rusqlite::Connection::open_in_memory().unwrap()).unwrap()
}
fn input(action: &str, id: Option<&str>, revision: Option<u64>, data: Value) -> Mutation {
    Mutation {
        request_id: uuid::Uuid::new_v4().to_string(),
        action: action.into(),
        id: id.map(str::to_string),
        expected_revision: revision,
        data,
    }
}
fn timed(start: i64, end: i64) -> Value {
    json!({"kind":"timed","startAt":start,"endAt":end,"timeZone":"Asia/Shanghai"})
}

#[test]
fn planning_schedule_resize_conflict_and_idempotency() {
    let store = store();
    let s = store.snapshot(Query::default()).unwrap();
    let t = store
        .mutate(input(
            "todo.create",
            None,
            None,
            json!({"title":"整理周报"}),
        ))
        .unwrap()
        .item
        .unwrap();
    let tid = t["id"].as_str().unwrap();
    let now = store::now() + 3_600_000;
    let request = input(
        "todo.schedule",
        Some(tid),
        Some(1),
        json!({"calendarId":s.calendars[0].id,"time":timed(now,now+3_600_000)}),
    );
    let first = store.mutate(request.clone()).unwrap();
    let replay = store.mutate(request).unwrap();
    assert!(replay.replayed);
    assert_eq!(first.item, replay.item);
    let e = first.item.unwrap();
    let eid = e["id"].as_str().unwrap();
    store
        .mutate(input(
            "event.update",
            Some(eid),
            Some(1),
            json!({"time":timed(now,now+5_400_000)}),
        ))
        .unwrap();
    let conflict = store
        .mutate(input(
            "event.update",
            Some(eid),
            Some(1),
            json!({"title":"old"}),
        ))
        .unwrap();
    assert_eq!(conflict.status, "conflict");
    let state = store.snapshot(Query::default()).unwrap();
    assert_eq!(state.events.len(), 1);
    assert_eq!(
        time::bounds(&state.events[0].time).unwrap().1 - now,
        5_400_000
    );
    assert_eq!(state.reminders.len(), 1);
}

#[test]
fn planning_invalid_edit_rolls_back_and_trash_restores_linked_events() {
    let store = store();
    let s = store.snapshot(Query::default()).unwrap();
    let todo = store
        .mutate(input("todo.create", None, None, json!({"title":"Task"})))
        .unwrap()
        .item
        .unwrap();
    let tid = todo["id"].as_str().unwrap();
    let now = store::now() + 3_600_000;
    assert!(store
        .mutate(input(
            "todo.schedule",
            Some(tid),
            Some(1),
            json!({"calendarId":s.calendars[0].id,"time":timed(now,now-1)})
        ))
        .is_err());
    assert!(store.snapshot(Query::default()).unwrap().events.is_empty());
    store
        .mutate(input(
            "todo.schedule",
            Some(tid),
            Some(1),
            json!({"calendarId":s.calendars[0].id,"time":timed(now,now+3600000)}),
        ))
        .unwrap();
    store
        .mutate(input("todo.delete", Some(tid), Some(1), json!({})))
        .unwrap();
    let s = store.snapshot(Query::default()).unwrap();
    assert!(s.todos[0].deleted_at.is_some());
    assert_eq!(s.events[0].todo_id.as_deref(), Some(tid));
    assert!(!trash::event_active(&s, &s.events[0]));
    assert!(s.reminders.iter().all(|r| r.status != "pending"));
    assert!(store
        .mutate(input(
            "todo.update",
            Some(tid),
            Some(2),
            json!({"title":"hidden"})
        ))
        .is_err());
    store
        .mutate(input("todo.restore", Some(tid), Some(2), json!({})))
        .unwrap();
    let s = store.snapshot(Query::default()).unwrap();
    assert!(trash::event_active(&s, &s.events[0]));
    assert!(s.reminders.iter().any(|r| r.status == "pending"));
    store
        .mutate(input("todo.delete", Some(tid), Some(3), json!({})))
        .unwrap();
    store
        .mutate(input("todo.purge", Some(tid), Some(4), json!({})))
        .unwrap();
    let s = store.snapshot(Query::default()).unwrap();
    assert!(s.todos.is_empty());
    assert!(s.events.is_empty());
    assert!(s.reminders.is_empty());
}

#[test]
fn planning_reminder_leases_snooze_and_completion() {
    let store = store();
    let s = store.snapshot(Query::default()).unwrap();
    let at = store::now() + 60000;
    store
        .mutate(input(
            "event.create",
            None,
            None,
            json!({"title":"Meeting","calendarId":s.calendars[0].id,"time":timed(at,at+3600000)}),
        ))
        .unwrap();
    let claim = store.claim_reminders(at + 1).unwrap();
    assert_eq!(claim.len(), 1);
    assert!(store.claim_reminders(at + 2).unwrap().is_empty());
    store
        .mutate(input(
            "reminder.snooze",
            Some(&claim[0].id),
            Some(claim[0].revision),
            json!({"minutes":10}),
        ))
        .unwrap();
    // 旧通知 worker 不得覆盖 snooze 后的新代次。
    store.finish_notification(&claim[0], true, at + 3).unwrap();
    let s = store.snapshot(Query::default()).unwrap();
    assert!(s.reminders[0].notified_at.is_none());
    assert!(s.reminders[0].snoozed_until.is_some());
}

#[test]
fn planning_recurrence_exception_and_dst() {
    let store = store();
    let s = store.snapshot(Query::default()).unwrap();
    let start = chrono::DateTime::parse_from_rfc3339("2026-03-07T09:00:00-05:00")
        .unwrap()
        .timestamp_millis();
    let e=store.mutate(input("event.create",None,None,json!({"title":"Daily","calendarId":s.calendars[0].id,"time":{"kind":"timed","startAt":start,"endAt":start+3600000,"timeZone":"America/New_York"},"recurrence":{"frequency":"daily","interval":1,"count":3}}))).unwrap().item.unwrap();
    let s = store
        .snapshot(Query {
            from: Some(start - 1),
            to: Some(start + 4 * 86400000),
        })
        .unwrap();
    assert_eq!(s.events.len(), 3);
    let b0 = time::bounds(&s.events[0].time).unwrap().0;
    let b1 = time::bounds(&s.events[1].time).unwrap().0;
    assert_eq!(b1 - b0, 23 * 3600000);
    store
        .mutate(input(
            "event.exception",
            e["id"].as_str(),
            Some(1),
            json!({"date":"2026-03-08","delete":true}),
        ))
        .unwrap();
    assert_eq!(
        store
            .snapshot(Query {
                from: Some(start - 1),
                to: Some(start + 4 * 86400000)
            })
            .unwrap()
            .events
            .len(),
        2
    );
}

#[test]
fn planning_validation_and_calendar_migration() {
    let store = store();
    let s = store.export().unwrap();
    let at = store::now() + 3600000;
    assert!(store
        .mutate(input(
            "todo.create",
            None,
            None,
            json!({"title":"x","unknown":true})
        ))
        .is_err());
    assert!(store
        .mutate(input(
            "todo.create",
            None,
            None,
            json!({"title":"x","projectId":"project-a"})
        ))
        .is_err());
    assert!(store
        .mutate(input(
            "reminder.create",
            None,
            None,
            json!({"targetType":"todo","targetId":"missing","triggerAt":at})
        ))
        .is_err());
    assert!(store
        .mutate(input(
            "event.create",
            None,
            None,
            json!({"title":"tiny","calendarId":s.calendars[0].id,"time":timed(at,at+899999)})
        ))
        .is_err());
    let event = store
        .mutate(input(
            "event.create",
            None,
            None,
            json!({"title":"valid","calendarId":s.calendars[0].id,"time":timed(at,at+900000)}),
        ))
        .unwrap()
        .item
        .unwrap();
    store
        .mutate(input(
            "calendar.delete",
            Some(&s.calendars[0].id),
            Some(1),
            json!({"moveTo":s.calendars[1].id}),
        ))
        .unwrap();
    let next = store.export().unwrap();
    assert_eq!(next.calendars.len(), 1);
    assert!(next.calendars[0].is_default);
    assert_eq!(next.events[0].id, event["id"].as_str().unwrap());
    assert_eq!(next.events[0].calendar_id, s.calendars[1].id);
    let mut bad = next.clone();
    bad.events.push(bad.events[0].clone());
    assert!(store.import(bad).is_err());
    assert_eq!(store.export().unwrap().seq, next.seq);
}

#[test]
fn planning_completed_todo_stops_manual_event_reminder_and_history_is_unscheduled() {
    let store = store();
    let s = store.export().unwrap();
    let at = store::now();
    let todo = store
        .mutate(input("todo.create", None, None, json!({"title":"Task"})))
        .unwrap()
        .item
        .unwrap();
    let tid = todo["id"].as_str().unwrap();
    let e = store
        .mutate(input(
            "todo.schedule",
            Some(tid),
            Some(1),
            json!({"calendarId":s.calendars[0].id,"time":timed(at-7200000,at-3600000)}),
        ))
        .unwrap()
        .item
        .unwrap();
    assert!(!store.export().unwrap().todo_schedules[0].has_future);
    store
        .mutate(input(
            "reminder.create",
            None,
            None,
            json!({"targetType":"event","targetId":e["id"],"triggerAt":at+60000}),
        ))
        .unwrap();
    store
        .mutate(input(
            "todo.update",
            Some(tid),
            Some(1),
            json!({"status":"completed"}),
        ))
        .unwrap();
    assert!(store.claim_reminders(at + 60001).unwrap().is_empty());
    assert_eq!(store.export().unwrap().reminders[0].status, "completed");
}

#[test]
fn planning_single_occurrence_undo_checks_master_and_exception_revisions() {
    let store = store();
    let s = store.export().unwrap();
    let at = store::now() + 3600000;
    let e=store.mutate(input("event.create",None,None,json!({"title":"Daily","calendarId":s.calendars[0].id,"time":timed(at,at+3600000),"recurrence":{"frequency":"daily","interval":1,"count":3}}))).unwrap().item.unwrap();
    let eid = e["id"].as_str().unwrap();
    let day = time::local_date(&serde_json::from_value::<Event>(e.clone()).unwrap().time).unwrap();
    let changed = store
        .mutate(input(
            "event.exception",
            Some(eid),
            Some(1),
            json!({"date":day,"time":timed(at+60000,at+3660000)}),
        ))
        .unwrap()
        .item
        .unwrap();
    let undo = input(
        "event.restoreException",
        Some(eid),
        Some(2),
        json!({"date":day,"exceptionId":changed["id"],"exceptionRevision":1}),
    );
    store.mutate(undo).unwrap();
    let result = store.export().unwrap();
    assert_eq!(result.events.len(), 1);
    assert!(result.events[0]
        .recurrence
        .as_ref()
        .unwrap()
        .excluded_dates
        .is_empty());
}

/// Optional real-browser fixture. Only a temporary SQLite database is opened.
/// Run with PLANNING_TEST_SERVER_PORT=15231 cargo test -p liveagent planning_browser_host -- --ignored --nocapture.
#[test]
#[ignore = "manual browser fixture: requires an explicit local port and exits on shutdown"]
fn planning_browser_host() {
    use std::io::{Read, Write};
    let port: u16 = std::env::var("PLANNING_TEST_SERVER_PORT")
        .expect("explicit test port required")
        .parse()
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = PlanningStore::with_connection(
        rusqlite::Connection::open(dir.path().join("planning.sqlite")).unwrap(),
    )
    .unwrap();
    let s = store.export().unwrap();
    let date = time::local_date(&EventTime::Timed {
        start_at: store::now(),
        end_at: store::now() + 3600000,
        time_zone: s.time_zone.clone(),
    })
    .unwrap();
    let start = time::midnight(&date, &s.time_zone).unwrap();
    for title in ["整理产品方案", "读完设计笔记", "准备周会"] {
        store
            .mutate(input(
                "todo.create",
                None,
                None,
                json!({"title":title,"estimateMinutes":60}),
            ))
            .unwrap();
    }
    for (title, offset, duration) in [
        ("设计评审", 607, 75),
        ("团队同步", 660, 45),
        ("午间散步", 780, 30),
    ] {
        store.mutate(input("event.create",None,None,json!({"title":title,"calendarId":s.calendars[0].id,"time":{"kind":"timed","startAt":start+offset*60000,"endAt":start+(offset+duration)*60000,"timeZone":s.time_zone}}))).unwrap();
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    println!("Planning test database ready on 127.0.0.1:{port}");
    for connection in listener.incoming() {
        let mut stream = connection.unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut bytes = vec![];
        let mut buffer = [0_u8; 4096];
        let header_end;
        loop {
            let n = match stream.read(&mut buffer) {
                Ok(n) => n,
                Err(_) => 0,
            };
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..n]);
            if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = index + 4;
                let headers = String::from_utf8_lossy(&bytes[..index]);
                let length = headers
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|s| s.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if length > 4_000_000 {
                    break;
                }
                while bytes.len() < header_end + length {
                    let n = stream.read(&mut buffer).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                }
                break;
            }
            if bytes.len() > 10000 {
                break;
            }
        }
        let index = bytes
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|i| i + 4)
            .unwrap_or(bytes.len());
        let input: Value = serde_json::from_slice(&bytes[index..]).unwrap_or(json!({}));
        let action = input["action"].as_str().unwrap_or("query");
        let result: Result<Value, String> = match action {
            "query" => store
                .snapshot(serde_json::from_value(input["input"].clone()).unwrap_or_default())
                .map(|s| json!(s)),
            "mutate" => serde_json::from_value(input["input"].clone())
                .map_err(|e| e.to_string())
                .and_then(|m| store.mutate(m))
                .map(|s| json!(s)),
            "export" => store.export().map(|s| json!(s)),
            "import" => serde_json::from_value(input["input"].clone())
                .map_err(|e| e.to_string())
                .and_then(|s| store.import(s))
                .map(|_| Value::Null),
            "shutdown" => Ok(Value::Null),
            _ => Err("Unsupported fixture action".into()),
        };
        let (status, body) = match result {
            Ok(v) => ("200 OK", v.to_string()),
            Err(e) => ("400 Bad Request", json!({"error":e}).to_string()),
        };
        let headers=format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
        let _ = stream.write_all(headers.as_bytes());
        let _ = stream.write_all(body.as_bytes());
        let _ = stream.flush();
        if action == "shutdown" {
            break;
        }
    }
}

#[test]
fn planning_groups_shared_tags_and_advance_reminders() {
    let store = store();
    let group = store
        .mutate(input("group.create", None, None, json!({"name":"产品"})))
        .unwrap()
        .item
        .unwrap();
    let tag = store
        .mutate(input(
            "tag.create",
            None,
            None,
            json!({"name":"重要","color":"#ef4444"}),
        ))
        .unwrap()
        .item
        .unwrap();
    let at = store::now() + 3_600_000;
    let todo=store.mutate(input("todo.create",None,None,json!({"title":"方案","groupId":group["id"],"tagIds":[tag["id"]],"priority":"high","dueAt":at,"dueReminder":true,"reminderMinutes":15}))).unwrap().item.unwrap();
    let tid = todo["id"].as_str().unwrap();
    let s = store.export().unwrap();
    assert_eq!(s.reminders[0].trigger_at, at - 15 * 60_000);
    assert!(store
        .mutate(input(
            "todo.update",
            Some(tid),
            Some(1),
            json!({"title":"must roll back","tagIds":[tag["id"],"missing"]})
        ))
        .is_err());
    assert_eq!(store.export().unwrap().todos[0].title, "方案");
    store
        .mutate(input(
            "todo.schedule",
            Some(tid),
            Some(1),
            json!({"calendarId":s.calendars[0].id,"time":timed(at,at+3600000)}),
        ))
        .unwrap();
    assert_eq!(
        store.export().unwrap().events[0].tag_ids[0],
        tag["id"].as_str().unwrap()
    );
    store
        .mutate(input(
            "reminder.create",
            None,
            None,
            json!({"targetType":"todo","targetId":tid,"triggerAt":at-30*60_000}),
        ))
        .unwrap();
    let renamed = store
        .mutate(input(
            "group.update",
            group["id"].as_str(),
            Some(1),
            json!({"name":"产品计划"}),
        ))
        .unwrap()
        .item
        .unwrap();
    assert_eq!(renamed["name"], "产品计划");
    assert_eq!(renamed["revision"], 2);
    // An older open dialog must not delete a list renamed on another client.
    assert_eq!(
        store
            .mutate(input(
                "group.delete",
                group["id"].as_str(),
                Some(1),
                json!({})
            ))
            .unwrap()
            .status,
        "conflict"
    );
    let before_delete = store.export().unwrap();
    store
        .mutate(input(
            "group.delete",
            group["id"].as_str(),
            Some(2),
            json!({}),
        ))
        .unwrap();
    let s = store.export().unwrap();
    assert!(s.groups.is_empty());
    assert!(s.todos[0].group_id.is_none());
    assert_eq!(s.todos[0].revision, 2);
    assert_eq!(s.todos[0].status, before_delete.todos[0].status);
    assert_eq!(
        serde_json::to_value(&s.events).unwrap(),
        serde_json::to_value(&before_delete.events).unwrap()
    );
    store
        .mutate(input("tag.delete", tag["id"].as_str(), Some(1), json!({})))
        .unwrap();
    let s = store.export().unwrap();
    assert!(s.todos[0].tag_ids.is_empty());
    assert!(s.events[0].tag_ids.is_empty());
    store
        .mutate(input(
            "todo.update",
            Some(tid),
            Some(s.todos[0].revision),
            json!({"status":"completed"}),
        ))
        .unwrap();
    assert!(store
        .export()
        .unwrap()
        .reminders
        .iter()
        .all(|r| r.status == "completed"));
}

#[test]
fn planning_trash_revision_completion_and_list_preservation() {
    let store = store();
    let group = store
        .mutate(input("group.create", None, None, json!({"name":"Work"})))
        .unwrap()
        .item
        .unwrap();
    let t = store
        .mutate(input(
            "todo.create",
            None,
            None,
            json!({"title":"Task","groupId":group["id"]}),
        ))
        .unwrap()
        .item
        .unwrap();
    let tid = t["id"].as_str();
    let t = store
        .mutate(input(
            "todo.update",
            tid,
            Some(1),
            json!({"status":"completed"}),
        ))
        .unwrap()
        .item
        .unwrap();
    let stamp = t["completedAt"].clone();
    let t = store
        .mutate(input(
            "todo.update",
            tid,
            Some(2),
            json!({"title":"Edited"}),
        ))
        .unwrap()
        .item
        .unwrap();
    assert_eq!(stamp, t["completedAt"]);
    assert!(store
        .mutate(input("todo.purge", tid, Some(3), json!({})))
        .is_err());
    assert!(store
        .mutate(input(
            "todo.delete",
            tid,
            Some(3),
            json!({"title":"invalid"})
        ))
        .is_err());
    store
        .mutate(input("todo.delete", tid, Some(3), json!({})))
        .unwrap();
    assert_eq!(
        store
            .mutate(input("todo.restore", tid, Some(3), json!({})))
            .unwrap()
            .status,
        "conflict"
    );
    let restored = store
        .mutate(input("todo.restore", tid, Some(4), json!({})))
        .unwrap()
        .item
        .unwrap();
    assert_eq!(restored["groupId"], group["id"]);
    assert_eq!(restored["completedAt"], stamp);
    let open = store
        .mutate(input(
            "todo.update",
            tid,
            Some(5),
            json!({"status":"open","groupId":null}),
        ))
        .unwrap()
        .item
        .unwrap();
    assert!(open["completedAt"].is_null());
    assert!(open["groupId"].is_null());
}

#[test]
fn planning_repeated_occurrence_trash_restore_and_series_purge() {
    let store = store();
    let calendar = store.snapshot(Query::default()).unwrap().calendars[0]
        .id
        .clone();
    let start = time::midnight("2026-09-27", "Asia/Shanghai").unwrap() + 9 * 3600000;
    let master = store.mutate(input("event.create", None, None, json!({"title":"Daily","calendarId":calendar,"time":timed(start,start+3600000),"recurrence":{"frequency":"daily","interval":1,"count":3}}))).unwrap().item.unwrap();
    let mid = master["id"].as_str();
    let exception = store
        .mutate(input(
            "event.exception",
            mid,
            Some(1),
            json!({"date":"2026-09-28","delete":true}),
        ))
        .unwrap()
        .item
        .unwrap();
    let eid = exception["id"].as_str();
    assert!(exception["deletedAt"].is_i64());
    assert_eq!(exception["time"]["startAt"], start + 86400000);
    store
        .mutate(input("event.restore", eid, Some(1), json!({})))
        .unwrap();
    let query = Query {
        from: Some(start - 1),
        to: Some(start + 3 * 86400000),
    };
    assert_eq!(store.snapshot(query.clone()).unwrap().events.len(), 3);
    store
        .mutate(input("event.delete", mid, Some(2), json!({})))
        .unwrap();
    assert!(store.snapshot(query.clone()).unwrap().events.is_empty());
    store
        .mutate(input("event.restore", mid, Some(3), json!({})))
        .unwrap();
    assert_eq!(store.snapshot(query).unwrap().events.len(), 3);
    store
        .mutate(input("event.delete", mid, Some(4), json!({})))
        .unwrap();
    store
        .mutate(input("event.purge", mid, Some(5), json!({})))
        .unwrap();
    assert!(store.snapshot(Query::default()).unwrap().events.is_empty());
}

#[test]
fn planning_calendar_file_import_atomic_deduplication_and_conflict() {
    let store = store();
    let calendar = store.snapshot(Query::default()).unwrap().calendars[0]
        .id
        .clone();
    let at = store::now() + 3600000;
    let entry = json!({"uid":"source-1","title":"Imported","time":timed(at,at+3600000)});
    let result = store
        .mutate(input(
            "calendar.import",
            Some(&calendar),
            Some(1),
            json!({"entries":[entry.clone(),entry.clone()]}),
        ))
        .unwrap()
        .item
        .unwrap();
    assert_eq!(result["imported"], 1);
    assert_eq!(result["skipped"], 1);
    assert!(store.mutate(input("calendar.import", Some(&calendar), Some(1), json!({"entries":[{"uid":"valid","title":"first","time":timed(at,at+3600000)},{"uid":"invalid","title":"invalid","time":timed(at,at-1)}]}))).is_err());
    let state = store.snapshot(Query::default()).unwrap();
    assert_eq!(state.events.len(), 1);
    assert_eq!(state.sources.len(), 1);
    store
        .mutate(input(
            "event.delete",
            Some(&state.events[0].id),
            Some(1),
            json!({}),
        ))
        .unwrap();
    let result = store
        .mutate(input(
            "calendar.import",
            Some(&calendar),
            Some(1),
            json!({"entries":[entry]}),
        ))
        .unwrap()
        .item
        .unwrap();
    assert_eq!(result["imported"], 0);
    assert_eq!(result["skipped"], 1);
    store
        .mutate(input(
            "calendar.update",
            Some(&calendar),
            Some(1),
            json!({"name":"Updated"}),
        ))
        .unwrap();
    assert_eq!(
        store
            .mutate(input(
                "calendar.import",
                Some(&calendar),
                Some(1),
                json!({"entries":[]})
            ))
            .unwrap()
            .status,
        "conflict"
    );
}

#[test]
fn planning_inline_task_creation_and_schedule_are_atomic() {
    let store = store();
    let calendar = store.snapshot(Query::default()).unwrap().calendars[0]
        .id
        .clone();
    let at = store::now() + 3600000;
    assert!(store
        .mutate(input(
            "todo.create",
            None,
            None,
            json!({"title":"Invalid task","schedule":{"calendarId":calendar,"time":timed(at,at-1)}})
        ))
        .is_err());
    assert!(store.snapshot(Query::default()).unwrap().todos.is_empty());
    assert!(store.snapshot(Query::default()).unwrap().events.is_empty());
    let request = input(
        "todo.create",
        None,
        None,
        json!({"title":"Scheduled inline","notes":"Details","schedule":{"calendarId":calendar,"time":timed(at,at+3600000)}}),
    );
    let created = store.mutate(request.clone()).unwrap().item.unwrap();
    assert!(store.mutate(request).unwrap().replayed);
    let state = store.snapshot(Query::default()).unwrap();
    assert_eq!(state.todos.len(), 1);
    assert_eq!(state.events.len(), 1);
    assert_eq!(state.events[0].todo_id.as_deref(), created["id"].as_str());
    assert_eq!(state.todos[0].notes, "Details");
    assert!(store.mutate(input("todo.create",None,None,json!({"title":"Invalid calendar","schedule":{"calendarId":"missing","time":timed(at,at+3600000)}}))).is_err());
    assert_eq!(store.snapshot(Query::default()).unwrap().todos.len(), 1);
}

#[test]
fn planning_subtasks_nest_recursively_and_preserve_schedules() {
    let store = store();
    let group = store
        .mutate(input("group.create", None, None, json!({"name":"工作"})))
        .unwrap()
        .item
        .unwrap();
    let parent = store
        .mutate(input(
            "todo.create",
            None,
            None,
            json!({"title":"准备周会","groupId":group["id"]}),
        ))
        .unwrap()
        .item
        .unwrap();
    let pid = parent["id"].as_str().unwrap();
    let child = store
        .mutate(input(
            "todo.create",
            None,
            None,
            json!({"title":"整理材料","parentId":pid}),
        ))
        .unwrap()
        .item
        .unwrap();
    let cid = child["id"].as_str().unwrap();
    assert_eq!(child["groupId"], group["id"]);
    let grandchild = store
        .mutate(input(
            "todo.create",
            None,
            None,
            json!({"title":"第三层","parentId":cid,"notes":"与主任务相同的字段","priority":"high"}),
        ))
        .unwrap()
        .item
        .unwrap();
    assert_eq!(grandchild["parentId"], cid);
    assert!(store
        .mutate(input(
            "todo.update",
            Some(pid),
            Some(1),
            json!({"parentId":cid})
        ))
        .is_err());
    assert!(store
        .mutate(input(
            "todo.update",
            Some(cid),
            Some(1),
            json!({"parentId":cid})
        ))
        .is_err());
    let before = store.export().unwrap();
    let at = store::now();
    store
        .mutate(input(
            "todo.schedule",
            Some(cid),
            Some(1),
            json!({"calendarId":before.calendars[0].id,"time":timed(at,at+3600000)}),
        ))
        .unwrap();
    store
        .mutate(input(
            "todo.update",
            Some(pid),
            Some(1),
            json!({"groupId":null}),
        ))
        .unwrap();
    let moved = store.export().unwrap();
    assert!(moved.todos.iter().all(|t| t.group_id.is_none()));
    assert_eq!(
        moved.todos.iter().find(|t| t.id == cid).unwrap().revision,
        2
    );
    store
        .mutate(input(
            "todo.update",
            Some(cid),
            Some(2),
            json!({"status":"completed"}),
        ))
        .unwrap();
    let result = store
        .mutate(input("todo.delete", Some(pid), Some(2), json!({})))
        .unwrap();
    assert_eq!(result.status, "ok");
    let after = store.export().unwrap();
    let child = after.todos.iter().find(|t| t.id == cid).unwrap();
    assert!(child.parent_id.is_none());
    assert!(child.deleted_at.is_none());
    assert_eq!(child.status, "completed");
    assert_eq!(
        serde_json::to_value(&after.events).unwrap(),
        serde_json::to_value(&moved.events).unwrap()
    );
    store
        .mutate(input(
            "todo.update",
            Some(cid),
            Some(child.revision),
            json!({"status":"open","parentId":null}),
        ))
        .unwrap();
    assert!(store
        .mutate(input(
            "todo.create",
            None,
            None,
            json!({"title":"已回收父任务","parentId":pid})
        ))
        .is_err());
}

#[test]
fn planning_task_content_is_shared_by_calendar_and_list() {
    let store = store();
    let calendar = store.export().unwrap().calendars[0].id.clone();
    let at = store::now();
    let task = store.mutate(input("todo.create",None,None,json!({"title":"原名称","notes":"原详情","schedule":{"calendarId":calendar,"time":timed(at,at+3600000)}}))).unwrap().item.unwrap();
    let tid = task["id"].as_str().unwrap();
    let original = store.export().unwrap().events[0].clone();
    store
        .mutate(input(
            "event.update",
            Some(&original.id),
            Some(original.revision),
            json!({"title":"日历修改名称","notes":"日历修改详情"}),
        ))
        .unwrap();
    let s = store.export().unwrap();
    assert_eq!(s.todos[0].title, "日历修改名称");
    assert_eq!(s.todos[0].notes, s.events[0].notes);
    assert!(s.events[0].title_override.is_none());
    assert_eq!(
        store
            .mutate(input(
                "todo.update",
                Some(tid),
                Some(1),
                json!({"title":"旧窗口覆盖"})
            ))
            .unwrap()
            .status,
        "conflict"
    );
    store
        .mutate(input(
            "todo.update",
            Some(tid),
            Some(s.todos[0].revision),
            json!({"title":"列表修改名称","notes":"列表修改详情"}),
        ))
        .unwrap();
    let updated = store.export().unwrap();
    assert_eq!(updated.events[0].title, "列表修改名称");
    assert_eq!(updated.events[0].notes, "列表修改详情");
    assert_eq!(
        store
            .mutate(input(
                "event.update",
                Some(&original.id),
                Some(s.events[0].revision),
                json!({"title":"过期日历编辑"})
            ))
            .unwrap()
            .status,
        "conflict"
    );
    assert!(store
        .mutate(input(
            "event.update",
            Some(&original.id),
            Some(updated.events[0].revision),
            json!({"title":"不应保存","time":timed(at,at-1)})
        ))
        .is_err());
    assert_eq!(store.export().unwrap().todos[0].title, "列表修改名称");
    // First-time scheduling can also edit shared task content atomically.
    assert!(store
        .mutate(input(
            "todo.schedule",
            Some(tid),
            Some(updated.todos[0].revision),
            json!({"calendarId":calendar,"time":timed(at,at-1),"title":"不应保存"})
        ))
        .is_err());
    assert_eq!(store.export().unwrap().todos[0].title, "列表修改名称");
    store.mutate(input(
        "todo.schedule", Some(tid), Some(updated.todos[0].revision),
        json!({"calendarId":calendar,"time":timed(at+3600000,at+7200000),"title":"排期时修改","notes":"新详情"})
    )).unwrap();
    let scheduled = store.export().unwrap();
    assert_eq!(scheduled.events.len(), 2);
    assert_eq!(scheduled.todos[0].title, "排期时修改");
    assert!(scheduled
        .events
        .iter()
        .all(|e| e.title == "排期时修改" && e.notes == "新详情"));
}

#[test]
fn planning_move_reorders_tree_atomically_and_rejects_stale_anchors() {
    let store = store();
    let a = store
        .mutate(input("todo.create", None, None, json!({"title":"A"})))
        .unwrap()
        .item
        .unwrap();
    let b = store
        .mutate(input("todo.create", None, None, json!({"title":"B"})))
        .unwrap()
        .item
        .unwrap();
    let c = store
        .mutate(input(
            "todo.create",
            None,
            None,
            json!({"title":"C","parentId":a["id"]}),
        ))
        .unwrap()
        .item
        .unwrap();
    let d = store
        .mutate(input(
            "todo.create",
            None,
            None,
            json!({"title":"D","parentId":c["id"]}),
        ))
        .unwrap()
        .item
        .unwrap();
    let aid = a["id"].as_str().unwrap();
    let bid = b["id"].as_str().unwrap();
    let request = input(
        "todo.move",
        Some(aid),
        Some(1),
        json!({"parentId":null,"beforeId":bid,"relativeRevision":1}),
    );
    assert_eq!(store.mutate(request.clone()).unwrap().status, "ok");
    assert!(store.mutate(request).unwrap().replayed);
    let s = store.export().unwrap();
    let a = s.todos.iter().find(|t| t.id == aid).unwrap();
    let b = s.todos.iter().find(|t| t.id == bid).unwrap();
    assert!(a.sort_order < b.sort_order);
    let seq = s.seq;
    assert!(store
        .mutate(input(
            "todo.move",
            Some(aid),
            Some(a.revision),
            json!({"afterId":bid,"relativeRevision":1})
        ))
        .is_err());
    assert_eq!(store.export().unwrap().seq, seq);
    assert!(store
        .mutate(input(
            "todo.move",
            Some(aid),
            Some(a.revision),
            json!({"parentId":d["id"]})
        ))
        .is_err());
    assert_eq!(store.export().unwrap().seq, seq);
    let group = store
        .mutate(input("group.create", None, None, json!({"name":"产品"})))
        .unwrap()
        .item
        .unwrap();
    store
        .mutate(input(
            "todo.move",
            Some(aid),
            Some(a.revision),
            json!({"parentId":null,"groupId":group["id"]}),
        ))
        .unwrap();
    let moved = store.export().unwrap();
    for task in moved.todos.iter().filter(|t| t.id != bid) {
        assert_eq!(task.group_id.as_deref(), group["id"].as_str());
    }
    let cid = c["id"].as_str().unwrap();
    let child = moved.todos.iter().find(|t| t.id == cid).unwrap();
    store
        .mutate(input(
            "todo.move",
            Some(cid),
            Some(child.revision),
            json!({"parentId":bid}),
        ))
        .unwrap();
    let moved = store.export().unwrap();
    assert!(moved
        .todos
        .iter()
        .find(|t| t.id == d["id"].as_str().unwrap())
        .unwrap()
        .group_id
        .is_none());
    let restored = super::tests::store();
    restored.import(moved.clone()).unwrap();
    assert_eq!(
        restored
            .export()
            .unwrap()
            .todos
            .iter()
            .map(|t| t.sort_order)
            .collect::<Vec<_>>(),
        moved.todos.iter().map(|t| t.sort_order).collect::<Vec<_>>()
    );
}

#[test]
fn planning_import_accepts_and_drops_legacy_project_and_links() {
    let store = store();
    store
        .mutate(input("todo.create", None, None, json!({"title":"Legacy"})))
        .unwrap();
    let mut backup = serde_json::to_value(store.export().unwrap()).unwrap();
    backup["todos"][0]["projectId"] = json!("project-a");
    backup["links"] = json!([{"id":"l","todoId":backup["todos"][0]["id"],"conversationId":"c","projectId":"project-a","status":"running","error":null,"createdAt":1,"updatedAt":1,"revision":1}]);
    let snapshot: Snapshot = serde_json::from_value(backup).unwrap();
    store.import(snapshot).unwrap();
    let exported = serde_json::to_value(store.export().unwrap()).unwrap();
    assert!(exported.get("links").is_none());
    assert!(exported["todos"][0].get("projectId").is_none());
    assert_eq!(exported["todos"][0]["title"], "Legacy");
}

#[test]
fn planning_google_tasks_import_maps_lists_subtasks_and_dedupes() {
    let store = store();
    let entries = json!([
        {"uid":"p","list":"Work","title":"Parent","status":"needsAction","dueDate":"2026-10-01"},
        {"uid":"c","list":"Work","title":"Child","parentUid":"p","status":"completed","completedAt":1},
        {"uid":"d","list":"My Tasks","title":"Default list task"},
        {"uid":"blank","list":"Work","title":"   "},
    ]);
    let result = store
        .mutate(input(
            "todo.import",
            None,
            None,
            json!({"entries": entries}),
        ))
        .unwrap();
    assert_eq!(result.item.unwrap(), json!({"imported":3,"skipped":1}));
    let s = store.export().unwrap();
    assert_eq!(s.groups.len(), 1);
    assert_eq!(s.groups[0].name, "Work");
    let parent = s.todos.iter().find(|t| t.title == "Parent").unwrap();
    let child = s.todos.iter().find(|t| t.title == "Child").unwrap();
    assert_eq!(parent.group_id.as_deref(), Some(s.groups[0].id.as_str()));
    assert_eq!(parent.due_date.as_deref(), Some("2026-10-01"));
    assert_eq!(child.parent_id.as_deref(), Some(parent.id.as_str()));
    assert_eq!(child.status, "completed");
    assert!(s
        .todos
        .iter()
        .any(|t| t.title == "Default list task" && t.group_id.is_none()));
    // Re-importing the same export adds nothing.
    let again = store
        .mutate(input(
            "todo.import",
            None,
            None,
            json!({"entries": entries}),
        ))
        .unwrap();
    assert_eq!(again.item.unwrap(), json!({"imported":0,"skipped":4}));
    assert!(store
        .mutate(input(
            "todo.import",
            None,
            None,
            json!({"entries":[{"uid":"x","title":"x","extra":1}]})
        ))
        .is_err());
}

#[test]
fn planning_subscriptions_keep_the_url_private_and_mirror_the_feed() {
    let store = store();
    assert_eq!(
        subscription::normalize_url(
            " webcal://calendar.google.com/calendar/ical/a/private-k/basic.ics "
        )
        .unwrap(),
        "https://calendar.google.com/calendar/ical/a/private-k/basic.ics"
    );
    assert!(subscription::normalize_url("file:///etc/passwd").is_err());
    let (calendar, _) = store
        .subscription(
            "subscription.create",
            &json!({"name":"Google","color":"#0F766E","url":"webcal://calendar.google.com/secret.ics","refreshMinutes":30}),
        )
        .unwrap();
    let id = calendar["id"].as_str().unwrap().to_string();
    assert_eq!(calendar["readOnly"], true);
    let snapshot = serde_json::to_string(&store.snapshot(Query::default()).unwrap()).unwrap();
    assert!(
        !snapshot.contains("secret.ics"),
        "snapshot must not expose the feed URL"
    );
    assert!(snapshot.contains("\"host\":\"calendar.google.com\""));
    assert!(store
        .subscription(
            "subscription.create",
            &json!({"name":"x","url":"https://a.b/c","refreshMinutes":7})
        )
        .is_err());

    // Due immediately, then leased so a second claim returns nothing.
    let at = store::now();
    assert_eq!(store.due_subscriptions(at).unwrap(), vec![id.clone()]);
    assert!(store.due_subscriptions(at).unwrap().is_empty());
    assert_eq!(
        store.subscription_url(&id).unwrap(),
        "https://calendar.google.com/secret.ics"
    );

    let event = |uid: &str, title: &str, start: i64| json!({"uid":uid,"title":title,"notes":"","time":{"kind":"timed","startAt":start,"endAt":start+3_600_000,"timeZone":"UTC"}});
    let (first, _) = store
        .sync_subscription(&id, &[event("a", "A", at), event("b", "B", at + 7_200_000)])
        .unwrap();
    assert_eq!(first, json!({"added":2,"updated":0,"removed":0}));
    let (second, _) = store
        .sync_subscription(&id, &[event("a", "A renamed", at)])
        .unwrap();
    assert_eq!(second, json!({"added":0,"updated":1,"removed":1}));
    let s = store.export().unwrap();
    let mirrored: Vec<_> = s.events.iter().filter(|e| e.calendar_id == id).collect();
    assert_eq!(mirrored.len(), 1);
    assert_eq!(mirrored[0].title, "A renamed");
    // Read-only: regular edits are rejected, the mirror is only changed by syncs.
    assert!(store
        .mutate(input(
            "event.update",
            Some(&mirrored[0].id),
            Some(mirrored[0].revision),
            json!({"title":"x"})
        ))
        .is_err());

    // Subscribed calendars can be renamed and recolored; invalid colors are rejected.
    store
        .subscription(
            "subscription.update",
            &json!({"id": id, "name": " 团队日程 ", "color": "#DB2777"}),
        )
        .unwrap();
    let calendar = store
        .export()
        .unwrap()
        .calendars
        .into_iter()
        .find(|c| c.id == id)
        .unwrap();
    assert_eq!(
        (calendar.name.as_str(), calendar.color.as_str()),
        ("团队日程", "#DB2777")
    );
    assert!(store
        .subscription("subscription.update", &json!({"id": id, "color": "red"}))
        .is_err());
    assert!(store
        .subscription("subscription.update", &json!({"id": id, "name": "  "}))
        .is_err());

    store.fail_subscription(&id, "HTTP 404").unwrap();
    let status = store.snapshot(Query::default()).unwrap().subscriptions;
    assert_eq!(status[0].last_error.as_deref(), Some("HTTP 404"));
    assert!(status[0].last_synced_at.is_some());

    store
        .subscription("subscription.delete", &json!({"id": id}))
        .unwrap();
    let s = store.export().unwrap();
    assert!(s.calendars.iter().all(|c| c.id != id));
    assert!(s.events.iter().all(|e| e.calendar_id != id));
    assert!(s.subscriptions.is_empty());
}

#[test]
fn planning_my_tasks_deletion_moves_or_recycles_and_sets_default_list() {
    let store = store();
    let create = |data: Value| {
        store
            .mutate(input("todo.create", None, None, data))
            .unwrap()
            .item
            .unwrap()
    };
    let group = |name: &str| {
        store
            .mutate(input("group.create", None, None, json!({ "name": name })))
            .unwrap()
            .item
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let parent = create(json!({"title":"父任务"}));
    let child = create(json!({"title":"子任务","parentId":parent["id"]}));
    let work = group("工作");
    let life = group("生活");
    let bad = store.mutate(input(
        "mytasks.delete",
        None,
        None,
        json!({"defaultGroupId":"missing"}),
    ));
    assert_eq!(bad.unwrap_err(), "E:category_missing");
    store
        .mutate(input(
            "mytasks.delete",
            None,
            None,
            json!({"defaultGroupId":work}),
        ))
        .unwrap();
    let s = store.snapshot(Query::default()).unwrap();
    assert_eq!(s.default_group_id.as_deref(), Some(work.as_str()));
    for id in [&parent["id"], &child["id"]] {
        let t = s.todos.iter().find(|t| json!(t.id) == *id).unwrap();
        assert_eq!(t.group_id.as_deref(), Some(work.as_str()));
        assert!(t.deleted_at.is_none());
    }
    assert_eq!(
        s.todos
            .iter()
            .find(|t| json!(t.id) == child["id"])
            .unwrap()
            .parent_id,
        parent["id"].as_str().map(str::to_string)
    );
    // Without a list, new and edited tasks land in the default list.
    let added = create(json!({"title":"新任务"}));
    assert_eq!(added["groupId"], json!(work));
    let moved = store
        .mutate(input(
            "todo.update",
            added["id"].as_str(),
            Some(1),
            json!({"groupId":null}),
        ))
        .unwrap()
        .item
        .unwrap();
    assert_eq!(moved["groupId"], json!(work));
    assert_eq!(
        store
            .mutate(input(
                "mytasks.delete",
                None,
                None,
                json!({"defaultGroupId":life}),
            ))
            .unwrap_err(),
        "E:my_tasks_deleted"
    );
    // Deleting another list moves its tasks into the default list.
    let errand = create(json!({"title":"买菜","groupId":life}));
    let life_revision = store
        .snapshot(Query::default())
        .unwrap()
        .groups
        .iter()
        .find(|g| g.id == life)
        .unwrap()
        .revision;
    store
        .mutate(input(
            "group.delete",
            Some(&life),
            Some(life_revision),
            json!({}),
        ))
        .unwrap();
    let s = store.snapshot(Query::default()).unwrap();
    let t = s
        .todos
        .iter()
        .find(|t| json!(t.id) == errand["id"])
        .unwrap();
    assert_eq!(t.group_id.as_deref(), Some(work.as_str()));
    // Deleting the default list brings My Tasks back.
    let work_revision = s.groups.iter().find(|g| g.id == work).unwrap().revision;
    store
        .mutate(input(
            "group.delete",
            Some(&work),
            Some(work_revision),
            json!({}),
        ))
        .unwrap();
    let s = store.snapshot(Query::default()).unwrap();
    assert!(s.default_group_id.is_none());
    assert!(s.todos.iter().all(|t| t.group_id.is_none()));
}

#[test]
fn planning_my_tasks_deletion_can_recycle_tasks() {
    let store = store();
    let t = store
        .mutate(input("todo.create", None, None, json!({"title":"旧任务"})))
        .unwrap()
        .item
        .unwrap();
    let list = store
        .mutate(input("group.create", None, None, json!({"name":"收件箱"})))
        .unwrap()
        .item
        .unwrap();
    store
        .mutate(input(
            "mytasks.delete",
            None,
            None,
            json!({"defaultGroupId":list["id"],"deleteTasks":true}),
        ))
        .unwrap();
    let s = store.snapshot(Query::default()).unwrap();
    let old = s.todos.iter().find(|x| json!(x.id) == t["id"]).unwrap();
    assert!(old.deleted_at.is_some());
    assert_eq!(old.group_id.as_deref(), list["id"].as_str());
    // Restoring from the trash keeps the task in the new default list.
    store
        .mutate(input(
            "todo.restore",
            t["id"].as_str(),
            Some(old.revision),
            json!({}),
        ))
        .unwrap();
    let s = store.snapshot(Query::default()).unwrap();
    let back = s.todos.iter().find(|x| json!(x.id) == t["id"]).unwrap();
    assert!(back.deleted_at.is_none());
    assert_eq!(back.group_id.as_deref(), list["id"].as_str());
}

#[test]
fn planning_event_notification_overrides_calendar_default() {
    let store = store();
    let s = store.snapshot(Query::default()).unwrap();
    let at = store::now() + 2 * 3_600_000;
    let pending = |store: &PlanningStore| {
        store
            .snapshot(Query::default())
            .unwrap()
            .reminders
            .into_iter()
            .filter(|r| r.status == "pending")
            .map(|r| r.trigger_at)
            .collect::<Vec<_>>()
    };
    let e = store
        .mutate(input(
            "event.create",
            None,
            None,
            json!({"title":"评审","calendarId":s.calendars[0].id,"time":timed(at,at+3_600_000),"reminderMinutes":30}),
        ))
        .unwrap()
        .item
        .unwrap();
    assert_eq!(pending(&store), vec![at - 30 * 60_000]);
    let id = e["id"].as_str().unwrap();
    store
        .mutate(input(
            "event.update",
            Some(id),
            Some(1),
            json!({"reminderMinutes":-1}),
        ))
        .unwrap();
    assert!(pending(&store).is_empty());
    // Null follows the calendar default again (0 minutes for the built-in calendar).
    store
        .mutate(input(
            "event.update",
            Some(id),
            Some(2),
            json!({"reminderMinutes":null}),
        ))
        .unwrap();
    assert_eq!(pending(&store), vec![at]);
    assert_eq!(
        store
            .mutate(input(
                "event.update",
                Some(id),
                Some(3),
                json!({"reminderMinutes":20000}),
            ))
            .unwrap_err(),
        "E:reminder_offset_invalid"
    );
}

#[test]
fn planning_snapshot_uses_global_default_zone() {
    time::set_test_zone(Some("Pacific/Auckland"));
    let store = store();
    let s = store.snapshot(Query::default()).unwrap();
    assert_eq!(s.time_zone, "Pacific/Auckland");
    time::set_test_zone(Some("America/Chicago"));
    assert_eq!(
        store.snapshot(Query::default()).unwrap().time_zone,
        "America/Chicago"
    );
    time::set_test_zone(None);
}

#[test]
fn planning_timezone_set_is_rejected_as_global() {
    time::set_test_zone(Some("Asia/Shanghai"));
    let store = store();
    let seq = store.snapshot(Query::default()).unwrap().seq;
    let error = store
        .mutate(input(
            "timezone.set",
            None,
            Some(seq),
            json!({"timeZone":"Europe/London"}),
        ))
        .unwrap_err();
    assert_eq!(error, "E:timezone_global");
    let s = store.snapshot(Query::default()).unwrap();
    assert_eq!(s.time_zone, "Asia/Shanghai");
    assert_eq!(s.seq, seq);
    time::set_test_zone(None);
}

#[test]
fn planning_date_due_reminder_fires_at_default_zone_midnight() {
    time::set_test_zone(Some("Asia/Tokyo"));
    let store = store();
    store
        .mutate(input(
            "todo.create",
            None,
            None,
            json!({"title":"Due","dueDate":"2099-03-10","dueReminder":true,"reminderMinutes":0}),
        ))
        .unwrap();
    let tokyo_midnight = time::midnight("2099-03-10", "Asia/Tokyo").unwrap();
    let s = store.snapshot(Query::default()).unwrap();
    assert_eq!(s.reminders.len(), 1);
    assert_eq!(s.reminders[0].trigger_at, tokyo_midnight);

    // 切换全局时区后同步:提醒按新时区午夜重算,seq 前进;再次同步无变化。
    time::set_test_zone(Some("America/Los_Angeles"));
    let synced = store.sync_default_zone(store::now()).unwrap();
    assert_eq!(synced, Some(s.seq + 1));
    let la_midnight = time::midnight("2099-03-10", "America/Los_Angeles").unwrap();
    let s = store.snapshot(Query::default()).unwrap();
    assert_eq!(s.reminders.len(), 1);
    assert_eq!(s.reminders[0].trigger_at, la_midnight);
    assert_ne!(la_midnight, tokyo_midnight);
    assert_eq!(store.sync_default_zone(store::now()).unwrap(), None);
    time::set_test_zone(None);
}

#[test]
fn planning_yearly_recurrence_repeats_on_the_same_date() {
    let store = store();
    let s = store.snapshot(Query::default()).unwrap();
    let e = store.mutate(input("event.create",None,None,json!({"title":"Birthday","calendarId":s.calendars[0].id,"time":{"kind":"allDay","startDate":"2026-10-05","endDateExclusive":"2026-10-06","timeZone":"Asia/Shanghai"},"recurrence":{"frequency":"yearly","interval":1,"count":3}}))).unwrap().item.unwrap();
    let master: Event = serde_json::from_value(e).unwrap();
    let days: Vec<_> = time::occurrences(&master, 0, i64::MAX / 2)
        .unwrap()
        .into_iter()
        .map(|event| event.original_date.unwrap())
        .collect();
    assert_eq!(days, ["2026-10-05", "2027-10-05", "2028-10-05"]);
}

#[test]
fn planning_split_series_keeps_total_count_and_deleted_occurrences() {
    let store = store();
    let s = store.snapshot(Query::default()).unwrap();
    let e = store.mutate(input("event.create",None,None,json!({"title":"Standup","calendarId":s.calendars[0].id,"time":{"kind":"allDay","startDate":"2026-10-01","endDateExclusive":"2026-10-02","timeZone":"Asia/Shanghai"},"recurrence":{"frequency":"daily","interval":1,"count":5}}))).unwrap().item.unwrap();
    let id = e["id"].as_str().unwrap();
    store
        .mutate(input(
            "event.exception",
            Some(id),
            Some(1),
            json!({"date":"2026-10-04","delete":true}),
        ))
        .unwrap();
    assert!(store
        .mutate(input(
            "event.split",
            Some(id),
            Some(2),
            json!({"date":"2026-10-01","delete":true})
        ))
        .is_err());
    let next: Event = serde_json::from_value(
        store
            .mutate(input(
                "event.split",
                Some(id),
                Some(2),
                json!({"date":"2026-10-03","title":"Sync"}),
            ))
            .unwrap()
            .item
            .unwrap(),
    )
    .unwrap();
    let dates = |event: &Event| -> Vec<String> {
        time::occurrences(event, 0, i64::MAX / 2)
            .unwrap()
            .into_iter()
            .map(|e| e.original_date.unwrap())
            .collect()
    };
    assert_eq!(next.title, "Sync");
    assert_eq!(dates(&next), ["2026-10-03", "2026-10-05"]);
    let s = store.snapshot(Query::default()).unwrap();
    let old = s.events.iter().find(|e| e.id == id).unwrap();
    assert_eq!(dates(old), ["2026-10-01", "2026-10-02"]);
    assert!(!s.events.iter().any(|e| e.series_id.as_deref() == Some(id)));
    // Deleting "this and following" only shortens the series.
    store
        .mutate(input(
            "event.split",
            Some(&next.id),
            Some(1),
            json!({"date":"2026-10-05","delete":true}),
        ))
        .unwrap();
    let s = store.snapshot(Query::default()).unwrap();
    let next = s.events.iter().find(|e| e.id == next.id).unwrap();
    assert_eq!(dates(next), ["2026-10-03"]);
}

#[test]
fn planning_colors_are_validated_and_editable_for_every_layer() {
    let store = store();
    let list = store
        .mutate(input(
            "group.create",
            None,
            None,
            json!({"name":"Work","color":"#7C3AED"}),
        ))
        .unwrap()
        .item
        .unwrap();
    assert_eq!(list["color"], "#7C3AED");
    assert_eq!(
        store
            .mutate(input(
                "group.update",
                list["id"].as_str(),
                Some(1),
                json!({"color":"red"})
            ))
            .unwrap_err()
            .to_string(),
        "E:invalid_color"
    );
    // The built-in "My Tasks" keeps its color in the store, not on a group row.
    store
        .mutate(input(
            "mytasks.update",
            None,
            None,
            json!({"color":"#DB2777"}),
        ))
        .unwrap();
    assert_eq!(
        store
            .snapshot(Query::default())
            .unwrap()
            .my_tasks_color
            .as_deref(),
        Some("#DB2777")
    );
    // A subscribed (read-only) calendar may change color, but nothing else.
    let (calendar, _) = store
        .subscription(
            "subscription.create",
            &json!({"name":"Google","color":"#0F766E","url":"https://calendar.google.com/a.ics","refreshMinutes":30}),
        )
        .unwrap();
    let id = calendar["id"].as_str().unwrap();
    store
        .mutate(input(
            "calendar.update",
            Some(id),
            Some(1),
            json!({"color":"#16A34A"}),
        ))
        .unwrap();
    assert_eq!(
        store
            .mutate(input(
                "calendar.update",
                Some(id),
                Some(2),
                json!({"name":"Mine"})
            ))
            .unwrap_err()
            .to_string(),
        "E:calendar_read_only"
    );
    assert!(store
        .subscription("subscription.update", &json!({"id":id,"color":"blue"}))
        .is_err());
}

#[test]
fn planning_writes_wait_for_a_concurrent_writer_instead_of_failing() {
    // 共用 config.sqlite 的其它连接（通知服务等）在日程事务读与写之间提交时，
    // DEFERRED 事务会立即得到 SQLITE_BUSY_SNAPSHOT；IMMEDIATE 事务应等待后成功。
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.sqlite");
    let store = PlanningStore::with_connection(rusqlite::Connection::open(&path).unwrap()).unwrap();
    let calendar = store.snapshot(Query::default()).unwrap().calendars[0]
        .id
        .clone();
    let other = rusqlite::Connection::open(&path).unwrap();
    other
        .execute_batch("CREATE TABLE other_writer(v INTEGER); BEGIN IMMEDIATE; INSERT INTO other_writer VALUES (1);")
        .unwrap();
    let writer = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        other.execute_batch("COMMIT;").unwrap();
    });
    std::thread::sleep(std::time::Duration::from_millis(50));
    let result = store.mutate(input(
        "event.create",
        None,
        None,
        json!({"title":"Concurrent","calendarId":calendar,"time":{"kind":"timed","startAt":4_000_000_000_000i64,"endAt":4_000_003_600_000i64,"timeZone":"UTC"}}),
    ));
    writer.join().unwrap();
    assert_eq!(result.unwrap().status, "ok");
    assert!(store.claim_reminders(store::now()).is_ok());
}

#[test]
fn planning_reminder_is_stale_a_day_after_trigger_or_snooze() {
    let mut reminder = Reminder {
        id: "event:t1".into(),
        target_type: "event".into(),
        target_id: "t1".into(),
        title: "周会".into(),
        origin: "event_start".into(),
        trigger_at: 1_000_000,
        snoozed_until: None,
        status: "pending".into(),
        notified_at: None,
        lease_until: None,
        attempts: 0,
        next_attempt_at: 0,
        revision: 1,
    };
    let due = 1_000_000 + super::STALE_REMINDER_MS;
    assert!(!super::is_stale_reminder(&reminder, due));
    assert!(super::is_stale_reminder(&reminder, due + 1));
    // 稍后提醒按新的到点时间计算。
    reminder.snoozed_until = Some(due);
    assert!(!super::is_stale_reminder(&reminder, due + 1));
}
