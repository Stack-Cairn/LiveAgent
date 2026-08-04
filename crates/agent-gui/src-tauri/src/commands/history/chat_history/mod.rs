use chrono::{Local, LocalResult, NaiveDate, TimeZone};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use agent_core::events::EventBus;

use crate::{
    commands::{history_db, subagent_store},
    services::memory::{MemoryHistorySearchMatch, MemorySearchArgs},
};
use uuid::Uuid;

/// 会话被创建或更新。payload 是完整的 `ChatHistorySummary`。
pub const HISTORY_UPSERT_EVENT: &str = "history:upsert";
/// 会话被删除。payload 是被删会话的 id 字符串。
pub const HISTORY_DELETE_EVENT: &str = "history:delete";

const HISTORY_SHARE_TOKEN_LEN: usize = 9;
const HISTORY_SHARE_TOKEN_INSERT_ATTEMPTS: usize = 8;
const HISTORY_SHARE_TOKEN_ALPHABET: &[u8] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CHAT_HISTORY_FTS_REFRESH_BATCH_SIZE: usize = 8;
const DEFAULT_HISTORY_SEARCH_LIMIT: usize = 6;
const MAX_HISTORY_SEARCH_LIMIT: usize = 12;
const MAX_HISTORY_LIST_LIMIT: i64 = 200;

include!("types.rs");
include!("db.rs");
include!("repository.rs");
include!("message_ref.rs");
include!("fts.rs");
include!("segments.rs");
include!("share.rs");
include!("search.rs");
include!("commands.rs");
include!("replace.rs");
include!("branch.rs");
include!("delete.rs");
include!("tests.rs");
