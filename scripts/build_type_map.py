#!/usr/bin/env python3
"""Build type-name -> file-path mapping from src/*.rs pub type/enum/struct defs.

Usage:
    python3 scripts/build_type_map.py [--src <src dir>] [--out <type_map.json>]
"""
import os, re, json, argparse

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
DEFAULT_SRC = os.path.join(REPO, "crates/agent-gui/src-tauri/src")
DEFAULT_OUT = os.path.join(REPO, "crates/agent-gui/src-tauri/target/gen-meta/type_map.json")

ap = argparse.ArgumentParser()
ap.add_argument("--src", default=DEFAULT_SRC, help="src directory")
ap.add_argument("--out", default=DEFAULT_OUT, help="output type_map.json path")
args = ap.parse_args()

SRC = args.src
mapping = {}
for dirpath, _dn, filenames in os.walk(SRC):
    for fn in filenames:
        if not fn.endswith('.rs'):
            continue
        p = os.path.join(dirpath, fn)
        with open(p) as f:
            content = f.read()
        for m in re.finditer(r'^pub(?:\(crate\))? (struct|enum|type)\s+([A-Za-z0-9_]+)', content, re.M):
            name = m.group(2)
            rel = os.path.relpath(p, SRC).replace(os.sep, '/')
            if name in mapping and mapping[name] != rel:
                print(f"DUP: {name}: {mapping[name]} vs {rel}")
            mapping[name] = rel
os.makedirs(os.path.dirname(args.out), exist_ok=True)
json.dump(mapping, open(args.out, 'w'), indent=1)
print(f"total types mapped: {len(mapping)} -> {args.out}")
