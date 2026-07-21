#!/usr/bin/env python3

import base64
import hashlib
import html
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

AVATAR_SIZE = 64
AVATAR_FETCH_SIZE = 128
GAP = 6
COLUMNS = 12
MAX_CONTRIBUTORS = 100
FETCH_TIMEOUT = 10
FETCH_ATTEMPTS = 3
FALLBACK_COLORS = ("#f97316", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#eab308", "#ef4444")


def flatten_pages(payload):
    if isinstance(payload, list) and payload and all(isinstance(page, list) for page in payload):
        return [entry for page in payload for entry in page]
    return payload if isinstance(payload, list) else []


def parse_contributors(payload):
    contributors = []
    for item in flatten_pages(payload):
        if not isinstance(item, dict):
            continue
        login = item.get("login")
        if not login or item.get("type") == "Bot" or login.endswith("[bot]"):
            continue
        contributors.append(
            {
                "login": login,
                "avatar_url": item.get("avatar_url") or "",
                "contributions": item.get("contributions", 0),
            }
        )
    contributors.sort(key=lambda entry: (-entry["contributions"], entry["login"].lower()))
    return contributors[:MAX_CONTRIBUTORS]


def fetch_avatar(avatar_url):
    if not avatar_url:
        return None
    separator = "&" if "?" in avatar_url else "?"
    url = f"{avatar_url}{separator}s={AVATAR_FETCH_SIZE}"
    request = urllib.request.Request(url, headers={"User-Agent": "liveagent-contributors-chart"})
    for attempt in range(FETCH_ATTEMPTS):
        try:
            with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:
                content_type = response.headers.get("Content-Type", "image/png").split(";")[0].strip()
                return f"data:{content_type};base64,{base64.b64encode(response.read()).decode('ascii')}"
        except (urllib.error.URLError, OSError):
            if attempt == FETCH_ATTEMPTS - 1:
                return None
    return None


def render_fallback(login):
    color = FALLBACK_COLORS[int(hashlib.sha256(login.encode("utf-8")).hexdigest(), 16) % len(FALLBACK_COLORS)]
    half = AVATAR_SIZE / 2
    initial = html.escape(login[0].upper())
    return (
        f'<circle cx="{half}" cy="{half}" r="{half}" fill="{color}"/>'
        f'<text x="{half}" y="{half + 9}" fill="#fff" font-size="26" font-weight="700" text-anchor="middle">{initial}</text>'
    )


def render_chart(contributors):
    count = len(contributors)
    columns = min(COLUMNS, max(count, 1))
    rows = (count + columns - 1) // columns
    width = columns * AVATAR_SIZE + (columns + 1) * GAP
    height = rows * AVATAR_SIZE + (rows + 1) * GAP
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" '
        f'role="img" aria-label="Contributors" data-contributor-count="{count}" font-family="Arial,sans-serif">',
        f'<defs><clipPath id="clip"><circle cx="{AVATAR_SIZE / 2}" cy="{AVATAR_SIZE / 2}" r="{AVATAR_SIZE / 2}"/></clipPath></defs>',
    ]
    for index, contributor in enumerate(contributors):
        x = GAP + (index % columns) * (AVATAR_SIZE + GAP)
        y = GAP + (index // columns) * (AVATAR_SIZE + GAP)
        login = html.escape(contributor["login"])
        avatar = fetch_avatar(contributor["avatar_url"])
        if avatar:
            body = f'<image href="{avatar}" width="{AVATAR_SIZE}" height="{AVATAR_SIZE}" clip-path="url(#clip)"/>'
        else:
            body = render_fallback(contributor["login"])
        parts.append(f'<g transform="translate({x} {y})"><title>{login}</title>{body}</g>')
    parts.append("</svg>")
    return "".join(parts)


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: update-contributors.py CONTRIBUTORS_JSON OUTPUT_SVG")
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    contributors = parse_contributors(payload)
    if not contributors:
        raise SystemExit("contributor response contained no usable entries")
    destination = Path(sys.argv[2])
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(render_chart(contributors), encoding="utf-8")


if __name__ == "__main__":
    main()
