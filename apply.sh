#!/usr/bin/env bash
# omp-hanhua — omp 简体中文汉化补丁 (macOS / Linux)
# 用法: ./apply.sh [--force] [--bun-global <path>] [--launcher-dir <path>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH="$SCRIPT_DIR/hanhua.patch"
FORCE=0
BUN_GLOBAL=""
LAUNCHER_DIR=""

while [[ $# -gt 0 ]]; do
	case "$1" in
	--force) FORCE=1 ;;
	--bun-global) BUN_GLOBAL="$2"; shift ;;
	--launcher-dir) LAUNCHER_DIR="$2"; shift ;;
	*) echo "[omp-hanhua] unknown option: $1" >&2; exit 1 ;;
	esac
	shift
done

# ---------- 定位 bun 全局 node_modules ----------
find_bun_global() {
	if [[ -n "$BUN_GLOBAL" ]]; then echo "$BUN_GLOBAL"; return; fi
	if command -v bun >/dev/null 2>&1; then
		local bin_dir bun_root candidate
		bin_dir="$(bun pm bin -g 2>/dev/null | tail -n 1 | tr -d '[:space:]')"
		if [[ -n "$bin_dir" ]]; then
			bun_root="$(dirname "$bin_dir")"
			candidate="$bun_root/install/global/node_modules"
			if [[ -d "$candidate" ]]; then echo "$candidate"; return; fi
		fi
	fi
	local home="${HOME:-}"
	if [[ -d "$home/.bun/install/global/node_modules" ]]; then echo "$home/.bun/install/global/node_modules"; return; fi
	echo ""
}

GLOBAL_MODULES="$(find_bun_global)"
if [[ -z "$GLOBAL_MODULES" || ! -d "$GLOBAL_MODULES" ]]; then
	echo "[omp-hanhua] ERROR: 找不到 bun 全局 node_modules。请确认已安装 bun,或用 --bun-global 指定路径。" >&2
	exit 1
fi

SRC="$GLOBAL_MODULES/@oh-my-pi/pi-coding-agent"
DST="$GLOBAL_MODULES/@oh-my-pi/pi-coding-agent-zh"

if [[ ! -f "$SRC/package.json" ]]; then
	echo "[omp-hanhua] ERROR: 未找到 omp 源码包: $SRC" >&2
	echo "[omp-hanhua] 请先安装: bun add -g @oh-my-pi/pi-coding-agent" >&2
	exit 1
fi
if [[ ! -f "$PATCH" ]]; then
	echo "[omp-hanhua] ERROR: 未找到补丁文件: $PATCH" >&2
	exit 1
fi

# ---------- 版本检测 ----------
VERSION_FILE="$HOME/.omp-hanhua-version"
SRC_VER="$(python3 -c "import json,sys;print(json.load(open('$SRC/package.json'))['version'])" 2>/dev/null || \
           node -e "console.log(require('$SRC/package.json').version)" 2>/dev/null || \
           grep -o '"version": *"[^"]*"' "$SRC/package.json" | head -1 | sed 's/.*"\(.*\)"/\1/')"
PATCHED_VER=""
if [[ -f "$VERSION_FILE" ]]; then PATCHED_VER="$(cat "$VERSION_FILE")"; fi

if [[ "$FORCE" -ne 1 && -f "$DST/package.json" && "$SRC_VER" == "$PATCHED_VER" ]]; then
	echo "[omp-hanhua] 汉化副本已是最新 (v$SRC_VER),无需重打。"
	exit 0
fi

echo "[omp-hanhua] 正在重建汉化副本 ..."
rm -rf "$DST"
cp -R "$SRC" "$DST"

echo "[omp-hanhua] 正在应用补丁 ..."
(cd "$DST" && git -c core.autocrlf=false apply --ignore-whitespace -p2 "$PATCH" 2>/dev/null) || \
(cd "$DST" && patch -p2 -i "$PATCH" 2>/dev/null) || {
	echo "[omp-hanhua] ERROR: 补丁应用失败。可能 omp 已升级导致文案变更,请检查兼容性。原包未受影响。" >&2
	exit 1
}

printf '%s' "$SRC_VER" > "$VERSION_FILE"

# ---------- 安装启动器 ----------
CLI_PATH="$DST/src/cli.ts"
if [[ -z "$LAUNCHER_DIR" ]]; then LAUNCHER_DIR="$HOME/.local/bin"; fi
mkdir -p "$LAUNCHER_DIR"
LAUNCHER="$LAUNCHER_DIR/omp"
printf '#!/usr/bin/env bash\nexec bun "%s" "$@"\n' "$CLI_PATH" > "$LAUNCHER"
chmod +x "$LAUNCHER"

echo "[omp-hanhua] 完成!汉化版 omp 已就绪 (v$SRC_VER)。"
echo "[omp-hanhua] 启动器: $LAUNCHER"
if [[ ":$PATH:" != *":$LAUNCHER_DIR:"* ]]; then
	echo "[omp-hanhua] 警告: $LAUNCHER_DIR 不在 PATH 中,或排在 bun bin 之后。"
	echo "[omp-hanhua] 请将其加入 PATH 并确保排在 bun bin 之前,或直接用: bun \"$CLI_PATH\""
else
	echo "[omp-hanhua] 现在直接运行 omp 即为汉化版。"
fi
exit 0
