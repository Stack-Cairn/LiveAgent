//! 应用数据目录的唯一定义。
//!
//! 目录名是**写死的字符串**,不是 `env!("CARGO_PKG_NAME")`。用户磁盘上的
//! `~/.liveagent` 是 userspace 契约:代码搬到哪个 crate、包改成什么名字,
//! 都不许让这个路径漂移。历史教训:后端从 `liveagent` 包搬进 `agent-core`
//! 时,四处复制的 `CARGO_PKG_NAME` 宏悄悄把路径变成了 `~/.agent-core`,
//! 进程"成功"打开一个空数据库,比崩溃更难查。

use std::fs;
use std::path::PathBuf;

/// 见模块注释:此名不随包名走。
const APP_DIR_NAME: &str = ".liveagent";

/// `~/.liveagent`,不存在则创建。所有持久化数据(设置库、会话历史、
/// skills、进程日志、网关镜像等)都挂在它下面。
pub fn app_storage_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let dir = home.join(APP_DIR_NAME);
    fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败：{e}"))?;
    Ok(dir)
}
