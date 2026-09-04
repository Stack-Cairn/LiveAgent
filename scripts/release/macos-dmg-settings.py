"""Deterministic Finder layout for the LiveAgent release DMG.

Unlike Finder/AppleScript-based DMG builders, dmgbuild writes the Finder
metadata directly. This keeps the release layout stable on hosted CI runners.
"""

import os


def required_path(name):
    value = defines.get(name)  # noqa: F821 - provided by dmgbuild
    if not value:
        raise RuntimeError(f"missing required dmgbuild define: {name}")

    path = os.path.abspath(value)
    if not os.path.exists(path):
        raise RuntimeError(f"dmgbuild path does not exist: {path}")
    return path


application = required_path("app")
app_name = os.path.basename(application)

format = "UDZO"
filesystem = "HFS+"

files = [application]
symlinks = {"Applications": "/Applications"}

icon = required_path("volume_icon")
background = required_path("background")

window_rect = ((100, 100), (660, 400))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False
include_icon_view_settings = True
include_list_view_settings = False

arrange_by = None
grid_offset = (0, 0)
grid_spacing = 100
scroll_position = (0, 0)
label_pos = "bottom"
text_size = 16
icon_size = 128
icon_locations = {
    app_name: (180, 210),
    "Applications": (480, 210),
}
