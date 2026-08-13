#!/usr/bin/env python3
"""Verify headless.rs dispatch coverage against the committed command manifest.

The command manifest (scripts/manifest/commands.json) is the source of truth
for the Tauri command surface. This script asserts that:

  1. every manifest command has a dispatch arm in src/headless.rs
  2. every dispatch arm is backed by a manifest command

This is the CI guard that catches "new command added but headless dispatch not
updated" — the historical drift failure mode of the headless build.

Usage:
    python3 scripts/verify_headless.py [--manifest scripts/manifest/commands.json] [--headless <headless.rs>]
"""
import os, re, sys, argparse, json

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
DEFAULT_MANIFEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manifest", "commands.json")
DEFAULT_HEADLESS = os.path.join(REPO, "crates/agent-gui/src-tauri/src/headless.rs")

ap = argparse.ArgumentParser()
ap.add_argument("--manifest", default=DEFAULT_MANIFEST)
ap.add_argument("--headless", default=DEFAULT_HEADLESS)
args = ap.parse_args()

cmds = json.load(open(args.manifest))

with open(args.headless) as f:
    headless = f.read()

ARM_RE = re.compile(r'^\s*"([a-z0-9_]+)"\s*=>', re.M)
arms = set(ARM_RE.findall(headless))

expected = set(c["name"] for c in cmds)

missing = sorted(expected - arms)
extra = sorted(arms - expected)

ok = True
if missing:
    print(f"MISSING dispatch arms in headless.rs ({len(missing)}):")
    for m in missing:
        print(f"  - {m}")
    ok = False
if extra:
    print(f"EXTRA dispatch arms not backed by a manifest command ({len(extra)}):")
    for e in extra:
        print(f"  - {e}")
    ok = False

print(f"manifest commands: {len(expected)}, dispatch arms: {len(arms)}")
if ok:
    print("OK: dispatch coverage matches the command manifest.")
    sys.exit(0)
sys.exit(1)
