use std::sync::{Arc, Mutex};

use serde_json::json;

use super::*;

type Calls = Arc<Mutex<Vec<(String, String)>>>;

fn service() -> (NotificationService, Calls) {
    let service = NotificationService::new();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&calls);
    service.set_sender(Arc::new(move |title: &str, body: &str| {
        sink.lock()
            .unwrap()
            .push((title.to_string(), body.to_string()));
        Ok(())
    }));
    (service, calls)
}

#[test]
fn notifications_preferences_default_and_tolerate_bad_values() {
    let defaults = NotificationPreferences::default();
    assert!(defaults.planning && defaults.cron_failure && defaults.agent);
    assert!(!defaults.cron_success);
    assert_eq!(NotificationPreferences::from_value(None), defaults);
    assert_eq!(
        NotificationPreferences::from_value(Some(&json!("x"))),
        defaults
    );
    let parsed = NotificationPreferences::from_value(Some(
        &json!({ "planning": false, "cronSuccess": true, "agent": "yes" }),
    ));
    assert!(!parsed.planning);
    assert!(parsed.cron_success);
    assert!(parsed.cron_failure);
    assert!(parsed.agent, "non-bool falls back to the default");
    assert_eq!(
        parsed.to_value(),
        json!({ "planning": false, "cronFailure": true, "cronSuccess": true, "agent": true })
    );
}

#[test]
fn notifications_respect_category_switches() {
    let (service, calls) = service();
    let off = NotificationPreferences {
        planning: false,
        cron_failure: false,
        cron_success: false,
        agent: false,
    };
    for kind in [
        NotificationKind::PlanningReminder,
        NotificationKind::CronFailure,
        NotificationKind::CronSuccess,
        NotificationKind::AgentMessage,
    ] {
        let outcome = service.notify_with(&off, 0, Notice::new(kind, "t", "b"));
        assert_eq!(outcome, Ok(NotifyOutcome::Disabled));
    }
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn notifications_throttle_per_key_within_the_interval() {
    let (service, calls) = service();
    let prefs = NotificationPreferences::default();
    let notice =
        || Notice::new(NotificationKind::CronFailure, "fail", "").throttled("cron:a", 1_000);
    assert_eq!(
        service.notify_with(&prefs, 10_000, notice()),
        Ok(NotifyOutcome::Sent)
    );
    assert_eq!(
        service.notify_with(&prefs, 10_500, notice()),
        Ok(NotifyOutcome::Throttled)
    );
    // 其它键不受影响；窗口过后恢复。
    let other = Notice::new(NotificationKind::CronFailure, "fail", "").throttled("cron:b", 1_000);
    assert_eq!(
        service.notify_with(&prefs, 10_500, other),
        Ok(NotifyOutcome::Sent)
    );
    assert_eq!(
        service.notify_with(&prefs, 11_000, notice()),
        Ok(NotifyOutcome::Sent)
    );
    assert_eq!(calls.lock().unwrap().len(), 3);
}

#[test]
fn notifications_failed_delivery_does_not_start_the_throttle_window() {
    let (service, _) = service();
    let attempts = Arc::new(Mutex::new(0u32));
    let counter = Arc::clone(&attempts);
    service.set_sender(Arc::new(move |_: &str, _: &str| {
        let mut count = counter.lock().unwrap();
        *count += 1;
        if *count == 1 {
            Err("boom".to_string())
        } else {
            Ok(())
        }
    }));
    let prefs = NotificationPreferences::default();
    let notice =
        || Notice::new(NotificationKind::CronFailure, "fail", "").throttled("cron:a", 1_000);
    assert_eq!(
        service.notify_with(&prefs, 0, notice()),
        Err("boom".to_string())
    );
    assert_eq!(
        service.notify_with(&prefs, 1, notice()),
        Ok(NotifyOutcome::Sent)
    );
    assert_eq!(*attempts.lock().unwrap(), 2);
}

#[test]
fn notifications_concurrent_same_key_is_throttled_while_other_keys_can_send() {
    use std::sync::{mpsc, Condvar};
    use std::time::Duration;

    let service = Arc::new(NotificationService::new());
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let gate = Arc::clone(&release);
    let (entered_tx, entered_rx) = mpsc::channel();
    service.set_sender(Arc::new(move |title, _| {
        if title == "first" {
            entered_tx.send(()).unwrap();
            let (lock, wake) = &*gate;
            let guard = lock.lock().unwrap();
            drop(wake.wait_while(guard, |released| !*released).unwrap());
        }
        Ok(())
    }));
    let first_service = Arc::clone(&service);
    let first = std::thread::spawn(move || {
        first_service.notify_with(
            &NotificationPreferences::default(),
            10_000,
            Notice::new(NotificationKind::AgentMessage, "first", "").throttled("agent", 30_000),
        )
    });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let same = service.notify_with(
        &NotificationPreferences::default(),
        10_001,
        Notice::new(NotificationKind::AgentMessage, "second", "").throttled("agent", 30_000),
    );
    let other = service.notify_with(
        &NotificationPreferences::default(),
        10_001,
        Notice::new(NotificationKind::CronFailure, "other", "").throttled("cron:other", 30_000),
    );
    *release.0.lock().unwrap() = true;
    release.1.notify_all();
    assert_eq!(first.join().unwrap(), Ok(NotifyOutcome::Sent));
    assert_eq!(same, Ok(NotifyOutcome::Throttled));
    assert_eq!(other, Ok(NotifyOutcome::Sent));
}

#[test]
fn notifications_clean_text_and_require_a_title() {
    let (service, calls) = service();
    let prefs = NotificationPreferences::default();
    let long = "x".repeat(600);
    let notice = Notice::new(NotificationKind::AgentMessage, " done\n\tnow \u{7}", long);
    assert_eq!(
        service.notify_with(&prefs, 0, notice),
        Ok(NotifyOutcome::Sent)
    );
    let (title, body) = calls.lock().unwrap()[0].clone();
    assert_eq!(title, "done  now");
    assert_eq!(body.chars().count(), BODY_MAX_CHARS);
    assert!(body.ends_with('…'));
    let empty = Notice::new(NotificationKind::AgentMessage, " \n ", "b");
    assert_eq!(
        service.notify_with(&prefs, 0, empty),
        Err("E:title_required".to_string())
    );
}

#[test]
fn notifications_labels_fall_back_and_fill_placeholders() {
    let (service, _) = service();
    assert_eq!(
        service.label(
            "cronFailureTitle",
            "Scheduled task failed: {name}",
            &[("name", "Backup")]
        ),
        "Scheduled task failed: Backup"
    );
    service.set_labels(HashMap::from([(
        "cronFailureTitle".to_string(),
        "定时任务失败：{name}".to_string(),
    )]));
    assert_eq!(
        service.label("cronFailureTitle", "unused", &[("name", "备份")]),
        "定时任务失败：备份"
    );
}

#[test]
fn notifications_system_settings_url_is_platform_specific() {
    let url = system_settings_url("com.example.app");
    if cfg!(target_os = "macos") {
        assert!(url.unwrap().ends_with("id=com.example.app"));
    } else if cfg!(target_os = "windows") {
        assert_eq!(url.unwrap(), "ms-settings:notifications");
    } else {
        assert_eq!(url, Err("E:unsupported".to_string()));
    }
}

#[test]
fn notifications_permission_denied_is_reported_but_not_an_error() {
    let (service, _) = service();
    service.set_sender(Arc::new(|_: &str, _: &str| {
        Err(PERMISSION_DENIED.to_string())
    }));
    let outcome = service.notify_with(
        &NotificationPreferences::default(),
        0,
        Notice::new(NotificationKind::PlanningReminder, "t", "b"),
    );
    assert_eq!(outcome, Ok(NotifyOutcome::PermissionDenied));
    assert_eq!(service.permission(), PermissionState::Unknown);
}

#[test]
fn notifications_permission_denied_releases_the_in_flight_key() {
    let (service, _) = service();
    let notice =
        || Notice::new(NotificationKind::AgentMessage, "title", "").throttled("agent", 30_000);
    service.set_sender(Arc::new(|_, _| Err(PERMISSION_DENIED.to_string())));
    assert_eq!(
        service.notify_with(&NotificationPreferences::default(), 0, notice()),
        Ok(NotifyOutcome::PermissionDenied)
    );
    service.set_sender(Arc::new(|_, _| Ok(())));
    assert_eq!(
        service.notify_with(&NotificationPreferences::default(), 1, notice()),
        Ok(NotifyOutcome::Sent)
    );
}
