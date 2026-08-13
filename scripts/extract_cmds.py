#!/usr/bin/env python3
"""[HISTORICAL] Extract #[tauri::command] signatures.

NOTE: After the P1.1 refactor the business fns in src/commands no longer carry
#[tauri::command] attributes, so this extractor can no longer rebuild the
command table from source. The authoritative command table is committed at
scripts/manifest/commands.json; this script is kept for reference and for
rebuilding that manifest when business fns carry the attribute again.

Outputs JSON: [{attr, file, module, name, is_async, params:[{name, type}], ret, line}]

Usage:
    python3 scripts/extract_cmds.py [--src <commands dir>] [--out <commands.json>]
"""
import os, re, json, sys, argparse

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
DEFAULT_SRC = os.path.join(REPO, "crates/agent-gui/src-tauri/src/commands")
DEFAULT_OUT = os.path.join(REPO, "crates/agent-gui/src-tauri/target/gen-meta/commands.json")

ap = argparse.ArgumentParser()
ap.add_argument("--src", default=DEFAULT_SRC, help="src/commands directory")
ap.add_argument("--out", default=DEFAULT_OUT, help="output commands.json path")
args = ap.parse_args()

ROOT = args.src
MODULE_MAP = {
    "app/app.rs": "app", "app/system.rs": "system", "app/tray.rs": "tray",
    "app/update.rs": "update",
    "automation/cron.rs": "cron", "automation/hook.rs": "hook",
    "config/settings/commands.rs": "settings",
    "config/settings/ccs_import.rs": "settings",
    "config/settings/cherry_import.rs": "settings",
    "history/chat_history/branch.rs": "chat_history",
    "history/chat_history/commands.rs": "chat_history",
    "history/chat_history/delete.rs": "chat_history",
    "history/chat_history/replace.rs": "chat_history",
    "history/history_db.rs": "history_db",
    "history/subagent_store.rs": "subagent_store",
    "integration/gateway.rs": "gateway", "integration/mcp.rs": "mcp",
    "integration/memory.rs": "memory",
    "runtime/process.rs": "process", "runtime/sftp.rs": "sftp",
    "runtime/shell.rs": "shell", "runtime/terminal.rs": "terminal",
    "workspace/chat_file_links.rs": "chat_file_links", "workspace/fs.rs": "fs",
    "workspace/git.rs": "git", "workspace/subagent_worktree.rs": "subagent_worktree",
}

ATTR_RE = re.compile(r'#\[tauri::command(\\([^)]*\\))?\]')
FN_RE = re.compile(r'pub (async )?fn ([a-z0-9_]+)\s*\(')

EXTRA = [(os.path.join(REPO, "crates/agent-gui/src-tauri/src/services/proxy.rs"), "services::proxy")]

def extract_sig(lines, fn_line):
    """Return (sig_text_from_open_paren, end_line_idx, end_pos) or None."""
    text = lines[fn_line]
    start = text.find('(')
    if start == -1:
        return None
    depth = 0
    line_idx = fn_line
    pos = start
    while True:
        if line_idx >= len(lines):
            return None
        line = lines[line_idx]
        while pos < len(line):
            ch = line[pos]
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
                if depth == 0:
                    return line_idx, pos
            pos += 1
        line_idx += 1
        pos = 0

def split_params(s):
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

def find_commands(path):
    with open(path) as f:
        lines = f.readlines()
    cmds = []
    i = 0
    while i < len(lines):
        m = ATTR_RE.search(lines[i])
        if m:
            attr = lines[i].strip()
            j = i + 1
            while j < len(lines) and (not lines[j].strip() or lines[j].strip().startswith('//')):
                j += 1
            fm = FN_RE.search(lines[j]) if j < len(lines) else None
            if not fm:
                print(f"WARN: no fn after attr at {path}:{i+1}", file=sys.stderr)
                i += 1
                continue
            is_async = bool(fm.group(1))
            name = fm.group(2)
            res = extract_sig(lines, j)
            if res is None:
                print(f"WARN: unbalanced params at {path}:{j+1} name={name}", file=sys.stderr)
                i += 1
                continue
            end_line, end_pos = res
            # params text between '(' and matching ')'
            params_text = ''
            for li in range(j, end_line + 1):
                line = lines[li]
                s = line.find('(') if li == j else 0
                e = end_pos if li == end_line else len(line)
                params_text += line[s:e]
            params_text = params_text[1:]  # drop leading '('
            # ret: read after close paren until '{'
            rest = ''
            li = end_line
            p = end_pos + 1
            while li < len(lines):
                seg = lines[li][p:] if li == end_line else lines[li]
                rest += seg
                if '{' in seg:
                    break
                li += 1
                p = 0
            ret = None
            rm = re.search(r'->\s*(.+)$', rest, re.S)
            if rm:
                ret = rm.group(1).rstrip()
                ret = ret.split('{')[0].strip().rstrip(',')
            params = []
            if params_text.strip():
                for p in split_params(params_text):
                    p = p.strip()
                    if not p:
                        continue
                    mm = re.match(r'([a-z_][a-z0-9_]*)\s*:\s*(.+)', p, re.S)
                    if mm:
                        params.append({"name": mm.group(1).strip(), "type": mm.group(2).strip()})
                    else:
                        print(f"WARN: unparsed param '{p[:80]}' in {path}:{j+1} {name}", file=sys.stderr)
            cmds.append({
                "attr": attr,
                "file": os.path.relpath(path, ROOT),
                "module": MODULE_MAP.get(os.path.relpath(path, ROOT).replace("src/", ""), "?"),
                "name": name,
                "is_async": is_async,
                "params": params,
                "ret": ret,
                "line": j + 1,
            })
            i = end_line + 1
            continue
        i += 1
    return cmds

def collect_commands(root):
    """Return the command table (list of dicts) for a given src/commands dir."""
    all_cmds = []
    for dirpath, _dn, filenames in os.walk(root):
        for fn in filenames:
            if fn.endswith(".rs"):
                p = os.path.join(dirpath, fn)
                rel = os.path.relpath(p, root)
                if rel in MODULE_MAP:
                    all_cmds.extend(find_commands(p))
    for p, _mod in EXTRA:
        if os.path.exists(p):
            cmds = find_commands(p)
            for c in cmds:
                c["module"] = "proxy"
                c["is_service"] = True
            all_cmds.extend(cmds)
    return all_cmds

def main_silent(root=None):
    return collect_commands(root or ROOT)

def main():
    all_cmds = collect_commands(ROOT)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump(all_cmds, open(args.out, "w"), indent=1)
    print(f"total: {len(all_cmds)} -> {args.out}")
    mods = {}
    for c in all_cmds:
        mods[c["module"]] = mods.get(c["module"], 0) + 1
    for m, n in sorted(mods.items()):
        print(f"  {m}: {n}")

if __name__ == "__main__":
    main()
