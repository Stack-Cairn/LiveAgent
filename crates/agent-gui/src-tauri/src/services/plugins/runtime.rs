use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use wait_timeout::ChildExt;
use wasmtime::{Config, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::p1::{self, WasiP1Ctx};
use wasmtime_wasi::p2::pipe::{MemoryInputPipe, MemoryOutputPipe};
use wasmtime_wasi::{I32Exit, WasiCtxBuilder};

use crate::runtime::platform::resolve_program_path_with_current_dir;
use crate::runtime::process::{configure_child_process_group, kill_child_process_tree_best_effort};

use super::manifest::resolve_package_file;
use super::types::{
    PluginInvocationRequest, PluginInvocationResult, PluginRuntime, PluginRuntimeKind,
};

const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_STDOUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 256 * 1024;
const MAX_WASM_MEMORY_BYTES: usize = 64 * 1024 * 1024;
const MAX_WASM_TABLE_ELEMENTS: usize = 100_000;
/// 全局 epoch 心跳周期。单个后台线程按此节拍推进 epoch，Store 用
/// `timeout_ms / EPOCH_TICK_MS` 个 tick 作为相对截止点，因此超时精度为一个 tick。
const EPOCH_TICK_MS: u64 = 50;
/// 编译产物缓存上限。插件包按内容寻址且安装后不可变，路径即缓存键；
/// 超过上限直接整表清空，避免维护 LRU 的额外状态。
const MAX_CACHED_MODULES: usize = 8;

struct WasiPluginStore {
    wasi: WasiP1Ctx,
    limits: StoreLimits,
}

/// 进程级共享 Engine。Engine 创建与 Cranelift 编译都很贵，而每次调用重新创建
/// 会让一次工具调用平白多出一整轮模块编译。共享后必须改用 epoch 心跳做超时：
/// `increment_epoch` 作用于整个 Engine，逐次调用自增会误伤并发中的其他实例。
fn wasm_engine() -> Result<&'static Engine, String> {
    static ENGINE: OnceLock<Result<Engine, String>> = OnceLock::new();
    ENGINE
        .get_or_init(|| {
            let mut config = Config::new();
            config.consume_fuel(true);
            config.epoch_interruption(true);
            let engine =
                Engine::new(&config).map_err(|error| format!("创建 WASI 引擎失败：{error}"))?;
            let ticker = engine.clone();
            thread::Builder::new()
                .name("liveagent-plugin-epoch".to_string())
                .spawn(move || loop {
                    thread::sleep(Duration::from_millis(EPOCH_TICK_MS));
                    ticker.increment_epoch();
                })
                .map_err(|error| format!("启动 WASI epoch 心跳线程失败：{error}"))?;
            Ok(engine)
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn compiled_module(engine: &Engine, entry: &Path) -> Result<Module, String> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Module>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(cache) = cache.lock() {
        if let Some(module) = cache.get(entry) {
            return Ok(module.clone());
        }
    }
    let module =
        Module::from_file(engine, entry).map_err(|error| format!("编译 WASI 插件失败：{error}"))?;
    if let Ok(mut cache) = cache.lock() {
        if cache.len() >= MAX_CACHED_MODULES {
            cache.clear();
        }
        cache.insert(entry.to_path_buf(), module.clone());
    }
    Ok(module)
}

pub fn invoke_runtime(
    package_root: &Path,
    runtime: &PluginRuntime,
    request: &PluginInvocationRequest,
) -> Result<PluginInvocationResult, String> {
    let mut input =
        serde_json::to_vec(request).map_err(|error| format!("序列化插件调用请求失败：{error}"))?;
    if input.len() > MAX_INPUT_BYTES {
        return Err("插件调用请求超过 2 MiB 限制".to_string());
    }
    input.push(b'\n');
    let output = match runtime.kind {
        PluginRuntimeKind::WasiCommand => invoke_wasi(package_root, runtime, input)?,
        PluginRuntimeKind::Process => invoke_process(package_root, runtime, input)?,
        PluginRuntimeKind::Declarative => {
            return Err("declarative 插件没有可调用运行时".to_string());
        }
    };
    parse_invocation_output(&output)
}

fn invoke_wasi(
    package_root: &Path,
    runtime: &PluginRuntime,
    input: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let entry = runtime
        .entry
        .as_deref()
        .ok_or_else(|| "WASI 插件缺少 runtime.entry".to_string())?;
    let entry = resolve_package_file(package_root, entry)?;
    let engine = wasm_engine()?;
    let module = compiled_module(engine, &entry)?;
    let mut linker: Linker<WasiPluginStore> = Linker::new(engine);
    p1::add_to_linker_sync(&mut linker, |state| &mut state.wasi)
        .map_err(|error| format!("链接 WASI 接口失败：{error}"))?;

    let stdout = MemoryOutputPipe::new(MAX_STDOUT_BYTES);
    let stderr = MemoryOutputPipe::new(MAX_STDERR_BYTES);
    let mut builder = WasiCtxBuilder::new();
    builder
        .stdin(MemoryInputPipe::new(input))
        .stdout(stdout.clone())
        .stderr(stderr.clone())
        .arg("liveagent-plugin");
    let state = WasiPluginStore {
        wasi: builder.build_p1(),
        limits: StoreLimitsBuilder::new()
            .memory_size(MAX_WASM_MEMORY_BYTES)
            .table_elements(MAX_WASM_TABLE_ELEMENTS)
            .instances(1)
            .tables(4)
            .memories(2)
            .trap_on_grow_failure(true)
            .build(),
    };
    let mut store = Store::new(engine, state);
    store.limiter(|state| &mut state.limits);
    store
        .set_fuel(runtime.fuel)
        .map_err(|error| format!("设置 WASI fuel 失败：{error}"))?;
    store.set_epoch_deadline(runtime.timeout_ms.div_ceil(EPOCH_TICK_MS).max(1));
    store.epoch_deadline_trap();

    let result = (|| {
        let instance = linker
            .instantiate(&mut store, &module)
            .map_err(|error| format!("实例化 WASI 插件失败：{error}"))?;
        let start = instance
            .get_typed_func::<(), ()>(&mut store, "_start")
            .map_err(|error| format!("WASI 插件缺少 _start：{error}"))?;
        match start.call(&mut store, ()) {
            Ok(()) => Ok(()),
            Err(error) => {
                if error.downcast_ref::<I32Exit>().map(|exit| exit.0) == Some(0) {
                    Ok(())
                } else {
                    Err(format!("WASI 插件执行失败：{error}"))
                }
            }
        }
    })();
    if let Err(error) = result {
        let stderr = String::from_utf8_lossy(&stderr.contents())
            .trim()
            .to_string();
        return if stderr.is_empty() {
            Err(error)
        } else {
            Err(format!("{error}\n{stderr}"))
        };
    }
    Ok(stdout.contents().to_vec())
}

fn invoke_process(
    package_root: &Path,
    runtime: &PluginRuntime,
    input: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let command_name = runtime
        .command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "进程插件缺少 runtime.command".to_string())?;
    let program = resolve_program_path_with_current_dir(command_name, Some(package_root));
    let mut command = Command::new(program);
    if let Some(entry) = runtime.entry.as_deref() {
        command.arg(resolve_package_file(package_root, entry)?);
    }
    command
        .args(&runtime.args)
        .current_dir(package_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_child_process_group(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 Full Trust 插件进程失败：{error}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "插件进程 stdin 不可用".to_string())?;
    stdin
        .write_all(&input)
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("写入插件进程请求失败：{error}"))?;
    drop(stdin);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "插件进程 stdout 不可用".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "插件进程 stderr 不可用".to_string())?;
    let stdout_task = thread::spawn(move || read_limited(stdout, MAX_STDOUT_BYTES));
    let stderr_task = thread::spawn(move || read_limited(stderr, MAX_STDERR_BYTES));

    let status = child
        .wait_timeout(Duration::from_millis(runtime.timeout_ms))
        .map_err(|error| format!("等待插件进程失败：{error}"))?;
    let status = match status {
        Some(status) => status,
        None => {
            kill_child_process_tree_best_effort(&mut child);
            let _ = child.wait();
            return Err(format!("插件进程执行超过 {} ms", runtime.timeout_ms));
        }
    };
    let stdout = stdout_task
        .join()
        .map_err(|_| "读取插件 stdout 的线程异常退出".to_string())??;
    let stderr = stderr_task
        .join()
        .map_err(|_| "读取插件 stderr 的线程异常退出".to_string())??;
    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("插件进程退出状态异常：{status}")
        } else {
            format!("插件进程退出状态异常：{status}\n{stderr}")
        });
    }
    Ok(stdout)
}

fn read_limited(mut reader: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 16 * 1024];
    let mut exceeded = false;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取插件输出失败：{error}"))?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(output.len());
        if remaining > 0 {
            output.extend_from_slice(&buffer[..read.min(remaining)]);
        }
        if read > remaining {
            exceeded = true;
        }
    }
    if exceeded {
        return Err(format!("插件输出超过 {limit} 字节限制"));
    }
    Ok(output)
}

pub(super) fn parse_invocation_output(output: &[u8]) -> Result<PluginInvocationResult, String> {
    if output.is_empty() {
        return Err("插件没有返回结果".to_string());
    }
    serde_json::from_slice(output).map_err(|error| format!("插件输出协议无效：{error}"))
}
