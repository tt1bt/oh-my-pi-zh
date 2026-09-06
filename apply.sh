#!/usr/bin/env bash
# oh-my-pi-zh — omp 简体中文汉化 (macOS / Linux 入口)
# 全部逻辑在 scripts/apply.ts，本脚本只做参数转发。
# 用法: ./apply.sh [--force] [--bun-global <path>] [--launcher-dir <path>] [--check] [--no-auto-heal]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS_ARGS=()
while [[ $# -gt 0 ]]; do
	case "$1" in
	--force | -Force) TS_ARGS+=("--force") ;;
	--bun-global | -BunGlobal) TS_ARGS+=("--bun-global" "$2"); shift ;;
	--launcher-dir | -LauncherDir) TS_ARGS+=("--launcher-dir" "$2"); shift ;;
	*) TS_ARGS+=("$1") ;;
	esac
	shift
done

exec bun "$SCRIPT_DIR/scripts/apply.ts" "${TS_ARGS[@]}"
