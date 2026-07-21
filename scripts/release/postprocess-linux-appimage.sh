#!/usr/bin/env bash
set -euo pipefail

readonly APPIMAGETOOL_VERSION="1.9.1"
readonly APPIMAGETOOL_SHA256="ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"
readonly APPIMAGETOOL_URL="https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_VERSION}/appimagetool-x86_64.AppImage"

usage() {
  echo "Usage: $0 <appimage-path>" >&2
}

fail() {
  echo "postprocess-linux-appimage: $*" >&2
  exit 1
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi

for command_name in curl find grep head realpath sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done

appimage_path="$(realpath "$1")"
test -f "$appimage_path" || fail "AppImage not found: $appimage_path"
test -x "$appimage_path" || fail "AppImage is not executable: $appimage_path"

appimage_dir="$(dirname "$appimage_path")"
work_dir="$(mktemp -d "$appimage_dir/.liveagent-appimage.XXXXXX")"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

extract_dir="$work_dir/extract"
mkdir -p "$extract_dir"
(
  cd "$extract_dir"
  "$appimage_path" --appimage-extract >/dev/null
)

app_dir="$extract_dir/squashfs-root"
test -x "$app_dir/AppRun" || fail "extracted AppImage is missing executable AppRun"
test -x "$app_dir/AppRun.wrapped" || fail "extracted AppImage is missing executable AppRun.wrapped"

mapfile -d '' bundled_wayland_libraries < <(
  find "$app_dir/usr/lib" \( -type f -o -type l \) \
    -name 'libwayland-*.so*' -print0
)
if [ "${#bundled_wayland_libraries[@]}" -eq 0 ]; then
  fail "no bundled libwayland libraries found; refusing to rewrite an unexpected AppImage"
fi

echo "Removing bundled Wayland libraries:"
for library_path in "${bundled_wayland_libraries[@]}"; do
  echo "  ${library_path#"$app_dir"/}"
done
rm -f -- "${bundled_wayland_libraries[@]}"

if find "$app_dir/usr/lib" \( -type f -o -type l \) \
  -name 'libwayland-*.so*' -print -quit | grep -q .; then
  fail "bundled libwayland libraries remain after cleanup"
fi

runtime_offset="$("$appimage_path" --appimage-offset)"
case "$runtime_offset" in
  ''|*[!0-9]*) fail "invalid AppImage runtime offset: $runtime_offset" ;;
esac
if [ "$runtime_offset" -le 0 ]; then
  fail "invalid AppImage runtime offset: $runtime_offset"
fi
runtime_path="$work_dir/runtime-x86_64"
head -c "$runtime_offset" "$appimage_path" > "$runtime_path"

if [ -n "${APPIMAGETOOL_PATH:-}" ]; then
  appimagetool_path="$(realpath "$APPIMAGETOOL_PATH")"
  test -x "$appimagetool_path" || fail "APPIMAGETOOL_PATH is not executable: $appimagetool_path"
else
  appimagetool_path="$work_dir/appimagetool-x86_64.AppImage"
  curl --fail --location --retry 3 --silent --show-error \
    --output "$appimagetool_path" "$APPIMAGETOOL_URL"
  echo "$APPIMAGETOOL_SHA256  $appimagetool_path" | sha256sum --check --status || \
    fail "appimagetool checksum verification failed"
  chmod +x "$appimagetool_path"
fi

repacked_path="$work_dir/repacked.AppImage"
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$appimagetool_path" \
  --no-appstream \
  --runtime-file "$runtime_path" \
  "$app_dir" "$repacked_path"
test -s "$repacked_path" || fail "appimagetool did not produce an AppImage"
chmod --reference="$appimage_path" "$repacked_path"

verify_dir="$work_dir/verify"
mkdir -p "$verify_dir"
(
  cd "$verify_dir"
  "$repacked_path" --appimage-extract >/dev/null
)
verified_app_dir="$verify_dir/squashfs-root"
test -x "$verified_app_dir/AppRun" || fail "repacked AppImage is missing executable AppRun"
test -x "$verified_app_dir/AppRun.wrapped" || fail "repacked AppImage is missing executable AppRun.wrapped"
if find "$verified_app_dir/usr/lib" \( -type f -o -type l \) \
  -name 'libwayland-*.so*' -print -quit | grep -q .; then
  fail "repacked AppImage still contains bundled libwayland libraries"
fi

mv -f -- "$repacked_path" "$appimage_path"
rm -f -- "$appimage_path.sig"
echo "Repacked AppImage without bundled Wayland libraries: $appimage_path"
