#!/usr/bin/env python3
"""Generate src/commands/adapters.rs: tauri command adapters for all 234 business fns.

Path resolution rules:
- commands/ files map to flattened crate::commands::<re-export-name> paths
- include!() flattened dirs (settings, chat_history) -> parent module
- private `mod types;` + `pub use types::*` -> parent module
- everything else keeps its file-tree path
"""
import json, re, os, argparse

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
META = os.path.join(REPO, "crates/agent-gui/src-tauri/target/gen-meta")
ap = argparse.ArgumentParser()
ap.add_argument('--commands', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'manifest', 'commands.json'))
ap.add_argument('--types', default=os.path.join(META, 'type_map.json'))
ap.add_argument('--out', default=os.path.join(REPO, 'crates/agent-gui/src-tauri/src/commands/adapters.rs'))
args = ap.parse_args()

cmds = json.load(open(args.commands))
type_map = json.load(open(args.types))

KNOWN_PATH_PREFIX = ('tauri::', 'crate::', 'super::', 'self::', 'std::')

# ---- explicit file -> module path (commands/ flattened by re-exports) ----
FLAT_FILE = {
    'commands/app/app.rs': 'commands::app',
    'commands/app/system.rs': 'commands::system',
    'commands/app/tray.rs': 'commands::tray',
    'commands/app/update.rs': 'commands::update',
    'commands/automation/cron.rs': 'commands::cron',
    'commands/automation/hook.rs': 'commands::hook',
    'commands/history/history_db.rs': 'commands::history_db',
    'commands/history/subagent_store.rs': 'commands::subagent_store',
    'commands/integration/gateway.rs': 'commands::gateway',
    'commands/integration/mcp.rs': 'commands::mcp',
    'commands/integration/memory.rs': 'commands::memory',
    'commands/runtime/process.rs': 'commands::process',
    'commands/runtime/sftp.rs': 'commands::sftp',
    'commands/runtime/shell.rs': 'commands::shell',
    'commands/runtime/terminal.rs': 'commands::terminal',
    'commands/workspace/chat_file_links.rs': 'commands::chat_file_links',
    'commands/workspace/fs.rs': 'commands::fs',
    'commands/workspace/git.rs': 'commands::git',
    'commands/workspace/subagent_worktree.rs': 'commands::subagent_worktree',
}
# include!() flattened directories
FLAT_PREFIX = [
    ('commands/config/settings/', 'commands::settings'),
    ('commands/history/chat_history/', 'commands::chat_history'),
    ('services/memory/', 'services::memory'),
    ('runtime/terminal/', 'runtime::terminal'),
]
# private `mod types;` + `pub use types::*` -> parent module
FLAT_TYPES = {
    'services/gateway/types.rs': 'services::gateway',
    'services/skills/types.rs': 'services::skills',
    'services/automation/types.rs': 'services::automation',
    'runtime/terminal/types.rs': 'runtime::terminal',
}

def resolve_use_path(rel):
    if rel in FLAT_FILE:
        return FLAT_FILE[rel]
    if rel in FLAT_TYPES:
        return FLAT_TYPES[rel]
    for prefix, flat in FLAT_PREFIX:
        if rel.startswith(prefix):
            return flat
    # default: file-tree path (foo/mod.rs -> foo)
    if rel.endswith('/mod.rs'):
        return rel[:-7].replace('/', '::')
    return rel[:-3].replace('/', '::')

# std imports needed (non-prelude)
STD_TYPE_IMPORTS = {
    'HashMap': 'std::collections::HashMap',
    'HashSet': 'std::collections::HashSet',
    'BTreeMap': 'std::collections::BTreeMap',
    'BTreeSet': 'std::collections::BTreeSet',
    'VecDeque': 'std::collections::VecDeque',
    'BinaryHeap': 'std::collections::BinaryHeap',
    'AtomicBool': 'std::sync::atomic::AtomicBool',
    'AtomicU8': 'std::sync::atomic::AtomicU8',
    'AtomicU16': 'std::sync::atomic::AtomicU16',
    'AtomicU32': 'std::sync::atomic::AtomicU32',
    'AtomicU64': 'std::sync::atomic::AtomicU64',
    'AtomicUsize': 'std::sync::atomic::AtomicUsize',
    'PathBuf': 'std::path::PathBuf',
    'Path': 'std::path::Path',
    'Duration': 'std::time::Duration',
    'Instant': 'std::time::Instant',
    'SystemTime': 'std::time::SystemTime',
    'Mutex': 'std::sync::Mutex',
    'RwLock': 'std::sync::RwLock',
    'RwLockReadGuard': 'std::sync::RwLockReadGuard',
    'RwLockWriteGuard': 'std::sync::RwLockWriteGuard',
    'MutexGuard': 'std::sync::MutexGuard',
    'Arc': 'std::sync::Arc',
    'Cow': 'std::borrow::Cow',
}

def extract_type_names(t):
    names = []
    def split_top(s):
        parts, d, cur = [], 0, []
        for ch in s:
            if ch == '<':
                d += 1
            elif ch == '>':
                d -= 1
            if ch == ',' and d == 0:
                parts.append(''.join(cur).strip()); cur = []
            else:
                cur.append(ch)
        if cur:
            parts.append(''.join(cur).strip())
        return parts
    queue = [t.strip()]
    seen = set()
    while queue:
        expr = queue.pop(0)
        if not expr:
            continue
        expr = re.sub(r'^&(mut )?', '', expr.strip())
        if expr.startswith('fn(') or expr.startswith('impl ') or expr.startswith('dyn '):
            continue
        m = re.match(r'([A-Za-z_:][A-Za-z0-9_:]*)\s*(<.*>)?', expr, re.S)
        if not m:
            continue
        base, rest = m.group(1), m.group(2)
        if base in seen:
            pass
        seen.add(base)
        if not base.startswith(KNOWN_PATH_PREFIX):
            names.append(base)
        if rest:
            for part in split_top(rest[1:-1]):
                queue.append(part)
    return names

def normalize_type(t, module):
    t = t.strip()
    t = re.sub(r"^tauri::State<'_, (Arc<[^>]+>)>$", r"tauri::State<'_, \1>", t)
    t = re.sub(r"(?<!tauri::)State<'_, (Arc<[^>]+>)>$", r"tauri::State<'_, \1>", t)
    t = re.sub(r'(?<!tauri::)AppHandle\b', r'tauri::AppHandle', t)
    t = re.sub(r'(?<!tauri::)Window\b', r'tauri::Window', t)
    return t

def call_target(c):
    """Path of the business function to call from the adapter."""
    if c['module'] == 'proxy':
        return 'crate::services::proxy::proxy_get_server_info'
    return f"crate::commands::{c['module']}::{c['name']}"

def main():
    lines = []
    lines.append('// AUTO-GENERATED by scripts/gen_adapters.py — do not edit by hand.')
    lines.append('// Regenerate with: scripts/gen_headless.sh (see README "Headless" section).')
    lines.append('// Desktop-only thin adapters that re-attach #[tauri::command] to the')
    lines.append('// tauri-free business functions in crate::commands. Command names stay')
    lines.append('// identical to the pre-refactor ones (P1.1 PR-B).')
    lines.append('#![cfg(feature = "desktop")]')
    lines.append('')
    lines.append('use std::sync::Arc;')
    lines.append('use serde_json::Value;')
    lines.append('')

    # collect needed type imports
    needed_uses = {}
    std_needed = set()
    for c in cmds:
        for p in c['params']:
            for name in extract_type_names(p['type']):
                if name in type_map and name != 'Arc':
                    needed_uses[name] = type_map[name]
                elif name in STD_TYPE_IMPORTS and name != 'Arc':
                    std_needed.add(name)
        if c['ret']:
            for name in extract_type_names(c['ret']):
                if name in type_map and name != 'Arc':
                    needed_uses[name] = type_map[name]
                elif name in STD_TYPE_IMPORTS and name != 'Arc':
                    std_needed.add(name)

    module_imports = {}
    for name, rel in sorted(needed_uses.items()):
        modpath = resolve_use_path(rel)
        module_imports.setdefault(modpath, []).append(name)
    for modpath in sorted(module_imports):
        names = sorted(set(module_imports[modpath]))
        lines.append(f'use crate::{modpath}::{{{", ".join(names)}}};')
    if std_needed:
        lines.append('')
        for name in sorted(std_needed):
            lines.append(f'use {STD_TYPE_IMPORTS[name]};')
    lines.append('')

    from collections import OrderedDict
    by_mod = OrderedDict()
    for c in cmds:
        by_mod.setdefault(c['module'], []).append(c)

    for module, clist in by_mod.items():
        lines.append(f'// ===== {module} =====')
        for c in clist:
            fnname = c['name']
            is_async = c['is_async']
            ret = c['ret']
            attr = c['attr']
            params = c['params']
            sig_params = []
            call_args = []
            for p in params:
                nt = normalize_type(p['type'], module)
                sig_params.append(f"    {p['name']}: {nt},")
                if re.match(r'^(tauri::)?State<', p['type'].strip()):
                    call_args.append(f"{p['name']}.inner()")
                else:
                    call_args.append(p['name'])
            ret_part = f" -> {ret}" if ret else ''
            fn_kw = 'async fn' if is_async else 'fn'
            await_kw = '.await' if is_async else ''
            lines.append(f'{attr}')
            lines.append(f'pub {fn_kw} {fnname}(')
            lines.extend(sig_params)
            lines.append(f'){ret_part} {{')
            lines.append(f'    {call_target(c)}({", ".join(call_args)}){await_kw}')
            lines.append('}')
            lines.append('')
    while lines and lines[-1] == '':
        lines.pop()
    out = args.out
    with open(out, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    print(f"wrote {out}: {len(cmds)} adapters, {len(lines)} lines")

if __name__ == '__main__':
    main()
