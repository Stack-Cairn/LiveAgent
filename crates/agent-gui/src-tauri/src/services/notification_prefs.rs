//! Desktop notification switches and localized labels.
//!
//! The switches live in the frontend's device-local settings and are pushed
//! here (`notifications_set_preferences`) together with labels in the UI
//! language, because the backend has no locale of its own. Until the first
//! push nothing is known, and background notifiers hold off instead of
//! guessing: a user who turned notifications off must not get one at startup.
//!
//! Each category also remembers when it was off during this process, so an
//! event that happened while off (a cron run finishing, a reminder coming due)
//! is never notified after the switch is turned back on.

use serde::Deserialize;
use std::sync::{LazyLock, RwLock};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationPreferences {
    /// Master switch.
    pub enabled: bool,
    /// Calendar reminders.
    pub calendar: bool,
    /// Scheduled cron task results.
    pub cron: bool,
}

impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            enabled: true,
            calendar: true,
            cron: true,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationLabels {
    pub cron_succeeded: String,
    pub cron_failed: String,
    pub cron_timed_out: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    Calendar,
    Cron,
}

const CATEGORIES: [Category; 2] = [Category::Calendar, Category::Cron];
const LABEL_MAX_CHARS: usize = 120;
const MAX_OFF_INTERVALS: usize = 32;

/// Off periods of one category: `[from, to)`, `to == None` while still off.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct OffIntervals(Vec<(i64, Option<i64>)>);

impl OffIntervals {
    fn contains(&self, at: i64) -> bool {
        self.0
            .iter()
            .any(|(from, to)| *from <= at && to.is_none_or(|to| at < to))
    }

    fn update(&mut self, was_allowed: bool, allowed: bool, now: i64) {
        match (was_allowed, allowed) {
            (true, false) => {
                self.0.push((now, None));
                if self.0.len() > MAX_OFF_INTERVALS {
                    self.0.remove(0);
                }
            }
            (false, true) => {
                if let Some(last) = self.0.last_mut() {
                    if last.1.is_none() {
                        last.1 = Some(now);
                    }
                }
            }
            _ => {}
        }
    }
}

/// Pure state machine behind the global, so tests can drive time.
#[derive(Clone, Debug)]
struct Tracker {
    started_at: i64,
    preferences: Option<NotificationPreferences>,
    labels: NotificationLabels,
    calendar_off: OffIntervals,
    cron_off: OffIntervals,
}

impl Tracker {
    fn new(started_at: i64) -> Self {
        Self {
            started_at,
            preferences: None,
            labels: NotificationLabels::default(),
            calendar_off: OffIntervals::default(),
            cron_off: OffIntervals::default(),
        }
    }

    fn off_mut(&mut self, category: Category) -> &mut OffIntervals {
        match category {
            Category::Calendar => &mut self.calendar_off,
            Category::Cron => &mut self.cron_off,
        }
    }

    fn off(&self, category: Category) -> &OffIntervals {
        match category {
            Category::Calendar => &self.calendar_off,
            Category::Cron => &self.cron_off,
        }
    }

    fn set(&mut self, preferences: NotificationPreferences, labels: NotificationLabels, now: i64) {
        let previous = self.preferences;
        let started_at = self.started_at;
        for category in CATEGORIES {
            let allowed = category_allowed(preferences, category);
            match previous {
                // First push: if off, it has effectively been off since startup.
                None if !allowed => self.off_mut(category).0.push((started_at, None)),
                None => {}
                Some(previous) => {
                    let was_allowed = category_allowed(previous, category);
                    self.off_mut(category).update(was_allowed, allowed, now);
                }
            }
        }
        self.preferences = Some(preferences);
        self.labels = labels;
    }

    fn allows(&self, category: Category) -> Option<bool> {
        Some(category_allowed(self.preferences?, category))
    }

    /// Whether an event at `at` must stay silent for `category`: the
    /// preferences are still unknown, or the category was off at that time.
    fn suppressed(&self, category: Category, at: i64) -> bool {
        self.preferences.is_none() || self.off(category).contains(at)
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

static STATE: LazyLock<RwLock<Tracker>> = LazyLock::new(|| RwLock::new(Tracker::new(now_ms())));

/// Pins the process start time; call once at startup.
pub fn init() {
    LazyLock::force(&STATE);
}

fn clip(label: String) -> String {
    label.trim().chars().take(LABEL_MAX_CHARS).collect()
}

pub fn set(preferences: NotificationPreferences, labels: NotificationLabels) {
    let labels = NotificationLabels {
        cron_succeeded: clip(labels.cron_succeeded),
        cron_failed: clip(labels.cron_failed),
        cron_timed_out: clip(labels.cron_timed_out),
    };
    if let Ok(mut state) = STATE.write() {
        state.set(preferences, labels, now_ms());
    }
}

/// `None` until the frontend has pushed its preferences.
pub fn allows(category: Category) -> Option<bool> {
    STATE.read().ok()?.allows(category)
}

/// See [`Tracker::suppressed`]; a poisoned lock counts as suppressed.
pub fn suppressed(category: Category, at: i64) -> bool {
    STATE
        .read()
        .map(|state| state.suppressed(category, at))
        .unwrap_or(true)
}

pub fn labels() -> NotificationLabels {
    STATE
        .read()
        .map(|state| state.labels.clone())
        .unwrap_or_default()
}

pub fn category_allowed(preferences: NotificationPreferences, category: Category) -> bool {
    preferences.enabled
        && match category {
            Category::Calendar => preferences.calendar,
            Category::Cron => preferences.cron,
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prefs(enabled: bool, calendar: bool, cron: bool) -> NotificationPreferences {
        NotificationPreferences {
            enabled,
            calendar,
            cron,
        }
    }

    #[test]
    fn master_switch_gates_every_category() {
        let off = prefs(false, true, true);
        assert!(!category_allowed(off, Category::Calendar));
        assert!(!category_allowed(off, Category::Cron));
    }

    #[test]
    fn module_switches_are_independent() {
        let preferences = prefs(true, false, true);
        assert!(!category_allowed(preferences, Category::Calendar));
        assert!(category_allowed(preferences, Category::Cron));
    }

    #[test]
    fn missing_fields_default_to_on() {
        let preferences: NotificationPreferences =
            serde_json::from_value(serde_json::json!({ "cron": false })).unwrap();
        assert_eq!(preferences, prefs(true, true, false));
    }

    #[test]
    fn unknown_preferences_suppress_everything() {
        let tracker = Tracker::new(100);
        assert_eq!(tracker.allows(Category::Cron), None);
        assert!(tracker.suppressed(Category::Cron, 50));
        assert!(tracker.suppressed(Category::Calendar, 500));
    }

    #[test]
    fn first_push_on_keeps_startup_window_open() {
        let mut tracker = Tracker::new(100);
        tracker.set(prefs(true, true, true), NotificationLabels::default(), 200);
        // Due before startup (app was closed) or before the push: still notified.
        assert!(!tracker.suppressed(Category::Calendar, 50));
        assert!(!tracker.suppressed(Category::Cron, 150));
    }

    #[test]
    fn first_push_off_counts_as_off_since_startup() {
        let mut tracker = Tracker::new(100);
        tracker.set(prefs(true, true, false), NotificationLabels::default(), 200);
        assert!(tracker.suppressed(Category::Cron, 150));
        assert!(!tracker.suppressed(Category::Cron, 50));
        assert!(!tracker.suppressed(Category::Calendar, 150));
    }

    #[test]
    fn events_inside_an_off_window_stay_silent_after_turning_back_on() {
        let mut tracker = Tracker::new(0);
        tracker.set(prefs(true, true, true), NotificationLabels::default(), 0);
        tracker.set(
            prefs(true, true, false),
            NotificationLabels::default(),
            1_000,
        );
        tracker.set(
            prefs(true, true, true),
            NotificationLabels::default(),
            2_000,
        );
        assert!(!tracker.suppressed(Category::Cron, 999));
        assert!(tracker.suppressed(Category::Cron, 1_500));
        assert!(!tracker.suppressed(Category::Cron, 2_000));
        assert_eq!(tracker.allows(Category::Cron), Some(true));
    }

    #[test]
    fn master_switch_off_window_applies_to_all_categories() {
        let mut tracker = Tracker::new(0);
        tracker.set(prefs(true, true, true), NotificationLabels::default(), 0);
        tracker.set(
            prefs(false, true, true),
            NotificationLabels::default(),
            1_000,
        );
        assert!(tracker.suppressed(Category::Calendar, 5_000));
        assert!(tracker.suppressed(Category::Cron, 5_000));
    }
}
