use super::types::{Event, EventTime};
use chrono::{Datelike, Duration, LocalResult, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;

pub fn date(value: &str) -> Result<NaiveDate, String> {
    if value.len() != 10 {
        return Err("E:date_format".into());
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| "E:date_invalid".into())
}
pub fn zone(value: &str) -> Result<Tz, String> {
    value.parse().map_err(|_| "E:timezone_invalid".into())
}
pub fn midnight(value: &str, time_zone: &str) -> Result<i64, String> {
    let day = date(value)?;
    let tz = zone(time_zone)?;
    // 某些地区在午夜跳时：取当天第一个有效分钟，而不是按 24h 推算。
    for minute in 0..180 {
        let naive = day.and_hms_opt(0, 0, 0).unwrap() + Duration::minutes(minute);
        if let Some(time) = tz.from_local_datetime(&naive).earliest() {
            return Ok(time.timestamp_millis());
        }
    }
    Err("E:midnight_missing".into())
}
pub fn bounds(time: &EventTime) -> Result<(i64, i64), String> {
    let (start, end) = match time {
        EventTime::Timed {
            start_at,
            end_at,
            time_zone,
        } => {
            zone(time_zone)?;
            if Utc.timestamp_millis_opt(*start_at).single().is_none()
                || Utc.timestamp_millis_opt(*end_at).single().is_none()
            {
                return Err("E:timestamp_invalid".into());
            }
            (*start_at, *end_at)
        }
        EventTime::AllDay {
            start_date,
            end_date_exclusive,
            time_zone,
        } => (
            midnight(start_date, time_zone)?,
            midnight(end_date_exclusive, time_zone)?,
        ),
    };
    if end <= start
        || end
            .checked_sub(start)
            .is_none_or(|span| span > 366 * 86_400_000)
    {
        return Err("E:event_range".into());
    }
    if matches!(time, EventTime::Timed { .. }) && end - start < 15 * 60_000 {
        return Err("E:block_min_duration".into());
    }
    Ok((start, end))
}

pub fn local_date(time: &EventTime) -> Result<String, String> {
    match time {
        EventTime::AllDay { start_date, .. } => Ok(start_date.clone()),
        EventTime::Timed {
            start_at,
            time_zone,
            ..
        } => Ok(zone(time_zone)?
            .timestamp_millis_opt(*start_at)
            .single()
            .ok_or("E:time_invalid")?
            .format("%Y-%m-%d")
            .to_string()),
    }
}

pub fn on_date(time: &EventTime, day: NaiveDate) -> Result<EventTime, String> {
    match time {
        EventTime::AllDay {
            start_date,
            end_date_exclusive,
            time_zone,
        } => {
            let span = date(end_date_exclusive)? - date(start_date)?;
            Ok(EventTime::AllDay {
                start_date: day.to_string(),
                end_date_exclusive: (day + span).to_string(),
                time_zone: time_zone.clone(),
            })
        }
        EventTime::Timed {
            start_at,
            end_at,
            time_zone,
        } => {
            let tz = zone(time_zone)?;
            let original = tz
                .timestamp_millis_opt(*start_at)
                .single()
                .ok_or("E:time_invalid")?;
            let mapped = tz.from_local_datetime(&day.and_time(original.time()));
            let start = match mapped {
                LocalResult::Single(t) => t,
                LocalResult::Ambiguous(a, _) => a,
                LocalResult::None => return Err("E:recurrence_dst_gap".into()),
            }
            .timestamp_millis();
            Ok(EventTime::Timed {
                start_at: start,
                end_at: start + end_at - start_at,
                time_zone: time_zone.clone(),
            })
        }
    }
}

/// 单一 recurrence master 按日期展开；例外日期从 master 排除，修改实例是普通 exception 行。
pub fn occurrences(event: &Event, from: i64, to: i64) -> Result<Vec<Event>, String> {
    occurrences_limit(event, from, to, 10_000)
}
pub fn next_occurrence(event: &Event, from: i64) -> Result<Option<Event>, String> {
    Ok(
        occurrences_limit(event, from, from + 100 * 366 * 86_400_000, 1)?
            .into_iter()
            .next(),
    )
}
fn occurrences_limit(
    event: &Event,
    from: i64,
    to: i64,
    limit: usize,
) -> Result<Vec<Event>, String> {
    let Some(rule) = &event.recurrence else {
        let (start, end) = bounds(&event.time)?;
        return Ok(if start < to && end > from {
            vec![event.clone()]
        } else {
            vec![]
        });
    };
    if rule.interval == 0
        || rule.interval > 365
        || !["daily", "weekly", "monthly"].contains(&rule.frequency.as_str())
    {
        return Err("E:recurrence_invalid".into());
    }
    if rule.weekdays.iter().any(|v| *v > 6)
        || rule.count == Some(0)
        || rule.count.is_some_and(|v| v > 10000)
    {
        return Err("E:recurrence_count_weekday".into());
    }
    let first = date(&local_date(&event.time)?)?;
    let until = rule.until.as_deref().map(date).transpose()?;
    if until.is_some_and(|day| day < first) {
        return Err("E:recurrence_until".into());
    }
    for excluded in &rule.excluded_dates {
        date(excluded)?;
    }
    let mut result = vec![];
    let mut count = 0;
    // 最多展开 100 年，查询跨度由 command 限定为 366 天。
    for offset in 0..=36600 {
        let day = first + Duration::days(offset);
        if until.is_some_and(|end| day > end) {
            break;
        }
        let months = (day.year() - first.year()) * 12 + day.month() as i32 - first.month() as i32;
        let eligible = match rule.frequency.as_str() {
            "daily" => offset % i64::from(rule.interval) == 0,
            "weekly" => {
                let week = (offset + i64::from(first.weekday().num_days_from_monday())) / 7;
                week % i64::from(rule.interval) == 0
                    && if rule.weekdays.is_empty() {
                        day.weekday() == first.weekday()
                    } else {
                        rule.weekdays
                            .contains(&day.weekday().num_days_from_monday())
                    }
            }
            _ => months % rule.interval as i32 == 0 && day.day() == first.day(),
        };
        if !eligible {
            continue;
        }
        count += 1;
        if rule.count.is_some_and(|limit| count > limit) {
            break;
        }
        let Ok(time) = on_date(&event.time, day) else {
            continue;
        };
        let (start, end) = bounds(&time)?;
        if start >= to {
            break;
        }
        if end <= from || rule.excluded_dates.contains(&day.to_string()) {
            continue;
        }
        let mut instance = event.clone();
        instance.id = format!("{}@{}", event.id, day);
        instance.series_id = Some(event.id.clone());
        instance.original_date = Some(day.to_string());
        instance.time = time;
        result.push(instance);
        if result.len() >= limit {
            break;
        }
    }
    Ok(result)
}
