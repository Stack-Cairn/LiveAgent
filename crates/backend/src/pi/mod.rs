//! pi RPC 引擎接入：Node core 的替代品。
//!
//! ```text
//! POST /api/chat_send ─┐
//!                      ├→ PiSessionManager ─→ pi --mode rpc（每会话一进程）
//! POST /api/chat_abort ┘                          │ stdout JSONL
//!                                                 ↓
//! 前端 ←── WS ←── EventBus ←── translate ←── protocol
//! ```
//!
//! 分层刻意薄：
//! - `protocol` 只管线上格式，不知道会话存在
//! - `process` 只管一个子进程和它的三条泵，不知道事件的含义
//! - `translate` 只管 pi 事件 → 前端事件，不知道进程存在
//! - `live` 只是一坨状态
//! - `session` 把上面四个接起来，是唯一知道「会话」概念的地方
//!
//! 前端契约见 docs/design/pi-rpc-event-contract.md。铁律：前端零改动。

pub mod approval;
pub mod live;
pub mod models_json;
pub mod process;
pub mod protocol;
pub mod session;
pub mod translate;

pub use session::{ChatSendAccepted, ChatSendRequest, PiSessionManager};
