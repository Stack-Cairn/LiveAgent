#!/usr/bin/env bash
# 门禁：src-tauri 里注册的每一条 Tauri command 都必须在
# docs/architecture/command-classes/{backend,frontend,deleted}.txt 里有归类。
#
# 方向是单向的：注册集 ⊆ 归类集。
# 反向不检查——deleted.txt 里的命令本来就已经从 lib.rs 删掉了，
# 迁移越往后走，归类集比注册集大得越多，这是预期。
#
# 阶段 1 清点时踩过两个坑，这里都堵上了：
#   1. generate_handler![…] 块以不带分号的 `]` 结尾，按 `];` 找会一路扫到文件尾；
#   2. 注册项不全在 commands:: 命名空间下（还有 tauri_commands::、services::）。
# 所以块边界靠 awk 状态机定位，路径前缀不做假设；块内任何一行解析不了就直接失败，
# 绝不静默跳过——静默跳过正是坑 2 当初漏计的方式。

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lib_rs="$repo_root/crates/agent-gui/src-tauri/src/lib.rs"
class_dir="$repo_root/docs/architecture/command-classes"

for f in "$lib_rs" "$class_dir/backend.txt" "$class_dir/frontend.txt" "$class_dir/deleted.txt"; do
	if [ ! -f "$f" ]; then
		echo "缺少文件：$f" >&2
		exit 1
	fi
done

block="$(awk '
	/tauri::generate_handler!\[/ { inside = 1; next }
	inside && /^        \]/       { exit }
	inside                        { print }
' "$lib_rs")"

if [ -z "$block" ]; then
	echo "在 $lib_rs 里没找到 tauri::generate_handler![…] 块" >&2
	exit 1
fi

# 先剔掉注释与空行，剩下的必须全部是 `    a::b::c,` 形状。
entries="$(printf '%s\n' "$block" | grep -Ev '^[[:space:]]*(//|$)' || true)"

unparsed="$(printf '%s\n' "$entries" | grep -Ev '^[[:space:]]+[a-z_0-9]+::[a-z_0-9]+::[a-z_0-9]+,$' || true)"
if [ -n "$unparsed" ]; then
	echo "generate_handler! 块里有无法解析的行（改了注册写法就同步改本脚本）：" >&2
	printf '%s\n' "$unparsed" >&2
	exit 1
fi

registered="$(printf '%s\n' "$entries" | sed -E 's/^[[:space:]]+[a-z_0-9]+::[a-z_0-9]+::([a-z_0-9]+),$/\1/' | sort)"

dupes="$(printf '%s\n' "$registered" | uniq -d)"
if [ -n "$dupes" ]; then
	echo "同一条 command 注册了多次：" >&2
	printf '%s\n' "$dupes" >&2
	exit 1
fi

classified="$(cat "$class_dir/backend.txt" "$class_dir/frontend.txt" "$class_dir/deleted.txt" | grep -Ev '^[[:space:]]*$' | sort -u)"

ghosts="$(comm -23 <(printf '%s\n' "$registered") <(printf '%s\n' "$classified"))"
if [ -n "$ghosts" ]; then
	echo "以下 command 已注册但没有归类，请写进 backend.txt / frontend.txt / deleted.txt：" >&2
	printf '  %s\n' $ghosts >&2
	exit 1
fi

echo "command 分类完整：已注册 $(printf '%s\n' "$registered" | wc -l | tr -d ' ') 条，全部有归类"
