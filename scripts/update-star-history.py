#!/usr/bin/env python3

import html
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


WIDTH = 800
HEIGHT = 533
PLOT_LEFT = 70
PLOT_RIGHT = 770
PLOT_TOP = 50
PLOT_BOTTOM = 425
X_TICKS = 7


def flatten_pages(payload):
    if isinstance(payload, list) and payload and all(isinstance(page, list) for page in payload):
        return [entry for page in payload for entry in page]
    return payload if isinstance(payload, list) else []


def parse_entries(payload):
    entries = []
    for item in flatten_pages(payload):
        starred_at = item.get("starred_at") if isinstance(item, dict) else None
        if not starred_at:
            continue
        timestamp = datetime.fromisoformat(starred_at.replace("Z", "+00:00")).astimezone(timezone.utc)
        entries.append(timestamp)
    entries.sort()
    return entries


def nice_step(value):
    exponent = math.floor(math.log10(max(value, 1)))
    scale = 10**exponent
    normalized = value / scale
    if normalized <= 1:
        factor = 1
    elif normalized <= 2:
        factor = 2
    elif normalized <= 5:
        factor = 5
    else:
        factor = 10
    return factor * scale


def render_chart(entries, dark):
    foreground = "#f0f6fc" if dark else "#000"
    background = "#0d1117" if dark else "#fff"
    line_color = "#ff7b72" if dark else "#dd4528"
    count = len(entries)
    first_time = entries[0]
    current_day = datetime.now(timezone.utc).date()
    end_time = datetime.combine(current_day + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc)
    end_time = max(end_time, first_time + timedelta(days=1))
    step = nice_step(count / 5)
    y_max = max(step, math.ceil(count / step) * step)
    plot_width = PLOT_RIGHT - PLOT_LEFT
    plot_height = PLOT_BOTTOM - PLOT_TOP
    duration = (end_time - first_time).total_seconds()

    def x_position(timestamp):
        ratio = (timestamp - first_time).total_seconds() / duration
        return PLOT_LEFT + max(0, min(1, ratio)) * plot_width

    def y_position(star_count):
        return PLOT_BOTTOM - star_count / y_max * plot_height

    path_points = [(x_position(first_time), y_position(0))]
    path_points.extend((x_position(timestamp), y_position(index)) for index, timestamp in enumerate(entries, 1))
    path_data = " ".join(
        f"{'M' if index == 0 else 'L'}{point_x:.2f} {point_y:.2f}"
        for index, (point_x, point_y) in enumerate(path_points)
    )

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}" role="img" aria-label="Star History" data-star-count="{count}" style="background:{background};font-family:Arial,sans-serif">',
        f'<rect width="{WIDTH}" height="{HEIGHT}" fill="{background}"/>',
        f'<text x="50%" y="30" fill="{foreground}" font-size="20" font-weight="700" text-anchor="middle">Star History</text>',
        f'<path d="M{PLOT_LEFT} {PLOT_BOTTOM}H{PLOT_RIGHT}M{PLOT_LEFT} {PLOT_BOTTOM}V{PLOT_TOP}" fill="none" stroke="{foreground}" stroke-width="2"/>',
        f'<path d="{path_data}" fill="none" stroke="{line_color}" stroke-width="2.5"/>',
    ]

    for tick in range(0, y_max + 1, int(step)):
        y = y_position(tick)
        parts.append(f'<text x="{PLOT_LEFT - 8}" y="{y + 5:.2f}" fill="{foreground}" font-size="16" text-anchor="end">{tick}</text>')

    for index in range(X_TICKS):
        ratio = index / (X_TICKS - 1)
        timestamp = first_time + (end_time - first_time) * ratio
        x = x_position(timestamp)
        label = html.escape(timestamp.strftime("%b %d"))
        parts.append(f'<text x="{x:.2f}" y="{PLOT_BOTTOM + 25}" fill="{foreground}" font-size="16" text-anchor="middle">{label}</text>')

    legend_x = PLOT_LEFT + 8
    legend_y = PLOT_TOP + 8
    parts.extend(
        [
            f'<rect x="{legend_x}" y="{legend_y}" width="188" height="32" rx="5" fill="{background}" fill-opacity="0.9" stroke="{foreground}" stroke-width="2"/>',
            f'<rect x="{legend_x + 7}" y="{legend_y + 12}" width="8" height="8" rx="2" fill="{line_color}"/>',
            f'<text x="{legend_x + 21}" y="{legend_y + 25}" fill="{foreground}" font-size="15">stack-cairn/liveagent</text>',
            f'<text x="50%" y="{HEIGHT - 10}" fill="{foreground}" font-size="17" text-anchor="middle">Date</text>',
            f'<text x="20" y="{(PLOT_TOP + PLOT_BOTTOM) / 2:.2f}" fill="{foreground}" font-size="17" text-anchor="middle" transform="rotate(-90 20 {(PLOT_TOP + PLOT_BOTTOM) / 2:.2f})">GitHub Stars</text>',
            "</svg>",
        ]
    )
    return "".join(parts)


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: update-star-history.py STARGAZERS_JSON LIGHT_SVG DARK_SVG")
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    entries = parse_entries(payload)
    if not entries:
        raise SystemExit("stargazer response contained no starred_at timestamps")
    for output_path, dark in ((sys.argv[2], False), (sys.argv[3], True)):
        destination = Path(output_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(render_chart(entries, dark), encoding="utf-8")


if __name__ == "__main__":
    main()
