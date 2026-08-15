mod conversation;
mod db;
mod manager;
mod manifest;
mod package;
mod runtime;
mod types;

pub use conversation::create_prompt_plugin;
pub use manager::{
    configure, dispatch_hook, enable, grant, install, inventory, invoke_tool, plugin_api_version,
    prepare_turn, uninstall,
};
pub use types::*;

#[cfg(test)]
mod tests;
