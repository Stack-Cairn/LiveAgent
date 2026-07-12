//! Skills 服务模块（拆分自原单文件 skills.rs，代码逐字迁移，行为不变）。
//!
//! - [`types`]：对外 `System*` 响应 DTO 与内部数据类型
//! - [`util`]：临时目录、时间戳与 payload 字段工具
//! - [`paths`]：skills 根目录解析、路径回显与路径 / 名称清洗
//! - [`metadata`]：frontmatter / skill.json 元数据解析与元数据文件定位
//! - [`library`]：已安装 Skill 库（发现 / 列表 / 读取 / 删除 / 打包 / `_meta.json`）
//! - [`sources`]：安装源准备（GitHub / HTTP / 本地 / 压缩包）、下载与安全解压
//! - [`install`]：备份、带冲突策略的复制与 install payload 编排
//! - [`jobs`]：后台安装任务注册表与 install_start 工作线程
//! - [`clawhub`]：ClawHub 注册表搜索与安装
//! - [`create`]：SKILL.md 模板渲染与 create 编排
//! - [`validate`]：Skill 目录校验
//! - [`builtin`]：内置 Agent Skill 定义、修改保护与种子写入
//! - [`manager`]：`system_manage_skill_sync` 动作分发入口

mod builtin;
mod clawhub;
mod create;
mod external;
mod install;
mod jobs;
mod library;
mod manager;
mod metadata;
mod paths;
mod sources;
#[cfg(test)]
mod tests;
mod types;
mod util;
mod validate;

pub use builtin::ensure_builtin_agent_skills_sync;
pub(crate) use builtin::*;
pub(crate) use clawhub::*;
pub(crate) use create::*;
pub(crate) use external::*;
pub(crate) use install::*;
pub(crate) use jobs::*;
pub use library::{
    system_list_skill_files_sync, system_read_skill_metadata_sync, system_read_skill_text_sync,
};
pub(crate) use library::*;
pub use manager::system_manage_skill_sync;
pub(crate) use metadata::*;
pub use paths::skills_root_dir;
pub(crate) use paths::*;
pub(crate) use sources::*;
pub use types::*;
pub(crate) use util::*;
pub(crate) use validate::*;

/// 跨子模块共享的 Skill 限制常量。
pub(crate) const MAX_SKILL_DESCRIPTION_LENGTH: usize = 1024;
pub(crate) const MAX_SKILL_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// Skills 根目录的进程级写锁。
///
/// 四路写者（agent 同步调用、gateway 转发、UI 后台安装线程、内置 Skill 种子）
/// 共享同一目录树；所有对活动目标目录的变更（swap/删除/打包/种子写入）都必须
/// 持有本锁。下载与暂存构建不持锁——只有毫秒级的落位段在锁内。
static SKILLS_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn skills_write_guard() -> std::sync::MutexGuard<'static, ()> {
    SKILLS_WRITE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
